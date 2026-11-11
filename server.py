#!/usr/bin/env python3
"""
Outdoor Routes - 本地 KML 路线库与在线标注工作台轻量服务
"""
from __future__ import annotations

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.join(ROOT_DIR, 'scripts')
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import ingest_kml  # noqa: E402


class OutdoorRoutesHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def _send_json(self, status_code: int, obj: dict | bytes):
        if isinstance(obj, bytes):
            payload = obj
        else:
            payload = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ('/', '/index.html', '/kmls', '/kmls/', '/kmls.html', '/kmls/index.html'):
            self.path = '/index.html'
            return super().do_GET()

        if path == '/api/kmls/catalog':
            try:
                catalog = ingest_kml._load_catalog()
                schema = ingest_kml._load_schema()
                inbox = ingest_kml.inspect_inbox()
                self._send_json(200, {'ok': True, 'catalog': catalog, 'schema': schema, 'inbox': inbox})
            except Exception as e:
                self._send_json(500, {'ok': False, 'message': str(e)})
            return

        if path == '/api/kmls/geojson':
            qs = parse_qs(parsed.query)
            route_id = qs.get('id', [''])[0].strip()
            try:
                catalog = ingest_kml._load_catalog()
                entry = next((r for r in catalog.get('routes', []) if r.get('id') == route_id), None)
                if not entry:
                    raise KeyError(f'Route not found: {route_id}')
                gpath = ingest_kml._safe_rel_path(ingest_kml.KMLS_DIR, entry['geojson_file'])
                self._send_json(200, gpath.read_bytes())
            except Exception as e:
                self._send_json(404, {'ok': False, 'message': str(e)})
            return

        if path == '/api/kmls/inbox_preview':
            qs = parse_qs(parsed.query)
            rel_file = qs.get('file', [''])[0].strip()
            try:
                fc = ingest_kml.preview_inbox_file(rel_file)
                self._send_json(200, {'ok': True, 'geojson': fc})
            except Exception as e:
                self._send_json(404, {'ok': False, 'message': str(e)})
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in (
            '/api/kmls/classify_inbox',
            '/api/kmls/update_meta',
            '/api/kmls/save_pois',
            '/api/kmls/sync',
            '/api/kmls/qc',
        ):
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b'{}'
        try:
            params = json.loads(post_data.decode('utf-8'))
            if parsed.path == '/api/kmls/classify_inbox':
                entry = ingest_kml.classify_inbox_file(
                    rel_file=params['file'],
                    category=params['category'],
                    region=params.get('region', ''),
                    name=params.get('name'),
                    meta={k: params[k] for k in ingest_kml.PRESERVED_FIELDS if k in params},
                )
                res = {'ok': True, 'route': entry}
            elif parsed.path == '/api/kmls/update_meta':
                entry = ingest_kml.update_route_meta(params['id'], params)
                res = {'ok': True, 'route': entry}
            elif parsed.path == '/api/kmls/save_pois':
                out = ingest_kml.save_route_pois(params['id'], params.get('pois', []))
                res = {'ok': True, **out}
            elif parsed.path == '/api/kmls/qc':
                mode = params.get('mode', 'archived')
                thresholds = params.get('thresholds') or {}
                category = params.get('category') or None
                if mode == 'inbox':
                    rel_file = str(params.get('file') or '').strip()
                    target_path = ingest_kml._safe_rel_path(ingest_kml.INBOX_DIR, rel_file)
                else:
                    route_id = str(params.get('id') or '').strip()
                    catalog = ingest_kml._load_catalog(ingest_kml.CATALOG_PATH)
                    entry = next((r for r in catalog.get('routes', []) if r.get('id') == route_id), None)
                    if not entry:
                        raise KeyError(f'Route not found: {route_id}')
                    target_path = ingest_kml._safe_rel_path(ingest_kml.RAW_DIR, entry['raw_file'])
                    category = category or entry.get('category')
                qc = ingest_kml.qc_route_file(target_path, category=category, thresholds=thresholds)
                res = {'ok': True, 'qc': qc}
            else:
                cat = ingest_kml.sync_catalog(prune=bool(params.get('prune', False)))
                res = {'ok': True, 'catalog': cat}
            self._send_json(200, res)
        except Exception as e:
            self._send_json(400, {'ok': False, 'message': str(e)})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    try:
        srv = ThreadingHTTPServer(('127.0.0.1', port), OutdoorRoutesHandler)
    except OSError as e:
        print(f'[Error] Port {port} unavailable: {e}', file=sys.stderr)
        sys.exit(1)
    print(f'Outdoor Routes server running at http://127.0.0.1:{port}/')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down...')
        srv.shutdown()


if __name__ == '__main__':
    main()
