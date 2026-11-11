import json
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT_DIR / "scripts"
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import ingest_kml  # noqa: E402
import kml_qc  # noqa: E402
import server  # noqa: E402


KML_WITH_SPEED_JUMP = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <Placemark>
      <name>漂移测试段</name>
      <gx:Track>
        <gx:coord>101.650000 31.800000 2500</gx:coord>
        <gx:coord>101.650100 31.800050 2501</gx:coord>
        <gx:coord>101.660000 31.805000 2502</gx:coord>
        <gx:coord>101.650200 31.800100 2503</gx:coord>
        <when>2026-04-03T10:00:00Z</when>
        <when>2026-04-03T10:00:02Z</when>
        <when>2026-04-03T10:00:04Z</when>
        <when>2026-04-03T10:00:06Z</when>
      </gx:Track>
    </Placemark>
  </Document>
</kml>
"""

KML_WITH_INTERLEAVED_ANOMALIES = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <Placemark>
      <name>交错时间异常段</name>
      <gx:Track>
        <when>2026-04-03T10:00:00Z</when>
        <gx:coord>101.650000 31.800000 2500</gx:coord>
        <when>2026-04-03T10:00:00Z</when>
        <gx:coord>101.651000 31.800000 2505</gx:coord>
        <when>2026-04-03T09:59:50Z</when>
        <gx:coord>101.651100 31.800050 2506</gx:coord>
      </gx:Track>
    </Placemark>
  </Document>
</kml>
"""

GPX_WITH_SPEED_JUMP = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>徒步异常轨迹</name>
    <trkseg>
      <trkpt lat="30.500000" lon="104.200000"><ele>500</ele><time>2026-05-01T01:00:00Z</time></trkpt>
      <trkpt lat="30.500100" lon="104.200100"><ele>502</ele><time>2026-05-01T01:00:10Z</time></trkpt>
      <trkpt lat="30.505000" lon="104.205000"><ele>510</ele><time>2026-05-01T01:00:13Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>
