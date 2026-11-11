#!/usr/bin/env python3
"""
KML / KMZ / GPX / GeoJSON 轨迹质检引擎 (Quality Check)。

核心检测维度：
1. 距离大但时间短（瞬时超速跳变 speed_jump / 零时间间隔瞬移 zero_time_jump）
2. 时间倒流（time_reversal）
3. 空间往返毛刺飞点（spatial_spike，无需时间戳亦可检出）
4. 单步大跨度断点（large_gap）
5. 高程垂直突变（elevation_spike）
6. gx:Track 中 <when> 与 <gx:coord> 数量不一致（timestamp_mismatch）
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_THRESHOLDS: dict[str, float] = {
    "max_speed_kmh": 120.0,       # 瞬时速度上限 (km/h)
    "min_jump_dist_m": 30.0,      # 判定超速跳变的最小两点位移 (m)，过滤 GPS 静止微抖动
    "zero_dt_dist_m": 50.0,       # 时间差 = 0s 时判定瞬移的距离阈值 (m)
    "short_time_s": 5.0,          # 短时间窗口阈值 (s)
    "short_time_dist_m": 150.0,   # 短时间窗口内大距离跳变阈值 (m)
    "max_gap_m": 5000.0,          # 单步大跨度断点阈值 (m)
    "spike_dist_m": 150.0,        # 空间往返毛刺单臂距离阈值 (m)
    "max_ele_rate_ms": 15.0,      # 高程垂直突变速率阈值 (m/s)，需同时满足高程差 >= 100m
}

CATEGORY_SPEED_PRESETS: dict[str, float] = {
    "hiking": 35.0,
    "cycling": 90.0,
    "offroad": 140.0,
}

TYPE_LABELS: dict[str, str] = {
    "speed_jump": "距离大时间短 (瞬时超速)",
    "zero_time_jump": "零耗时大位移跳变",
    "time_reversal": "时间戳倒流",
    "spatial_spike": "空间往返毛刺飞点",
    "large_gap": "大跨度轨迹断点",
    "elevation_spike": "高程垂直突变",
    "timestamp_mismatch": "时间戳与坐标数量不匹配",
}

MAX_STORED_ISSUES = 200


def resolve_thresholds(
    category: str | None = None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, float]:
    """Merge category speed preset and user overrides onto DEFAULT_THRESHOLDS."""
    cfg = dict(DEFAULT_THRESHOLDS)
    if category and category in CATEGORY_SPEED_PRESETS:
        cfg["max_speed_kmh"] = CATEGORY_SPEED_PRESETS[category]

    if overrides:
        for key, default_val in DEFAULT_THRESHOLDS.items():
            raw = overrides.get(key)
            if raw is None or raw == "":
                continue
            try:
                num = float(raw)
            except (TypeError, ValueError):
                continue
            if math.isfinite(num) and num >= 0:
                cfg[key] = num
            else:
                cfg[key] = default_val
    return cfg


def parse_iso_timestamp(text: str | None) -> float | None:
    """Parse an ISO-8601 timestamp string into Unix epoch seconds, or None if invalid."""
    if not text:
        return None
    raw = str(text).strip()
    if not raw:
        return None
    if raw.endswith("Z") or raw.endswith("z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def haversine_m(p1: list[float], p2: list[float]) -> float:
    """Compute great-circle distance in meters between two [lng, lat, ...] points."""
    r_m = 6371008.8
    lon1, lat1 = math.radians(p1[0]), math.radians(p1[1])
    lon2, lat2 = math.radians(p2[0]), math.radians(p2[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2.0 * r_m * math.asin(min(1.0, math.sqrt(a)))


def _make_issue(
    *,
    issue_type: str,
    severity: str,
    segment_index: int,
    segment_name: str,
    point_index: int,
    prev_index: int | None,
    coord: list[float] | None,
    prev_coord: list[float] | None,
    time_str: str | None,
    prev_time_str: str | None,
    distance_m: float | None,
    dt_s: float | None,
    speed_kmh: float | None,
    ele_diff_m: float | None,
    message: str,
) -> dict[str, Any]:
    return {
        "id": f"seg{segment_index}-pt{point_index}-{issue_type}",
        "type": issue_type,
        "type_label": TYPE_LABELS.get(issue_type, issue_type),
        "severity": severity,
        "segment_index": segment_index,
        "segment_name": segment_name,
        "point_index": point_index,
        "prev_index": prev_index,
        "coord": coord,
        "prev_coord": prev_coord,
        "time": time_str,
        "prev_time": prev_time_str,
        "distance_m": round(distance_m, 1) if distance_m is not None else None,
        "dt_s": round(dt_s, 2) if dt_s is not None else None,
        "speed_kmh": round(speed_kmh, 1) if speed_kmh is not None and math.isfinite(speed_kmh) else None,
        "ele_diff_m": round(ele_diff_m, 1) if ele_diff_m is not None else None,
        "message": message,
    }


def inspect_segments(
    segments: list[dict[str, Any]],
    category: str | None = None,
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Run quality checks over a list of track segments.

    Each segment dict accepts:
      - segment_index: int (1-based)
      - name: str
      - points: list[[lng, lat] or [lng, lat, ele]]
      - times: optional list[str | None] aligned 1-to-1 with points
      - timestamp_mismatch: optional bool
    """
    cfg = resolve_thresholds(category=category, overrides=thresholds)
    all_issues: list[dict[str, Any]] = []
    by_type: dict[str, int] = {}
    error_count = 0
    warning_count = 0
    total_points = 0
    timed_points = 0
    max_speed_kmh = 0.0
    max_step_dist_m = 0.0

    def record(issue: dict[str, Any]) -> None:
        nonlocal error_count, warning_count
        itype = issue["type"]
        by_type[itype] = by_type.get(itype, 0) + 1
        if issue["severity"] == "error":
            error_count += 1
        else:
            warning_count += 1
        if len(all_issues) < MAX_STORED_ISSUES:
            all_issues.append(issue)

    for seg_pos, seg in enumerate(segments, start=1):
        seg_idx = int(seg.get("segment_index") or seg_pos)
        seg_name = str(seg.get("name") or f"轨迹段 {seg_idx}")
        pts: list[list[float]] = seg.get("points") or []
        raw_times: list[str | None] = seg.get("times") or []
        total_points += len(pts)

        parsed_times: list[float | None] = []
        for idx in range(len(pts)):
            t_str = raw_times[idx] if idx < len(raw_times) else None
            ts = parse_iso_timestamp(t_str)
            if ts is not None:
                timed_points += 1
            parsed_times.append(ts)

        if seg.get("timestamp_mismatch"):
            record(
                _make_issue(
                    issue_type="timestamp_mismatch",
                    severity="warning",
                    segment_index=seg_idx,
                    segment_name=seg_name,
                    point_index=0,
                    prev_index=None,
                    coord=pts[0] if pts else None,
                    prev_coord=None,
                    time_str=None,
                    prev_time_str=None,
                    distance_m=None,
                    dt_s=None,
                    speed_kmh=None,
                    ele_diff_m=None,
                    message=f"{seg_name}：<when> 与 <gx:coord> 数量不一致，时间校验可能不完整",
                )
            )

        for i in range(1, len(pts)):
            prev = pts[i - 1]
            curr = pts[i]
            dist_m = haversine_m(prev, curr)
            if dist_m > max_step_dist_m:
                max_step_dist_m = dist_m

            t_prev = parsed_times[i - 1]
            t_curr = parsed_times[i]
            t_prev_str = raw_times[i - 1] if (i - 1) < len(raw_times) else None
            t_curr_str = raw_times[i] if i < len(raw_times) else None
            dt_s = (t_curr - t_prev) if (t_prev is not None and t_curr is not None) else None
            ele_diff_m = (curr[2] - prev[2]) if (len(curr) >= 3 and len(prev) >= 3) else None

            flagged_jump = False

            if dt_s is not None:
                if dt_s < 0:
                    flagged_jump = True
                    record(
                        _make_issue(
                            issue_type="time_reversal",
                            severity="error",
                            segment_index=seg_idx,
                            segment_name=seg_name,
                            point_index=i,
                            prev_index=i - 1,
                            coord=curr,
                            prev_coord=prev,
                            time_str=t_curr_str,
                            prev_time_str=t_prev_str,
                            distance_m=dist_m,
                            dt_s=dt_s,
                            speed_kmh=None,
                            ele_diff_m=ele_diff_m,
                            message=f"{seg_name} 第 {i} 点：时间倒流 {abs(dt_s):.1f}s（位移 {dist_m:.1f}m）",
                        )
                    )
                elif dt_s == 0:
                    if dist_m >= cfg["zero_dt_dist_m"]:
                        flagged_jump = True
                        record(
                            _make_issue(
                                issue_type="zero_time_jump",
                                severity="error",
                                segment_index=seg_idx,
                                segment_name=seg_name,
                                point_index=i,
                                prev_index=i - 1,
                                coord=curr,
                                prev_coord=prev,
                                time_str=t_curr_str,
                                prev_time_str=t_prev_str,
                                distance_m=dist_m,
                                dt_s=0.0,
                                speed_kmh=None,
                                ele_diff_m=ele_diff_m,
                                message=(
                                    f"{seg_name} 第 {i} 点：耗时 0s 但位移达 {dist_m:.1f}m"
                                    f"（超过阈值 {cfg['zero_dt_dist_m']:.0f}m）"
                                ),
                            )
                        )
                else:
                    speed_kmh = (dist_m / dt_s) * 3.6
                    if speed_kmh > max_speed_kmh:
                        max_speed_kmh = speed_kmh
                    is_over_speed = dist_m >= cfg["min_jump_dist_m"] and speed_kmh > cfg["max_speed_kmh"]
                    is_short_time_big_dist = (
                        dt_s <= cfg["short_time_s"] and dist_m >= cfg["short_time_dist_m"]
                    )
                    if is_over_speed or is_short_time_big_dist:
                        flagged_jump = True
                        is_severe = (
                            speed_kmh >= cfg["max_speed_kmh"] * 1.5
                            or is_short_time_big_dist
                        )
                        record(
                            _make_issue(
                                issue_type="speed_jump",
                                severity="error" if is_severe else "warning",
                                segment_index=seg_idx,
                                segment_name=seg_name,
                                point_index=i,
                                prev_index=i - 1,
                                coord=curr,
                                prev_coord=prev,
                                time_str=t_curr_str,
                                prev_time_str=t_prev_str,
                                distance_m=dist_m,
                                dt_s=dt_s,
                                speed_kmh=speed_kmh,
                                ele_diff_m=ele_diff_m,
                                message=(
                                    f"{seg_name} 第 {i} 点：{dt_s:.1f}s 内移动 {dist_m:.1f}m"
                                    f"（{speed_kmh:.1f} km/h，阈值 {cfg['max_speed_kmh']:.0f} km/h）"
                                ),
                            )
                        )

            if not flagged_jump and i < len(pts) - 1:
                nxt = pts[i + 1]
                d_next = haversine_m(curr, nxt)
                d_ac = haversine_m(prev, nxt)
                if (
                    dist_m >= cfg["spike_dist_m"]
                    and d_next >= cfg["spike_dist_m"]
                    and d_ac <= min(dist_m, d_next) * 0.35
                ):
                    flagged_jump = True
                    record(
                        _make_issue(
                            issue_type="spatial_spike",
                            severity="warning",
                            segment_index=seg_idx,
                            segment_name=seg_name,
                            point_index=i,
                            prev_index=i - 1,
                            coord=curr,
                            prev_coord=prev,
                            time_str=t_curr_str,
                            prev_time_str=t_prev_str,
                            distance_m=dist_m,
                            dt_s=dt_s,
                            speed_kmh=(dist_m / dt_s * 3.6) if (dt_s and dt_s > 0) else None,
                            ele_diff_m=ele_diff_m,
                            message=(
                                f"{seg_name} 第 {i} 点：疑似往返毛刺飞点（去程 {dist_m:.1f}m / 回程 {d_next:.1f}m，"
                                f"前后邻点直距仅 {d_ac:.1f}m）"
                            ),
                        )
                    )

            if not flagged_jump and dist_m >= cfg["max_gap_m"]:
                record(
                    _make_issue(
                        issue_type="large_gap",
                        severity="warning",
                        segment_index=seg_idx,
                        segment_name=seg_name,
                        point_index=i,
                        prev_index=i - 1,
                        coord=curr,
                        prev_coord=prev,
                        time_str=t_curr_str,
                        prev_time_str=t_prev_str,
                        distance_m=dist_m,
                        dt_s=dt_s,
                        speed_kmh=(dist_m / dt_s * 3.6) if (dt_s and dt_s > 0) else None,
                        ele_diff_m=ele_diff_m,
                        message=(
                            f"{seg_name} 第 {i} 点：单步跨度 {dist_m / 1000:.2f}km"
                            f"（超过断点阈值 {cfg['max_gap_m'] / 1000:.1f}km）"
                        ),
                    )
                )

            if ele_diff_m is not None:
                abs_de = abs(ele_diff_m)
                if dt_s is not None and dt_s > 0:
                    vert_rate = abs_de / dt_s
                    if abs_de >= 100.0 and vert_rate > cfg["max_ele_rate_ms"]:
                        record(
                            _make_issue(
                                issue_type="elevation_spike",
                                severity="warning",
                                segment_index=seg_idx,
                                segment_name=seg_name,
                                point_index=i,
                                prev_index=i - 1,
                                coord=curr,
                                prev_coord=prev,
                                time_str=t_curr_str,
                                prev_time_str=t_prev_str,
                                distance_m=dist_m,
                                dt_s=dt_s,
                                speed_kmh=(dist_m / dt_s * 3.6),
                                ele_diff_m=ele_diff_m,
                                message=(
                                    f"{seg_name} 第 {i} 点：{dt_s:.1f}s 内海拔变化 {ele_diff_m:+.1f}m"
                                    f"（{vert_rate:.1f} m/s）"
                                ),
                            )
                        )
                elif dt_s is None and abs_de >= 500.0 and dist_m < 200.0:
                    record(
                        _make_issue(
                            issue_type="elevation_spike",
                            severity="warning",
                            segment_index=seg_idx,
                            segment_name=seg_name,
                            point_index=i,
                            prev_index=i - 1,
                            coord=curr,
                            prev_coord=prev,
                            time_str=None,
                            prev_time_str=None,
                            distance_m=dist_m,
                            dt_s=None,
                            speed_kmh=None,
                            ele_diff_m=ele_diff_m,
                            message=(
                                f"{seg_name} 第 {i} 点：水平位移 {dist_m:.1f}m 但海拔突变 {ele_diff_m:+.1f}m"
                            ),
                        )
                    )

    issues_count = error_count + warning_count
    if error_count > 0:
        status = "error"
    elif warning_count > 0:
        status = "warning"
    else:
        status = "passed"

    return {
        "status": status,
        "has_timestamps": timed_points > 0,
        "total_points": total_points,
        "timed_points": timed_points,
        "issues_count": issues_count,
        "error_count": error_count,
        "warning_count": warning_count,
        "by_type": by_type,
        "max_speed_kmh": round(max_speed_kmh, 1) if timed_points > 1 else None,
        "max_step_dist_m": round(max_step_dist_m, 1) if total_points > 1 else 0.0,
        "thresholds": cfg,
        "issues": all_issues,
        "truncated": issues_count > len(all_issues),
    }


