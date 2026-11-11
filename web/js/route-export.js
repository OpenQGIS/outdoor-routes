/**
 * Route Export Helpers (GPX / KML / GeoJSON)
 */
import { state, getCatColor, showToast } from './app-state.js';

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hexToKmlColor(hex, alpha = 'ff') {
  const clean = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `${alpha}${clean.slice(4, 6)}${clean.slice(2, 4)}${clean.slice(0, 2)}`.toLowerCase();
  }
  return `${alpha}f7812f`;
}

export function geojsonToGpx(fc, routeName) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Outdoor Routes" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${escapeXml(routeName)}</name></metadata>`
  ];
  for (const feat of fc.features || []) {
    const geom = feat.geometry || {};
    const p = feat.properties || {};
    if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      const [lng, lat, ele] = geom.coordinates;
      lines.push(`  <wpt lat="${lat}" lon="${lng}">`);
      if (ele != null) lines.push(`    <ele>${ele}</ele>`);
      if (p.name) lines.push(`    <name>${escapeXml(p.name)}</name>`);
      if (p.description) lines.push(`    <desc>${escapeXml(p.description)}</desc>`);
      lines.push('  </wpt>');
    } else if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      lines.push('  <trk>');
      if (p.name) lines.push(`    <name>${escapeXml(p.name)}</name>`);
      lines.push('    <trkseg>');
      for (const c of geom.coordinates) {
        const eleTag = c[2] != null ? `<ele>${c[2]}</ele>` : '';
        lines.push(`      <trkpt lat="${c[1]}" lon="${c[0]}">${eleTag}</trkpt>`);
      }
      lines.push('    </trkseg>', '  </trk>');
    }
  }
  lines.push('</gpx>');
  return lines.join('\n') + '\n';
}

export function geojsonToKml(fc, routeName, meta = {}) {
  const category = meta.category && meta.category !== 'inbox' ? meta.category : 'hiking';
  const catCfg = state.schema?.categories?.[category] || {};
  const kmlColor = hexToKmlColor(catCfg.color || getCatColor(category), 'ff');
  const lineWidth = Number(catCfg.line_width || 3.5);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${escapeXml(routeName)}</name>`,
    '    <Style id="routeStyle">',
    `      <LineStyle><color>${kmlColor}</color><width>${lineWidth}</width></LineStyle>`,
    '    </Style>'
  ];

  for (const feat of fc.features || []) {
    const g = feat.geometry || {};
    const p = feat.properties || {};
    if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
      const coords = g.coordinates.map((c) => c.join(',')).join(' ');
      lines.push('    <Placemark>');
      lines.push(`      <name>${escapeXml(p.name || routeName)}</name>`);
      lines.push('      <styleUrl>#routeStyle</styleUrl>');
      lines.push(`      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>`);
      lines.push('    </Placemark>');
    } else if (g.type === 'Point' && Array.isArray(g.coordinates)) {
      lines.push('    <Placemark>');
      lines.push(`      <name>${escapeXml(p.name || 'POI')}</name>`);
      if (p.description) lines.push(`      <description>${escapeXml(p.description)}</description>`);
      lines.push(`      <Point><coordinates>${g.coordinates.join(',')}</coordinates></Point>`);
      lines.push('    </Placemark>');
    }
  }
  lines.push('  </Document>', '</kml>');
  return lines.join('\n') + '\n';
}

export function exportCurrentRoute(format) {
  if (!state.currentGeojson) {
    showToast('请先选择一条路线');
    return;
  }
  const meta = { ...(state.currentGeojson.properties || {}), ...(state.currentEntry || {}) };
  const baseName = (meta.name || 'route').replace(/[<>:"/\\|?*]/g, '_');
  let content = '';
  let mime = 'application/octet-stream';
  if (format === 'geojson') {
    content = JSON.stringify(state.currentGeojson, null, 2) + '\n';
    mime = 'application/geo+json;charset=utf-8';
  } else if (format === 'gpx') {
    content = geojsonToGpx(state.currentGeojson, baseName);
    mime = 'application/gpx+xml;charset=utf-8';
  } else if (format === 'kml') {
    content = geojsonToKml(state.currentGeojson, baseName, meta);
    mime = 'application/vnd.google-earth.kml+xml;charset=utf-8';
  } else {
    return;
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${baseName}.${format}`);
}
