#!/usr/bin/env python3
"""
Ingest raw KML / KMZ / GPX route files into clean GeoJSON (routes + POIs only)
and update kmls/catalog.json.

All embedded images, photo overlays, inline <img> tags, and KML styling blocks
are stripped so only clean route geometries and POI features remain.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT_DIR = Path(__file__).resolve().parent.parent
KMLS_DIR = ROOT_DIR / "kmls"
INBOX_DIR = KMLS_DIR / "inbox"
RAW_DIR = KMLS_DIR / "raw"
NORMALIZED_DIR = KMLS_DIR / "normalized" / "geojson"
SCHEMA_PATH = KMLS_DIR / "schema.yaml"
CATALOG_PATH = KMLS_DIR / "catalog.json"

SUPPORTED_EXTS = {".kml", ".kmz", ".gpx"}
PRESERVED_FIELDS = ("sub_type", "difficulty", "season", "status", "tags", "notes")
IGNORED_DATA_KEYS = re.compile(r"(photo|image|img|pic|picture|icon|avatar|thumb|media)", re.IGNORECASE)
IMG_URL_VALUE = re.compile(r"(\.(?:jpe?g|png|gif|webp|bmp)|^data:image/)", re.IGNORECASE)


def _local_tag(tag: str) -> str:
    """Strip XML namespace prefix from an Element tag."""
    if "}" in tag:
        return tag.split("}", 1)[1]
    if ":" in tag:
        return tag.split(":", 1)[1]
    return tag


def _clean_description(raw_text: str | None) -> str:
    """Strip HTML tags, <img>, scripts, styles, and inline base64 images from descriptions."""
    if not raw_text:
        return ""
    text = html.unescape(raw_text)
    text = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<img\b[^>]*>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"data:image/[^\s\"'<>]+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</tr>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    lines = [line.strip() for line in text.splitlines()]
    cleaned = "\n".join(line for line in lines if line)
    return cleaned.strip()


def _decode_xml_bytes(raw_bytes: bytes) -> ET.Element:
    """Decode XML bytes with UTF-8/GB18030 fallback and parse ElementTree root."""
    last_err: Exception | None = None
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            text = raw_bytes.decode(encoding)
            # Replace raw XML encoding declaration if we transcoded from GBK/GB18030
            text = re.sub(
                r'^(<\?xml[^>]*encoding=["\'])[^"\']+(["\'])',
                r"\1utf-8\2",
                text,
                count=1,
                flags=re.IGNORECASE,
            )
            return ET.fromstring(text)
        except (UnicodeDecodeError, ET.ParseError) as exc:
            last_err = exc
    raise ValueError(f"Failed to decode/parse XML: {last_err}")


def _load_schema(schema_path: Path = SCHEMA_PATH) -> dict[str, Any]:
    if not schema_path.exists():
        return {"categories": {}, "poi_kinds": {}}
    with schema_path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def _infer_poi_kind(name: str, description: str, poi_kinds: dict[str, Any]) -> str:
    haystack = f"{name}\n{description}".lower()
    for kind, cfg in poi_kinds.items():
        if kind == "waypoint":
            continue
        keywords = cfg.get("keywords") or []
        for kw in keywords:
            if kw.lower() in haystack:
                return kind
    return "waypoint"


def _parse_kml_coordinates(text: str | None) -> list[list[float]]:
    """Parse KML 'lng,lat[,ele]' coordinate tuples into clean GeoJSON positions."""
    if not text:
        return []
    coords: list[list[float]] = []
    for token in text.strip().split():
        parts = token.split(",")
        if len(parts) < 2:
            continue
        try:
            lng = float(parts[0])
            lat = float(parts[1])
            ele = float(parts[2]) if len(parts) >= 3 and parts[2] != "" else None
        except ValueError:
            continue
        if not (-180.0 <= lng <= 180.0 and -90.0 <= lat <= 90.0):
            continue
        if abs(lng) < 1e-9 and abs(lat) < 1e-9:
            continue
        pos = [round(lng, 6), round(lat, 6)]
        if ele is not None and math.isfinite(ele):
            pos.append(round(ele, 2))
        if not coords or coords[-1][:2] != pos[:2]:
            coords.append(pos)
    return coords


def _parse_gx_coord_list(track_elem: ET.Element) -> list[list[float]]:
    """Parse <gx:Track> child <gx:coord> ('lng lat ele') elements."""
    coords: list[list[float]] = []
    for child in track_elem:
        if _local_tag(child.tag) != "coord" or not child.text:
            continue
        parts = child.text.strip().split()
        if len(parts) < 2:
            continue
        try:
            lng = float(parts[0])
            lat = float(parts[1])
            ele = float(parts[2]) if len(parts) >= 3 else None
        except ValueError:
            continue
        if not (-180.0 <= lng <= 180.0 and -90.0 <= lat <= 90.0):
            continue
        if abs(lng) < 1e-9 and abs(lat) < 1e-9:
            continue
        pos = [round(lng, 6), round(lat, 6)]
        if ele is not None and math.isfinite(ele):
            pos.append(round(ele, 2))
        if not coords or coords[-1][:2] != pos[:2]:
            coords.append(pos)
    return coords


def _extract_extended_data(placemark: ET.Element) -> dict[str, str]:
    """Extract non-image ExtendedData fields from a KML Placemark."""
    attrs: dict[str, str] = {}
    for elem in placemark.iter():
        tag = _local_tag(elem.tag)
        if tag in ("Data", "SimpleData"):
            key = (elem.attrib.get("name") or "").strip()
            if not key or IGNORED_DATA_KEYS.search(key):
                continue
            val_elem = elem.find(".//{*}value") if tag == "Data" else elem
            if val_elem is None and tag == "Data":
                for child in elem:
                    if _local_tag(child.tag) == "value":
                        val_elem = child
                        break
            raw_val = val_elem.text if val_elem is not None else elem.text
            cleaned = _clean_description(raw_val)
            if cleaned and not IMG_URL_VALUE.search(cleaned):
                attrs[key] = cleaned
    return attrs


def _extract_kml_features(
    root: ET.Element,
    route_id: str,
    category: str,
    poi_kinds: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Extract route LineStrings and POI Points from a KML root element."""
    routes: list[dict[str, Any]] = []
    pois: list[dict[str, Any]] = []
    seg_idx = 0

    for elem in root.iter():
        if _local_tag(elem.tag) != "Placemark":
            continue

        name = ""
        description = ""
        for child in elem:
            ctag = _local_tag(child.tag)
            if ctag == "name" and child.text:
                name = child.text.strip()
            elif ctag == "description" and child.text:
                description = _clean_description(child.text)

        extra = _extract_extended_data(elem)

        for geom in elem.iter():
            gtag = _local_tag(geom.tag)
            if gtag == "Point":
                coord_elem = next((c for c in geom if _local_tag(c.tag) == "coordinates"), None)
                pts = _parse_kml_coordinates(coord_elem.text if coord_elem is not None else "")
                if not pts:
                    continue
                pos = pts[0]
                poi_name = name or "未命名路点"
                props: dict[str, Any] = {
                    "feature_type": "poi",
                    "route_id": route_id,
                    "category": category,
                    "name": poi_name,
                    "poi_kind": _infer_poi_kind(poi_name, description, poi_kinds),
                }
                if description:
                    props["description"] = description
                if len(pos) >= 3:
                    props["ele"] = pos[2]
                if extra:
                    props["attributes"] = extra
                pois.append(
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": pos},
                        "properties": props,
                    }
                )

            elif gtag == "LineString":
                coord_elem = next((c for c in geom if _local_tag(c.tag) == "coordinates"), None)
                line = _parse_kml_coordinates(coord_elem.text if coord_elem is not None else "")
                if len(line) >= 2:
                    seg_idx += 1
                    props = {
                        "feature_type": "route",
                        "route_id": route_id,
                        "category": category,
                        "segment_index": seg_idx,
                        "name": name or f"轨迹段 {seg_idx}",
                    }
                    if description:
                        props["description"] = description
                    routes.append(
                        {
                            "type": "Feature",
                            "geometry": {"type": "LineString", "coordinates": line},
                            "properties": props,
                        }
                    )

            elif gtag == "Track":
                line = _parse_gx_coord_list(geom)
                if len(line) >= 2:
                    seg_idx += 1
                    props = {
                        "feature_type": "route",
                        "route_id": route_id,
                        "category": category,
                        "segment_index": seg_idx,
                        "name": name or f"轨迹段 {seg_idx}",
                    }
                    if description:
                        props["description"] = description
                    routes.append(
                        {
                            "type": "Feature",
                            "geometry": {"type": "LineString", "coordinates": line},
                            "properties": props,
                        }
                    )

    return routes, pois


