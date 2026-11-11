import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT_DIR / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import ingest_kml  # noqa: E402


SAMPLE_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <PhotoOverlay>
      <name>Ignored Photo</name>
      <Icon><href>files/cover.jpg</href></Icon>
    </PhotoOverlay>
    <Placemark>
      <name>格聂南线主轨迹</name>
      <description><![CDATA[<img src="files/track.jpg"/><p>经典穿越段<br/>碎石路为主</p>]]></description>
      <LineString>
        <coordinates>99.500000,29.800000,3800 99.510000,29.800000,3950 99.520000,29.810000,4100</coordinates>
      </LineString>
    </Placemark>
    <Placemark>
      <name>热梯河营地</name>
      <description><![CDATA[水源充足 <img src="data:image/png;base64,AAAA"/> 可扎营]]></description>
      <ExtendedData>
        <Data name="photo_url"><value>https://example.com/a.jpg</value></Data>
        <Data name="surface"><value>草甸</value></Data>
      </ExtendedData>
      <Point>
        <coordinates>99.505000,29.802000,3850</coordinates>
      </Point>
    </Placemark>
    <Placemark>
      <name>子分段</name>
      <gx:Track>
        <gx:coord>99.520000 29.810000 4100</gx:coord>
        <gx:coord>99.530000 29.815000 4200</gx:coord>
      </gx:Track>
    </Placemark>
  </Document>
</kml>
"""


SAMPLE_GPX = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="30.500000" lon="104.200000">
    <ele>520</ele>
    <name>龙泉山垭口</name>
    <desc>补给点</desc>
  </wpt>
  <trk>
    <name>龙泉山爬坡</name>
    <trkseg>
      <trkpt lat="30.500000" lon="104.200000"><ele>520</ele></trkpt>
      <trkpt lat="30.510000" lon="104.210000"><ele>780</ele></trkpt>
    </trkseg>
  </trk>
</gpx>
"""


