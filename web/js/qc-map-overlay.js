/**
 * Shared GeoJSON Track/POI & QC Anomaly Map Overlay Helpers (Leaflet)
 */
import {
  POI_COLORS,
  state,
  escapeHtml,
  getCatColor,
  getPoiLabel,
  getPoiFeatures,
  actions
} from './app-state.js';
import { inspectGeojson } from './kml-qc.js';

export function getCurrentQcReport(fc, entry) {
  if (fc?.properties?.qc) return fc.properties.qc;
  return inspectGeojson(fc, entry?.category || null);
}

export function renderGeojsonOnMap(targetGroup, targetMap, fc, category, fit = true, overrideColor = null) {
  targetGroup.clearLayers();
  if (!fc || !Array.isArray(fc.features)) return;

  const lineColor = overrideColor || (category === 'inbox' ? '#f59e0b' : (category === 'local' ? '#d946ef' : getCatColor(category)));
  const lineWeight = state.schema?.categories?.[category]?.line_width || 3.5;
  const bounds = L.latLngBounds();

  const pois = [];
  fc.features.forEach((feat) => {
    const geom = feat.geometry || {};
    const props = feat.properties || {};
    if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      const latlngs = geom.coordinates.map((c) => [c[1], c[0]]);
      latlngs.forEach((ll) => bounds.extend(ll));
      const poly = L.polyline(latlngs, {
        color: lineColor,
        weight: lineWeight + 1.5,
        opacity: 0.96
      }).addTo(targetGroup);
      poly.bindTooltip(escapeHtml(props.name || '轨迹'), { sticky: true });
    } else if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      pois.push(feat);
    }
  });

  pois.forEach((feat) => {
    const [lng, lat] = feat.geometry.coordinates;
    const props = feat.properties || {};
    const kind = props.poi_kind || 'waypoint';
    const color = POI_COLORS[kind] || POI_COLORS.waypoint;
    bounds.extend([lat, lng]);

    const marker = L.circleMarker([lat, lng], {
      radius: 6.5,
      color: '#ffffff',
      weight: 2,
      fillColor: color,
      fillOpacity: 0.95
    }).addTo(targetGroup);

    marker.bindTooltip(
      `<b>${escapeHtml(props.name || '未命名路点')}</b><br/><span style="opacity:0.8">${escapeHtml(getPoiLabel(kind))}${props.ele ? ` · ${props.ele}m` : ''}</span>`,
      { direction: 'top' }
    );
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (state.page === 'detail' && !state.readonly && state.selectedMode !== 'local') {
        const poiIdx = getPoiFeatures().indexOf(feat);
        if (poiIdx >= 0) {
          actions.switchDetailTab?.('edit');
          actions.openPoiEditor?.(poiIdx);
          return;
        }
      }
      const popupHtml = `
        <div style="font-size:12px; line-height:1.5; max-width:220px;">
          <strong>${escapeHtml(props.name || '未命名路点')}</strong>
          <div style="color:#555; font-size:11px;">${escapeHtml(getPoiLabel(kind))}${props.ele != null ? ` · ${props.ele}m` : ''}</div>
          ${props.description ? `<div style="margin-top:4px; white-space:pre-wrap;">${escapeHtml(props.description)}</div>` : ''}
        </div>
      `;
      marker.bindPopup(popupHtml).openPopup();
    });
  });

  if (fit && bounds.isValid() && targetMap) {
    targetMap.fitBounds(bounds, { padding: [46, 46], maxZoom: 15 });
  }
}

export function renderQcMarkersOnLayer(targetGroup, targetMap, qc, activeIssueId = null, focusActive = false) {
  if (!targetGroup) return;
  targetGroup.clearLayers();
  if (!state.qcShowOnMap || !qc?.issues?.length) return;

  let activeBounds = null;
  let activeMarker = null;

  for (const issue of qc.issues) {
    if (!Array.isArray(issue.coord) || issue.coord.length < 2) continue;
    const isSelected = Boolean(activeIssueId && issue.id === activeIssueId);
    const isErr = issue.severity === 'error';
    const color = isErr ? '#f85149' : '#f59e0b';
    const currLatLng = [issue.coord[1], issue.coord[0]];

    if (Array.isArray(issue.prev_coord) && issue.prev_coord.length >= 2) {
      const prevLatLng = [issue.prev_coord[1], issue.prev_coord[0]];
      L.polyline([prevLatLng, currLatLng], {
        color,
        weight: isSelected ? 4.5 : 2.8,
        dashArray: '6, 5',
        opacity: isSelected ? 0.98 : 0.8
      }).addTo(targetGroup);
      if (isSelected) {
        activeBounds = L.latLngBounds([prevLatLng, currLatLng]);
      }
    } else if (isSelected) {
      activeBounds = L.latLngBounds([currLatLng, currLatLng]);
    }

    const marker = L.circleMarker(currLatLng, {
      radius: isSelected ? 8.5 : 6,
      color: '#ffffff',
      weight: isSelected ? 2.5 : 1.5,
      fillColor: color,
      fillOpacity: 0.95
    }).addTo(targetGroup);

    const detailParts = [
      issue.distance_m != null ? `位移 ${issue.distance_m} m` : null,
      issue.dt_s != null ? `耗时 ${issue.dt_s} s` : null,
      issue.speed_kmh != null ? `速度 ${issue.speed_kmh} km/h` : null,
      issue.ele_diff_m != null ? `高程差 ${issue.ele_diff_m > 0 ? '+' : ''}${issue.ele_diff_m} m` : null
    ].filter(Boolean);

    const popupHtml = `
      <div style="font-size:12px; line-height:1.5; max-width:250px;">
        <strong style="color:${color};">${escapeHtml(issue.type_label || issue.type)}</strong>
        <div style="margin-top:3px;">${escapeHtml(issue.message)}</div>
        ${detailParts.length ? `<div style="margin-top:4px; color:#555; font-size:11px; font-family:monospace;">${escapeHtml(detailParts.join(' · '))}</div>` : ''}
        ${issue.prev_time && issue.time ? `<div style="margin-top:2px; color:#666; font-size:10.5px; font-family:monospace;">${escapeHtml(issue.prev_time)} → ${escapeHtml(issue.time)}</div>` : ''}
      </div>
    `;
    marker.bindTooltip(`${escapeHtml(issue.type_label || issue.type)}${issue.speed_kmh != null ? ` (${issue.speed_kmh} km/h)` : ''}`, { direction: 'top' });
    marker.bindPopup(popupHtml);
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      state.qcActiveIssueId = issue.id;
      marker.openPopup();
    });

    if (isSelected) activeMarker = marker;
  }

  if (focusActive && targetMap && activeBounds?.isValid()) {
    targetMap.fitBounds(activeBounds.pad(0.35), { maxZoom: 16, padding: [36, 36] });
    if (activeMarker) activeMarker.openPopup();
  }
}