def _extract_gpx_point(pt_elem: ET.Element) -> list[float] | None:
    try:
        lat = float(pt_elem.attrib["lat"])
        lng = float(pt_elem.attrib["lon"])
    except (KeyError, ValueError):
        return None
    if not (-180.0 <= lng <= 180.0 and -90.0 <= lat <= 90.0):
        return None
    pos = [round(lng, 6), round(lat, 6)]
    for child in pt_elem:
        if _local_tag(child.tag) == "ele" and child.text:
            try:
                ele = float(child.text.strip())
                if math.isfinite(ele):
                    pos.append(round(ele, 2))
            except ValueError:
                pass
            break
    return pos


def _extract_gpx_features(
    root: ET.Element,
    route_id: str,
    category: str,
    poi_kinds: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Extract route LineStrings and waypoint POIs from a GPX root element."""
    routes: list[dict[str, Any]] = []
    pois: list[dict[str, Any]] = []
    seg_idx = 0

    for elem in root:
        tag = _local_tag(elem.tag)
        if tag == "wpt":
            pos = _extract_gpx_point(elem)
            if not pos:
                continue
            name = ""
            desc = ""
            for child in elem:
                ctag = _local_tag(child.tag)
                if ctag == "name" and child.text:
                    name = child.text.strip()
                elif ctag in ("desc", "cmt") and child.text and not desc:
                    desc = _clean_description(child.text)
            poi_name = name or "未命名路点"
            props: dict[str, Any] = {
                "feature_type": "poi",
                "route_id": route_id,
                "category": category,
                "name": poi_name,
                "poi_kind": _infer_poi_kind(poi_name, desc, poi_kinds),
            }
            if desc:
                props["description"] = desc
            if len(pos) >= 3:
                props["ele"] = pos[2]
            pois.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": pos}, "properties": props})

        elif tag in ("trk", "rte"):
            base_name = ""
            base_desc = ""
            for child in elem:
                ctag = _local_tag(child.tag)
                if ctag == "name" and child.text:
                    base_name = child.text.strip()
                elif ctag in ("desc", "cmt") and child.text and not base_desc:
                    base_desc = _clean_description(child.text)

            segments = [c for c in elem if _local_tag(c.tag) == "trkseg"] if tag == "trk" else [elem]
            pt_tag = "trkpt" if tag == "trk" else "rtept"
            for seg in segments:
                line: list[list[float]] = []
                for child in seg:
                    if _local_tag(child.tag) == pt_tag:
                        pos = _extract_gpx_point(child)
                        if pos and (not line or line[-1][:2] != pos[:2]):
                            line.append(pos)
                if len(line) >= 2:
                    seg_idx += 1
                    props = {
                        "feature_type": "route",
                        "route_id": route_id,
                        "category": category,
                        "segment_index": seg_idx,
                        "name": base_name or f"轨迹段 {seg_idx}",
                    }
                    if base_desc:
                        props["description"] = base_desc
                    routes.append(
                        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": line}, "properties": props}
                    )

    return routes, pois


def _haversine_km(p1: list[float], p2: list[float]) -> float:
    r_km = 6371.0088
    lon1, lat1 = math.radians(p1[0]), math.radians(p1[1])
    lon2, lat2 = math.radians(p2[0]), math.radians(p2[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2.0 * r_km * math.asin(min(1.0, math.sqrt(a)))


def _compute_metrics(
    route_features: list[dict[str, Any]],
    poi_features: list[dict[str, Any]],
) -> dict[str, Any]:
    total_km = 0.0
    gain_m = 0.0
    eles: list[float] = []
    lngs: list[float] = []
    lats: list[float] = []

    for feat in route_features:
        coords = feat["geometry"]["coordinates"]
        last_ele: float | None = None
        for idx, pos in enumerate(coords):
            lngs.append(pos[0])
            lats.append(pos[1])
            if idx > 0:
                total_km += _haversine_km(coords[idx - 1], pos)
            if len(pos) >= 3:
                ele = pos[2]
                eles.append(ele)
                if last_ele is None:
                    last_ele = ele
                elif ele - last_ele >= 3.0:
                    gain_m += ele - last_ele
                    last_ele = ele
                elif last_ele - ele >= 3.0:
                    last_ele = ele

    for feat in poi_features:
        pos = feat["geometry"]["coordinates"]
        lngs.append(pos[0])
        lats.append(pos[1])
        if len(pos) >= 3:
            eles.append(pos[2])

    bbox = (
        [round(min(lngs), 6), round(min(lats), 6), round(max(lngs), 6), round(max(lats), 6)]
        if lngs and lats
        else None
    )
    return {
        "distance_km": round(total_km, 2),
        "elevation_gain_m": int(round(gain_m)) if eles else None,
        "max_ele_m": int(round(max(eles))) if eles else None,
        "min_ele_m": int(round(min(eles))) if eles else None,
        "bbox": bbox,
        "segments_count": len(route_features),
        "waypoints_count": len(poi_features),
    }


def _read_xml_from_source(file_path: Path) -> ET.Element:
    ext = file_path.suffix.lower()
    if ext == ".kmz":
        with zipfile.ZipFile(file_path, "r") as zf:
            kml_names = [n for n in zf.namelist() if n.lower().endswith(".kml") and not n.startswith("__MACOSX")]
            if not kml_names:
                raise ValueError(f"No .kml entry found inside KMZ: {file_path}")
            # Prefer doc.kml if present; ignore all embedded images/media
            kml_names.sort(key=lambda n: (0 if Path(n).name.lower() == "doc.kml" else 1, n))
            raw_bytes = zf.read(kml_names[0])
            return _decode_xml_bytes(raw_bytes)
    return _decode_xml_bytes(file_path.read_bytes())


def ingest_file(
    raw_file: Path,
    raw_root: Path = RAW_DIR,
    normalized_root: Path = NORMALIZED_DIR,
    schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Parse one raw KML/KMZ/GPX file, write clean GeoJSON, and return its catalog entry."""
    schema = schema or _load_schema()
    poi_kinds = schema.get("poi_kinds") or {}

    rel_path = raw_file.relative_to(raw_root)
    parts = rel_path.parts
    if len(parts) < 2:
        raise ValueError(f"Raw file must be inside a category folder (offroad/cycling/hiking): {raw_file}")

    category = parts[0]
    region = "/".join(parts[1:-1]) if len(parts) > 2 else ""
    stem = raw_file.stem
    route_id = "__".join(parts[:-1] + (stem,))

    root = _read_xml_from_source(raw_file)
    if _local_tag(root.tag).lower() == "gpx":
        routes, pois = _extract_gpx_features(root, route_id, category, poi_kinds)
    else:
        routes, pois = _extract_kml_features(root, route_id, category, poi_kinds)

    if not routes and not pois:
        raise ValueError(f"No valid LineString or Point geometries found in: {raw_file}")

    metrics = _compute_metrics(routes, pois)
    out_geojson = normalized_root.joinpath(*parts[:-1], f"{stem}.geojson")
    out_geojson.parent.mkdir(parents=True, exist_ok=True)

    collection = {
        "type": "FeatureCollection",
        "properties": {
            "route_id": route_id,
            "category": category,
            "region": region,
            "name": stem,
            **metrics,
        },
        "features": routes + pois,
    }
    out_geojson.write_text(json.dumps(collection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return {
        "id": route_id,
        "category": category,
        "region": region,
        "name": stem,
        "raw_file": rel_path.as_posix(),
        "geojson_file": out_geojson.relative_to(raw_root.parent).as_posix(),
        **metrics,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def _load_catalog(catalog_path: Path = CATALOG_PATH) -> dict[str, Any]:
    if not catalog_path.exists():
        return {"version": 1, "updated_at": None, "summary": {}, "routes": []}
    with catalog_path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def sync_catalog(
    raw_root: Path = RAW_DIR,
    normalized_root: Path = NORMALIZED_DIR,
    catalog_path: Path = CATALOG_PATH,
    schema_path: Path = SCHEMA_PATH,
    prune: bool = False,
) -> dict[str, Any]:
    """Scan raw_root, ingest all KML/KMZ/GPX files, and update catalog.json idempotently."""
    schema = _load_schema(schema_path)
    existing = _load_catalog(catalog_path)
    existing_by_id = {entry["id"]: entry for entry in existing.get("routes", []) if "id" in entry}

    raw_files = sorted(
        p for p in raw_root.rglob("*") if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
    )

    seen_ids: set[str] = set()
    for raw_file in raw_files:
        try:
            entry = ingest_file(raw_file, raw_root=raw_root, normalized_root=normalized_root, schema=schema)
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] Skipped {raw_file}: {exc}", file=sys.stderr)
            continue

        prev = existing_by_id.get(entry["id"], {})
        for field in PRESERVED_FIELDS:
            if field in prev:
                entry[field] = prev[field]
        entry.setdefault("status", "collected")
        existing_by_id[entry["id"]] = entry
        seen_ids.add(entry["id"])

    if prune:
        existing_by_id = {rid: val for rid, val in existing_by_id.items() if rid in seen_ids}

    routes_list = sorted(existing_by_id.values(), key=lambda r: (r.get("category", ""), r.get("region", ""), r.get("name", "")))
    by_cat: dict[str, int] = {"offroad": 0, "cycling": 0, "hiking": 0}
    for r in routes_list:
        cat = r.get("category", "")
        by_cat[cat] = by_cat.get(cat, 0) + 1

    catalog = {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary": {
            "total": len(routes_list),
            "by_category": by_cat,
        },
        "routes": routes_list,
    }
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if schema_path.exists():
        schema_json_path = schema_path.with_suffix(".json")
        schema_json_path.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return catalog


VALID_CATEGORIES = ("offroad", "cycling", "hiking")


def _safe_rel_path(base_dir: Path, rel_str: str) -> Path:
    """Resolve rel_str strictly inside base_dir, rejecting path traversal."""
    base_resolved = base_dir.resolve()
    target = (base_resolved / rel_str).resolve()
    if target == base_resolved or base_resolved not in target.parents:
        raise ValueError(f"Path escapes base directory: {rel_str}")
    return target


def _sanitize_name(text: str, allow_slash: bool = False) -> str:
    """Clean illegal Windows/POSIX filename characters."""
    cleaned = text.strip().replace("\\", "/")
    if allow_slash:
        parts = [re.sub(r'[<>:"|?*]', "_", seg).strip(" .") for seg in cleaned.split("/")]
        return "/".join(p for p in parts if p)
    return re.sub(r'[<>:"/\\|?*]', "_", cleaned).strip(" .")


def preview_inbox_file(
    rel_file: str,
    inbox_root: Path = INBOX_DIR,
    schema_path: Path = SCHEMA_PATH,
) -> dict[str, Any]:
    """Parse an inbox KML/KMZ/GPX file into an in-memory GeoJSON FeatureCollection (no images)."""
    src = _safe_rel_path(inbox_root, rel_file)
    if not src.exists() or not src.is_file():
        raise FileNotFoundError(f"Inbox file not found: {rel_file}")
    schema = _load_schema(schema_path)
    poi_kinds = schema.get("poi_kinds") or {}
    root = _read_xml_from_source(src)
    route_id = f"inbox__{src.stem}"
    if _local_tag(root.tag).lower() == "gpx":
        routes, pois = _extract_gpx_features(root, route_id, "inbox", poi_kinds)
    else:
        routes, pois = _extract_kml_features(root, route_id, "inbox", poi_kinds)
    metrics = _compute_metrics(routes, pois)
    return {
        "type": "FeatureCollection",
        "properties": {
            "route_id": route_id,
            "category": "inbox",
            "file": rel_file,
            "name": src.stem,
            **metrics,
        },
        "features": routes + pois,
    }


def classify_inbox_file(
    rel_file: str,
    category: str,
    region: str = "",
    name: str | None = None,
    meta: dict[str, Any] | None = None,
    inbox_root: Path = INBOX_DIR,
    raw_root: Path = RAW_DIR,
    normalized_root: Path = NORMALIZED_DIR,
    catalog_path: Path = CATALOG_PATH,
    schema_path: Path = SCHEMA_PATH,
) -> dict[str, Any]:
    """Move an inbox file into raw/<category>/<region>/<name>.<ext>, ingest it, and save metadata."""
    if category not in VALID_CATEGORIES:
        raise ValueError(f"Invalid category '{category}', expected one of {VALID_CATEGORIES}")

    src = _safe_rel_path(inbox_root, rel_file)
    if not src.exists() or not src.is_file():
        raise FileNotFoundError(f"Inbox file not found: {rel_file}")

    clean_region = _sanitize_name(region, allow_slash=True)
    clean_name = _sanitize_name(name or src.stem) or src.stem
    dest_dir = raw_root / category
    if clean_region:
        dest_dir = dest_dir / Path(*clean_region.split("/"))
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{clean_name}{src.suffix.lower()}"
    if dest.exists() and dest.resolve() != src.resolve():
        raise FileExistsError(f"Target raw file already exists: {dest.relative_to(raw_root).as_posix()}")

    src.replace(dest)
    schema = _load_schema(schema_path)
    entry = ingest_file(dest, raw_root=raw_root, normalized_root=normalized_root, schema=schema)

    meta = meta or {}
    catalog = _load_catalog(catalog_path)
    routes_by_id = {r["id"]: r for r in catalog.get("routes", []) if "id" in r}
    for field in PRESERVED_FIELDS:
        if field in meta and meta[field] not in (None, ""):
            entry[field] = meta[field]
    entry.setdefault("status", "collected")
    routes_by_id[entry["id"]] = entry

    routes_list = sorted(routes_by_id.values(), key=lambda r: (r.get("category", ""), r.get("region", ""), r.get("name", "")))
    by_cat: dict[str, int] = {"offroad": 0, "cycling": 0, "hiking": 0}
    for r in routes_list:
        cat = r.get("category", "")
        by_cat[cat] = by_cat.get(cat, 0) + 1
    catalog_out = {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary": {"total": len(routes_list), "by_category": by_cat},
        "routes": routes_list,
    }
    catalog_path.write_text(json.dumps(catalog_out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return entry


def update_route_meta(
    route_id: str,
    updates: dict[str, Any],
    raw_root: Path = RAW_DIR,
    normalized_root: Path = NORMALIZED_DIR,
    catalog_path: Path = CATALOG_PATH,
    schema_path: Path = SCHEMA_PATH,
) -> dict[str, Any]:
    """Update catalog metadata for an archived route, relocating files if category/region/name changed."""
    catalog = _load_catalog(catalog_path)
    routes = catalog.get("routes", [])
    target_idx = next((i for i, r in enumerate(routes) if r.get("id") == route_id), None)
    if target_idx is None:
        raise KeyError(f"Route not found in catalog: {route_id}")

    entry = dict(routes[target_idx])
    new_cat = updates.get("category", entry["category"])
    if new_cat not in VALID_CATEGORIES:
        raise ValueError(f"Invalid category '{new_cat}'")
    new_region = _sanitize_name(updates.get("region", entry.get("region", "")), allow_slash=True)
    new_name = _sanitize_name(updates.get("name", entry.get("name", ""))) or entry["name"]

    old_raw = _safe_rel_path(raw_root, entry["raw_file"])
    old_geojson = _safe_rel_path(raw_root.parent, entry["geojson_file"])

    relocated = (new_cat != entry["category"]) or (new_region != entry.get("region", "")) or (new_name != entry["name"])
    if relocated and old_raw.exists():
        dest_dir = raw_root / new_cat
        if new_region:
            dest_dir = dest_dir / Path(*new_region.split("/"))
        dest_dir.mkdir(parents=True, exist_ok=True)
        new_raw = dest_dir / f"{new_name}{old_raw.suffix.lower()}"
        if new_raw.exists() and new_raw.resolve() != old_raw.resolve():
            raise FileExistsError(f"Target raw file already exists: {new_raw.relative_to(raw_root).as_posix()}")

        # Preserve any manually edited POIs from existing geojson before re-ingesting
        existing_pois: list[dict[str, Any]] = []
        if old_geojson.exists():
            old_fc = json.loads(old_geojson.read_text(encoding="utf-8"))
            existing_pois = [
                f for f in old_fc.get("features", []) if f.get("properties", {}).get("feature_type") == "poi"
            ]

        old_raw.replace(new_raw)
        if old_geojson.exists():
            old_geojson.unlink()

        new_entry = ingest_file(
            new_raw,
            raw_root=raw_root,
            normalized_root=normalized_root,
            schema=_load_schema(schema_path),
        )
        # Re-attach preserved POIs so user edits in HTML are never lost on rename/re-category
        new_geojson = raw_root.parent / new_entry["geojson_file"]
        if existing_pois and new_geojson.exists():
            new_fc = json.loads(new_geojson.read_text(encoding="utf-8"))
            route_feats = [
                f for f in new_fc.get("features", []) if f.get("properties", {}).get("feature_type") != "poi"
            ]
            for pf in existing_pois:
                pf.setdefault("properties", {})["route_id"] = new_entry["id"]
                pf["properties"]["category"] = new_cat
            new_fc["features"] = route_feats + existing_pois
            new_fc["properties"]["waypoints_count"] = len(existing_pois)
            new_geojson.write_text(json.dumps(new_fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            new_entry["waypoints_count"] = len(existing_pois)

        for field in PRESERVED_FIELDS:
            if field in entry:
                new_entry[field] = entry[field]
        entry = new_entry

    for field in PRESERVED_FIELDS:
        if field in updates:
            val = updates[field]
            if val in (None, "", []):
                entry.pop(field, None)
            else:
                entry[field] = val
    entry.setdefault("status", "collected")
    entry["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    routes[target_idx] = entry
    routes_sorted = sorted(routes, key=lambda r: (r.get("category", ""), r.get("region", ""), r.get("name", "")))
    by_cat: dict[str, int] = {"offroad": 0, "cycling": 0, "hiking": 0}
    for r in routes_sorted:
        cat = r.get("category", "")
        by_cat[cat] = by_cat.get(cat, 0) + 1
    catalog_out = {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "summary": {"total": len(routes_sorted), "by_category": by_cat},
        "routes": routes_sorted,
    }
    catalog_path.write_text(json.dumps(catalog_out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return entry


def save_route_pois(
    route_id: str,
    poi_features: list[dict[str, Any]],
    kmls_root: Path = KMLS_DIR,
    catalog_path: Path = CATALOG_PATH,
    schema_path: Path = SCHEMA_PATH,
) -> dict[str, Any]:
    """Replace POI features inside a normalized route GeoJSON while preserving route LineStrings."""
    catalog = _load_catalog(catalog_path)
    routes = catalog.get("routes", [])
    target_idx = next((i for i, r in enumerate(routes) if r.get("id") == route_id), None)
    if target_idx is None:
        raise KeyError(f"Route not found in catalog: {route_id}")

    entry = dict(routes[target_idx])
    geojson_path = _safe_rel_path(kmls_root, entry["geojson_file"])
    if not geojson_path.exists():
        raise FileNotFoundError(f"GeoJSON file not found: {entry['geojson_file']}")

    fc = json.loads(geojson_path.read_text(encoding="utf-8"))
    route_feats = [f for f in fc.get("features", []) if f.get("properties", {}).get("feature_type") != "poi"]

    schema = _load_schema(schema_path)
    valid_kinds = set((schema.get("poi_kinds") or {}).keys()) or {"waypoint"}

    cleaned_pois: list[dict[str, Any]] = []
    for pf in poi_features:
        geom = pf.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") != "Point" or len(coords) < 2:
            continue
        lng = round(float(coords[0]), 6)
        lat = round(float(coords[1]), 6)
        pos = [lng, lat]
        if len(coords) >= 3 and coords[2] is not None and math.isfinite(float(coords[2])):
            pos.append(round(float(coords[2]), 2))

        raw_props = pf.get("properties") or {}
        name = str(raw_props.get("name") or "未命名路点").strip()
        poi_kind = str(raw_props.get("poi_kind") or "waypoint")
        if poi_kind not in valid_kinds:
            poi_kind = "waypoint"
        desc = _clean_description(str(raw_props.get("description") or ""))

        props: dict[str, Any] = {
            "feature_type": "poi",
            "route_id": route_id,
            "category": entry["category"],
            "name": name,
            "poi_kind": poi_kind,
        }
        if desc:
            props["description"] = desc
        if len(pos) >= 3:
            props["ele"] = pos[2]
        elif raw_props.get("ele") not in (None, ""):
            try:
                props["ele"] = round(float(raw_props["ele"]), 1)
            except (TypeError, ValueError):
                pass
        cleaned_pois.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": pos}, "properties": props})

    fc["features"] = route_feats + cleaned_pois
    fc.setdefault("properties", {})["waypoints_count"] = len(cleaned_pois)
    geojson_path.write_text(json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    entry["waypoints_count"] = len(cleaned_pois)
    entry["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    routes[target_idx] = entry
    catalog["updated_at"] = entry["updated_at"]
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"route": entry, "geojson": fc}


def inspect_inbox(
    inbox_root: Path = INBOX_DIR,
    schema_path: Path = SCHEMA_PATH,
) -> list[dict[str, Any]]:
    """Summarize unsorted KML/KMZ/GPX files in inbox/ (no images) for AI classification."""
    if not inbox_root.exists():
        return []
    schema = _load_schema(schema_path)
    poi_kinds = schema.get("poi_kinds") or {}

    inbox_files = sorted(
        p for p in inbox_root.rglob("*") if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
    )
    summaries: list[dict[str, Any]] = []
    for fpath in inbox_files:
        rel = fpath.relative_to(inbox_root).as_posix()
        try:
            root = _read_xml_from_source(fpath)
            if _local_tag(root.tag).lower() == "gpx":
                routes, pois = _extract_gpx_features(root, fpath.stem, "inbox", poi_kinds)
            else:
                routes, pois = _extract_kml_features(root, fpath.stem, "inbox", poi_kinds)
            metrics = _compute_metrics(routes, pois)
            descriptions = []
            for feat in routes + pois:
                desc = feat["properties"].get("description", "")
                if desc and desc not in descriptions:
                    descriptions.append(desc[:200])
                if len(descriptions) >= 2:
                    break
            summaries.append(
                {
                    "file": rel,
                    "name": fpath.stem,
                    **metrics,
                    "route_names": [f["properties"]["name"] for f in routes[:10]],
                    "poi_names": [f["properties"]["name"] for f in pois[:20]],
                    "sample_descriptions": descriptions,
                }
            )
        except Exception as exc:  # noqa: BLE001
            summaries.append({"file": rel, "name": fpath.stem, "error": str(exc)})
    return summaries


def main() -> int:
    parser = argparse.ArgumentParser(description="Clean and ingest KML/KMZ/GPX routes (POIs + lines only, no images).")
    parser.add_argument("--prune", action="store_true", help="Remove catalog entries whose raw source files no longer exist.")
    parser.add_argument(
        "--inspect-inbox",
        action="store_true",
        help="Inspect unsorted files in kmls/inbox/ and output clean JSON summaries for AI classification.",
    )
    args = parser.parse_args()

    if args.inspect_inbox:
        items = inspect_inbox()
        print(json.dumps({"pending_count": len(items), "items": items}, ensure_ascii=False, indent=2))
        return 0

    catalog = sync_catalog(prune=args.prune)
    summary = catalog["summary"]
    pending = (
        sum(1 for p in INBOX_DIR.rglob("*") if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS)
        if INBOX_DIR.exists()
        else 0
    )
    print(f"Synced {summary['total']} route(s): {summary['by_category']} (inbox pending: {pending})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