"""


class TestKmlQc(unittest.TestCase):
    def test_detects_short_time_large_distance_jump_in_kml(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            raw_root = tmp_path / "raw"
            norm_root = tmp_path / "normalized" / "geojson"
            cat_path = tmp_path / "catalog.json"

            kml_path = raw_root / "offroad" / "漂移测试.kml"
            kml_path.parent.mkdir(parents=True, exist_ok=True)
            kml_path.write_text(KML_WITH_SPEED_JUMP, encoding="utf-8")

            catalog = ingest_kml.sync_catalog(
                raw_root=raw_root,
                normalized_root=norm_root,
                catalog_path=cat_path,
                schema_path=ROOT_DIR / "kmls" / "schema.yaml",
            )
            entry = catalog["routes"][0]
            self.assertEqual(entry["qc_status"], "error")
            self.assertGreaterEqual(entry["qc_issues_count"], 2)

            fc = json.loads((norm_root / "offroad" / "漂移测试.geojson").read_text(encoding="utf-8"))
            qc = fc["properties"]["qc"]
            self.assertTrue(qc["has_timestamps"])
            self.assertEqual(qc["total_points"], 4)
            self.assertEqual(qc["timed_points"], 4)
            self.assertEqual(qc["issues"][0]["type"], "speed_jump")
            self.assertEqual(qc["issues"][0]["point_index"], 2)
            self.assertEqual(qc["issues"][0]["dt_s"], 2.0)
            self.assertGreater(qc["issues"][0]["distance_m"], 900.0)
            self.assertGreater(qc["issues"][0]["speed_kmh"], 1000.0)

    def test_detects_zero_time_jump_and_time_reversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            kml_path = Path(tmp) / "interleaved.kml"
            kml_path.write_text(KML_WITH_INTERLEAVED_ANOMALIES, encoding="utf-8")

            qc = ingest_kml.qc_route_file(kml_path, category="offroad")
            types = [issue["type"] for issue in qc["issues"]]
            self.assertIn("zero_time_jump", types)
            self.assertIn("time_reversal", types)
            self.assertEqual(qc["status"], "error")

    def test_detects_gpx_speed_jump_and_custom_thresholds(self):
        with tempfile.TemporaryDirectory() as tmp:
            gpx_path = Path(tmp) / "hike.gpx"
            gpx_path.write_text(GPX_WITH_SPEED_JUMP, encoding="utf-8")

            qc_hike = ingest_kml.qc_route_file(gpx_path, category="hiking")
            self.assertEqual(qc_hike["status"], "error")
            self.assertEqual(qc_hike["issues"][0]["type"], "speed_jump")
            self.assertEqual(qc_hike["issues"][0]["point_index"], 2)

            # Raising max_speed and short_time_dist_m makes it pass
            qc_relaxed = ingest_kml.qc_route_file(
                gpx_path,
                category="offroad",
                thresholds={"max_speed_kmh": 2000, "short_time_dist_m": 5000},
            )
            self.assertEqual(qc_relaxed["status"], "passed")
            self.assertEqual(qc_relaxed["issues_count"], 0)

    def test_detects_spatial_spike_and_large_gap_without_timestamps(self):
        segments = [
            {
                "segment_index": 1,
                "name": "无时间戳段",
                "points": [
                    [101.6000, 31.8000, 3000],
                    [101.6010, 31.8000, 3010],
                    [101.6100, 31.8100, 3015],  # ~1.4 km spike out and back
                    [101.6012, 31.8001, 3012],
                    [101.7000, 31.8001, 3020],  # ~9.3 km gap
                ],
                "times": [],
            }
        ]
        qc = kml_qc.inspect_segments(segments, category="offroad")
        self.assertFalse(qc["has_timestamps"])
        types = [i["type"] for i in qc["issues"]]
        self.assertIn("spatial_spike", types)
        self.assertIn("large_gap", types)

    def test_elevation_spike_detection(self):
        segments = [
            {
                "segment_index": 1,
                "name": "高程突变段",
                "points": [
                    [101.6000, 31.8000, 3000],
                    [101.6001, 31.8000, 3500],  # +500m in 2s
                ],
                "times": ["2026-04-03T10:00:00Z", "2026-04-03T10:00:02Z"],
            }
        ]
        qc = kml_qc.inspect_segments(segments, category="hiking")
        types = [i["type"] for i in qc["issues"]]
        self.assertIn("elevation_spike", types)

    def test_server_qc_api_endpoint_inbox_and_archived(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            inbox_dir = tmp_path / "inbox"
            raw_dir = tmp_path / "raw" / "offroad"
            inbox_dir.mkdir(parents=True)
            raw_dir.mkdir(parents=True)

            inbox_kml = inbox_dir / "inbox_jump.kml"
            inbox_kml.write_text(KML_WITH_SPEED_JUMP, encoding="utf-8")
            raw_kml = raw_dir / "archived_jump.kml"
            raw_kml.write_text(KML_WITH_SPEED_JUMP, encoding="utf-8")

            catalog_path = tmp_path / "catalog.json"
            catalog_path.write_text(
                json.dumps(
                    {
                        "routes": [
                            {
                                "id": "offroad/archived_jump",
                                "category": "offroad",
                                "raw_file": "offroad/archived_jump.kml",
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.OutdoorRoutesHandler)
            port = httpd.server_address[1]
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                with (
                    mock.patch.object(ingest_kml, "INBOX_DIR", inbox_dir),
                    mock.patch.object(ingest_kml, "RAW_DIR", tmp_path / "raw"),
                    mock.patch.object(ingest_kml, "CATALOG_PATH", catalog_path),
                ):
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}/api/kmls/qc",
                        data=json.dumps({"mode": "inbox", "file": "inbox_jump.kml", "category": "offroad"}).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    self.assertTrue(data["ok"])
                    self.assertEqual(data["qc"]["status"], "error")
                    self.assertEqual(data["qc"]["issues"][0]["type"], "speed_jump")

                    req_arch = urllib.request.Request(
                        f"http://127.0.0.1:{port}/api/kmls/qc",
                        data=json.dumps(
                            {
                                "mode": "archived",
                                "id": "offroad/archived_jump",
                                "thresholds": {
                                    "max_speed_kmh": 5000,
                                    "short_time_dist_m": 5000,
                                    "spike_dist_m": 5000,
                                },
                            }
                        ).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req_arch, timeout=5) as resp:
                        data_arch = json.loads(resp.read().decode("utf-8"))
                    self.assertTrue(data_arch["ok"])
                    self.assertNotIn("speed_jump", [i["type"] for i in data_arch["qc"]["issues"]])
                    self.assertEqual(data_arch["qc"]["status"], "passed")
            finally:
                httpd.shutdown()
                httpd.server_close()

    def test_ingest_kml_cli_qc_flag(self):
        proc = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "ingest_kml.py"), "--qc"],
            cwd=str(ROOT_DIR),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr or proc.stdout)
        self.assertIn("speed_jump", proc.stdout)


if __name__ == "__main__":
    unittest.main()