def inspect_geojson(
    fc: dict[str, Any],
    category: str | None = None,
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run QC on a GeoJSON FeatureCollection (supports optional properties.times / coordTimes)."""
    segments: list[dict[str, Any]] = []
    seg_idx = 0
    for feat in fc.get("features") or []:
        geom = feat.get("geometry") or {}
        props = feat.get("properties") or {}
        if geom.get("type") == "LineString":
            seg_idx += 1
            coords = geom.get("coordinates") or []
            times = props.get("times") or props.get("coordTimes") or []
            segments.append(
                {
                    "segment_index": props.get("segment_index") or seg_idx,
                    "name": props.get("name") or f"轨迹段 {seg_idx}",
                    "points": coords,
                    "times": times,
                }
            )
    return inspect_segments(segments, category=category, thresholds=thresholds)


def main() -> int:
    parser = argparse.ArgumentParser(description="KML / KMZ / GPX / GeoJSON 轨迹质检命令行工具")
    parser.add_argument("target", help="待质检的文件或目录路径")
    parser.add_argument("--category", choices=["offroad", "cycling", "hiking"], default=None, help="路线分类预设")
    parser.add_argument("--max-speed", type=float, default=None, help="最大允许瞬时速度 (km/h)")
    parser.add_argument("--short-time", type=float, default=None, help="短时间窗口阈值 (s)")
    parser.add_argument("--short-dist", type=float, default=None, help="短时间大距离阈值 (m)")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出详细报告")
    args = parser.parse_args()

    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    import ingest_kml  # noqa: E402

    target = Path(args.target)
    if not target.exists():
        print(f"Path not found: {target}", file=sys.stderr)
        return 1

    overrides: dict[str, Any] = {}
    if args.max_speed is not None:
        overrides["max_speed_kmh"] = args.max_speed
    if args.short_time is not None:
        overrides["short_time_s"] = args.short_time
    if args.short_dist is not None:
        overrides["short_time_dist_m"] = args.short_dist

    files = (
        [target]
        if target.is_file()
        else sorted(p for p in target.rglob("*") if p.is_file() and p.suffix.lower() in {".kml", ".kmz", ".gpx", ".geojson"})
    )

    results: list[dict[str, Any]] = []
    for fpath in files:
        if fpath.suffix.lower() == ".geojson":
            fc = json.loads(fpath.read_text(encoding="utf-8"))
            cat = args.category or fc.get("properties", {}).get("category")
            report = inspect_geojson(fc, category=cat, thresholds=overrides)
        else:
            report = ingest_kml.qc_route_file(fpath, category=args.category, thresholds=overrides)
        results.append({"file": str(fpath), "qc": report})

    if args.json:
        print(json.dumps(results if len(results) != 1 else results[0], ensure_ascii=False, indent=2))
        return 0

    for item in results:
        qc = item["qc"]
        badge = {"passed": "PASS", "warning": "WARN", "error": "FAIL"}.get(qc["status"], qc["status"])
        ts_note = "timestamps=yes" if qc["has_timestamps"] else "timestamps=no"
        spd_note = f"max_speed={qc['max_speed_kmh']}km/h" if qc["max_speed_kmh"] is not None else "max_speed=-"
        print(f"[{badge}] {item['file']} | pts={qc['total_points']} ({ts_note}) | {spd_note} | issues={qc['issues_count']}")
        for issue in qc["issues"][:10]:
            print(f"  - [{issue['severity']}] {issue['message']}")
        if qc["issues_count"] > 10:
            print(f"  ... and {qc['issues_count'] - 10} more issues")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