class TestIngestKml(unittest.TestCase):
    def test_kmz_strips_images_and_extracts_routes_and_pois(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            raw_root = tmp_path / "raw"
            norm_root = tmp_path / "normalized" / "geojson"
            cat_path = tmp_path / "catalog.json"

            kmz_path = raw_root / "offroad" / "川西" / "格聂南线.kmz"
            kmz_path.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(kmz_path, "w") as zf:
                zf.writestr("doc.kml", SAMPLE_KML.encode("utf-8"))
                zf.writestr("files/cover.jpg", b"FAKEJPEGDATA")
                zf.writestr("files/track.jpg", b"FAKEJPEGDATA2")

            catalog = ingest_kml.sync_catalog(
                raw_root=raw_root,
                normalized_root=norm_root,
                catalog_path=cat_path,
                schema_path=ROOT_DIR / "kmls" / "schema.yaml",
            )
            self.assertEqual(catalog["summary"]["total"], 1)
            self.assertEqual(catalog["summary"]["by_category"]["offroad"], 1)

            entry = catalog["routes"][0]
            self.assertEqual(entry["id"], "offroad__川西__格聂南线")
            self.assertEqual(entry["region"], "川西")
            self.assertEqual(entry["segments_count"], 2)
            self.assertEqual(entry["waypoints_count"], 1)
            self.assertGreater(entry["distance_km"], 2.0)
            self.assertEqual(entry["max_ele_m"], 4200)
            self.assertEqual(entry["elevation_gain_m"], 400)
            self.assertEqual(entry["elevation_loss_m"], 0)
            self.assertEqual(entry["ele_profile_preview"], [3800, 3950, 4100, 4100, 4200])

            out_geojson = norm_root / "offroad" / "川西" / "格聂南线.geojson"
            self.assertTrue(out_geojson.exists())
            data = json.loads(out_geojson.read_text(encoding="utf-8"))
            self.assertEqual(len(data["features"]), 3)

            route_feat = data["features"][0]
            self.assertEqual(route_feat["properties"]["feature_type"], "route")
            self.assertNotIn("<img", route_feat["properties"]["description"])
            self.assertEqual(route_feat["properties"]["description"], "经典穿越段\n碎石路为主")

            poi_feat = data["features"][2]
            self.assertEqual(poi_feat["properties"]["feature_type"], "poi")
            self.assertEqual(poi_feat["properties"]["poi_kind"], "campground")
            self.assertNotIn("data:image", poi_feat["properties"]["description"])
            self.assertNotIn("photo_url", poi_feat["properties"].get("attributes", {}))
            self.assertEqual(poi_feat["properties"]["attributes"]["surface"], "草甸")

    def test_gpx_and_preserve_manual_fields_and_prune(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            raw_root = tmp_path / "raw"
            norm_root = tmp_path / "normalized" / "geojson"
            cat_path = tmp_path / "catalog.json"

            gpx_path = raw_root / "cycling" / "成都" / "龙泉山.gpx"
            gpx_path.parent.mkdir(parents=True, exist_ok=True)
            gpx_path.write_text(SAMPLE_GPX, encoding="utf-8")

            catalog = ingest_kml.sync_catalog(
                raw_root=raw_root,
                normalized_root=norm_root,
                catalog_path=cat_path,
                schema_path=ROOT_DIR / "kmls" / "schema.yaml",
            )
            self.assertEqual(catalog["routes"][0]["waypoints_count"], 1)

            # Simulate user curating difficulty and notes in catalog.json
            catalog["routes"][0]["difficulty"] = "进阶"
            catalog["routes"][0]["notes"] = "周末拉练"
            cat_path.write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")

            catalog2 = ingest_kml.sync_catalog(
                raw_root=raw_root,
                normalized_root=norm_root,
                catalog_path=cat_path,
                schema_path=ROOT_DIR / "kmls" / "schema.yaml",
            )
            self.assertEqual(catalog2["routes"][0]["difficulty"], "进阶")
            self.assertEqual(catalog2["routes"][0]["notes"], "周末拉练")

            # Remove source and run with prune=True
            gpx_path.unlink()
            catalog3 = ingest_kml.sync_catalog(
                raw_root=raw_root,
                normalized_root=norm_root,
                catalog_path=cat_path,
                schema_path=ROOT_DIR / "kmls" / "schema.yaml",
                prune=True,
            )
            self.assertEqual(catalog3["summary"]["total"], 0)

    def test_inspect_inbox_summarizes_without_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox_root = Path(tmp) / "inbox"
            inbox_root.mkdir(parents=True, exist_ok=True)
            (inbox_root / "未整理路线.kml").write_text(SAMPLE_KML, encoding="utf-8")

            items = ingest_kml.inspect_inbox(
                inbox_root=inbox_root,
                schema_path=ROOT_DIR / "kmls" / "schema.yaml",
            )
            self.assertEqual(len(items), 1)
            item = items[0]
            self.assertEqual(item["file"], "未整理路线.kml")
            self.assertIn("热梯河营地", item["poi_names"])
            self.assertEqual(item["segments_count"], 2)
            self.assertNotIn("<img", " ".join(item["sample_descriptions"]))

    def test_inbox_classify_update_meta_and_save_pois(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            inbox_root = tmp_path / "inbox"
            raw_root = tmp_path / "raw"
            norm_root = tmp_path / "normalized" / "geojson"
            cat_path = tmp_path / "catalog.json"
            schema_path = ROOT_DIR / "kmls" / "schema.yaml"

            inbox_root.mkdir(parents=True, exist_ok=True)
            (inbox_root / "待整理路线.kml").write_text(SAMPLE_KML, encoding="utf-8")

            preview_fc = ingest_kml.preview_inbox_file(
                "待整理路线.kml", inbox_root=inbox_root, schema_path=schema_path
            )
            self.assertEqual(len(preview_fc["features"]), 3)

            entry = ingest_kml.classify_inbox_file(
                rel_file="待整理路线.kml",
                category="offroad",
                region="四川-甘孜",
                name="格聂南线-标准版",
                meta={"difficulty": "轻度改装", "season": ["9月", "10月"], "status": "verified", "year": "2026", "notes": "初版归档"},
                inbox_root=inbox_root,
                raw_root=raw_root,
                normalized_root=norm_root,
                catalog_path=cat_path,
                schema_path=schema_path,
            )
            self.assertFalse((inbox_root / "待整理路线.kml").exists())
            classified_kml = raw_root / "offroad" / "格聂南线-标准版.kml"
            self.assertTrue(classified_kml.exists())
            self.assertEqual(entry["region"], "四川-甘孜")
            self.assertEqual(entry["difficulty"], "轻度改装")
            self.assertEqual(entry["season"], ["9月", "10月"])
            self.assertEqual(entry["status"], "verified")

            doc_meta = ingest_kml._extract_kml_document_meta(ingest_kml._read_xml_from_source(classified_kml))
            self.assertEqual(doc_meta["region"], "四川-甘孜")
            self.assertEqual(doc_meta["difficulty"], "轻度改装")
            self.assertEqual(doc_meta["season"], ["9月", "10月"])
            self.assertEqual(doc_meta["year"], "2026")

            # Add a custom POI via save_route_pois
            fc_after = ingest_kml.save_route_pois(
                route_id=entry["id"],
                poi_features=[
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [99.515, 29.805, 4010]},
                        "properties": {"name": "新标注垭口", "poi_kind": "pass", "description": "风大注意保暖"},
                    }
                ],
                kmls_root=tmp_path,
                catalog_path=cat_path,
                schema_path=schema_path,
            )
            self.assertEqual(fc_after["route"]["waypoints_count"], 1)

            # Relocate/rename via update_route_meta (flat layout, region embedded inside KML)
            moved = ingest_kml.update_route_meta(
                route_id=entry["id"],
                updates={"category": "hiking", "region": "川西", "name": "格聂轻徒步", "status": "completed"},
                raw_root=raw_root,
                normalized_root=norm_root,
                catalog_path=cat_path,
                schema_path=schema_path,
            )
            self.assertEqual(moved["category"], "hiking")
            self.assertEqual(moved["region"], "川西")
            self.assertEqual(moved["status"], "completed")
            self.assertEqual(moved["waypoints_count"], 1)
            moved_kml = raw_root / "hiking" / "格聂轻徒步.kml"
            self.assertTrue(moved_kml.exists())
            moved_meta = ingest_kml._extract_kml_document_meta(ingest_kml._read_xml_from_source(moved_kml))
            self.assertEqual(moved_meta["region"], "川西")
            self.assertEqual(moved_meta["category"], "hiking")

            # Path traversal must be rejected
            with self.assertRaises(ValueError):
                ingest_kml.preview_inbox_file("../secret.kml", inbox_root=inbox_root, schema_path=schema_path)

    def test_kml_embedded_document_meta_roundtrip(self):
        kml_with_meta = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>伊鹤牧道测试</name>
    <ExtendedData>
      <Data name="地区"><value>四川-阿坝</value></Data>
      <Data name="sub_type"><value>穿越</value></Data>
      <Data name="difficulty"><value>轻度改装</value></Data>
      <Data name="season"><value>5月,9月,10月</value></Data>
      <Data name="notes"><value>高原牧道注意暗冰</value></Data>
    </ExtendedData>
    <Placemark>
      <name>主线</name>
      <LineString><coordinates>101.6,31.6,3400 101.7,31.7,3600</coordinates></LineString>
    </Placemark>
  </Document>
</kml>
"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            raw_root = tmp_path / "raw"
            norm_root = tmp_path / "normalized" / "geojson"
            cat_path = tmp_path / "catalog.json"

            kml_path = raw_root / "offroad" / "伊鹤牧道测试.kml"
            kml_path.parent.mkdir(parents=True, exist_ok=True)
            kml_path.write_text(kml_with_meta, encoding="utf-8")

            catalog = ingest_kml.sync_catalog(
                raw_root=raw_root,
                normalized_root=norm_root,
                catalog_path=cat_path,
                schema_path=ROOT_DIR / "kmls" / "schema.yaml",
            )
            entry = catalog["routes"][0]
            self.assertEqual(entry["id"], "offroad__伊鹤牧道测试")
            self.assertEqual(entry["region"], "四川-阿坝")
            self.assertEqual(entry["sub_type"], "穿越")
            self.assertEqual(entry["difficulty"], "轻度改装")
            self.assertEqual(entry["season"], ["5月", "9月", "10月"])
            self.assertEqual(entry["notes"], "高原牧道注意暗冰")

            geojson_data = json.loads((norm_root / "offroad" / "伊鹤牧道测试.geojson").read_text(encoding="utf-8"))
            self.assertEqual(geojson_data["properties"]["region"], "四川-阿坝")
            self.assertEqual(geojson_data["properties"]["difficulty"], "轻度改装")

    def test_pure_photo_placemarks_are_skipped(self):
        kml_with_photos = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>主轨迹</name>
      <LineString><coordinates>101.8,29.4,3000 101.9,29.5,3200</coordinates></LineString>
    </Placemark>
    <Placemark>
      <name>
      </name>
      <styleUrl>#MarkerStylePicture</styleUrl>
      <description><![CDATA[<div><img src="https://example.com/1.jpg"/></div>]]></description>
      <Point><coordinates>101.83,29.48,3095</coordinates></Point>
    </Placemark>
    <Placemark>
      <styleUrl>MarkerStylePicture</styleUrl>
      <description><![CDATA[<div><img src="https://example.com/2.jpg"/></div><div>经度：101.84</div><div>纬度：29.47</div><div>海拔：3093</div><div>时间：2026-08-31 12:00:00</div>]]></description>
      <Point><coordinates>101.84,29.47,3093</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>远处雪崩</name>
      <styleUrl>#MarkerStylePicture</styleUrl>
      <description><![CDATA[<div><img src="https://example.com/3.jpg"/></div>]]></description>
      <Point><coordinates>101.85,29.46,3500</coordinates></Point>
    </Placemark>
  </Document>
</kml>
"""
        root = ingest_kml._decode_xml_bytes(kml_with_photos.encode("utf-8"))
        routes, pois = ingest_kml._extract_kml_features(root, "test__photo", "hiking", {})
        self.assertEqual(len(routes), 1)
        self.assertEqual(len(pois), 1)
        self.assertEqual(pois[0]["properties"]["name"], "远处雪崩")


if __name__ == "__main__":
    unittest.main()
