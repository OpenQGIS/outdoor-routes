/**
 * Page 2: Category Subpage, Main Leaflet Map, Filters, Preview Card & Geolocation
 */
import {
  CATEGORIES,
  state,
  escapeHtml,
  getCatColor,
  getCatLabel,
  showToast,
  fetchJson,
  fetchRouteGeojson,
  guessCategoryFromSummary,
  actions
} from './app-state.js';
import { renderMiniSparklineSvg } from './elevation-profile.js';
import { createBasemapLayer } from './map-layers.js';
import { getCurrentQcReport, renderGeojsonOnMap, renderQcMarkersOnLayer } from './qc-map-overlay.js';
import { exportCurrentRoute } from './route-export.js';

export const map = L.map('map', {
  center: [30.6586, 104.0648],
  zoom: 11,
  zoomSnap: 0.25,
  zoomControl: false
});
L.control.zoom({ position: 'bottomright' }).addTo(map);

const hillshadePane = map.createPane('hillshadePane');
hillshadePane.style.zIndex = '250';
hillshadePane.style.pointerEvents = 'none';
hillshadePane.classList.add('leaflet-hillshade-pane');

export const activeLayerGroup = L.layerGroup().addTo(map);
export const qcMapLayerGroup = L.layerGroup().addTo(map);
export const overviewLayerGroup = L.layerGroup().addTo(map);
export const userLocLayerGroup = L.layerGroup().addTo(map);

let activeBasemapLayer = null;
let esriHillshadeLayer = null;

export function setBasemap(key, notify = false) {
  if (activeBasemapLayer) {
    map.removeLayer(activeBasemapLayer);
    activeBasemapLayer = null;
  }
  const useGcjFix = Boolean(document.getElementById('toggle-gcj-fix')?.checked ?? true);
  const { cfg, layer, fallbackUsed } = createBasemapLayer(key, useGcjFix);

  const gcjRow = document.getElementById('gcj-fix-row');
  if (gcjRow) gcjRow.style.display = cfg.gcj02 ? 'flex' : 'none';

  activeBasemapLayer = layer.addTo(map);
  if (typeof activeBasemapLayer.bringToBack === 'function') {
    activeBasemapLayer.bringToBack();
  }
  if (fallbackUsed) {
    showToast('MapLibre GL 未就绪，已回退至 OSM 栅格底图');
  } else if (notify) {
    const suffix = cfg.gcj02 ? (useGcjFix ? '（已开启 WGS-84 在线纠偏）' : '（未纠偏原始 GCJ-02）') : '';
    showToast(`已切换地图底图${suffix}`);
  }
}

export function updateHillshade() {
  const enabled = Boolean(document.getElementById('toggle-hillshade')?.checked);
  const slider = document.getElementById('hillshade-opacity');
  const pct = Number(slider?.value ?? 45);
  const valEl = document.getElementById('hillshade-opacity-val');
  if (valEl) valEl.textContent = `${pct}%`;
  if (slider) slider.disabled = !enabled;

  if (!enabled) {
    if (esriHillshadeLayer && map.hasLayer(esriHillshadeLayer)) {
      map.removeLayer(esriHillshadeLayer);
    }
    return;
  }
  const opacity = Math.max(0, Math.min(1, pct / 100));
  if (!esriHillshadeLayer) {
    esriHillshadeLayer = L.tileLayer(
      'https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
      {
        pane: 'hillshadePane',
        maxNativeZoom: 16,
        maxZoom: 19,
        opacity,
        attribution: '&copy; Esri World Hillshade'
      }
    );
  } else {
    esriHillshadeLayer.setOpacity(opacity);
  }
  if (!map.hasLayer(esriHillshadeLayer)) esriHillshadeLayer.addTo(map);
}

export function updateHud() {
  const c = map.getCenter();
  const z = document.getElementById('hud-zoom');
  const lat = document.getElementById('hud-lat');
  const lng = document.getElementById('hud-lng');
  if (z) z.textContent = map.getZoom().toFixed(2);
  if (lat) lat.textContent = c.lat.toFixed(5);
  if (lng) lng.textContent = c.lng.toFixed(5);
}
map.on('move zoom', updateHud);

if (window.ResizeObserver) {
  let _raf = null;
  const ro = new ResizeObserver(() => {
    if (_raf) cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  });
  const mapEl = document.getElementById('map');
  if (mapEl) ro.observe(mapEl);
}

export function invalidateCategoryMap() {
  requestAnimationFrame(() => map.invalidateSize({ pan: false }));
}

export function clearCategorySelectedLayers() {
  activeLayerGroup.clearLayers();
  qcMapLayerGroup.clearLayers();
}

export function renderCategoryControls() {
  const cat = state.activeCat;
  const titleEl = document.getElementById('cat-page-title');
  const dotEl = document.getElementById('cat-page-dot');
  const filtersBox = document.getElementById('catalog-filters');

  if (titleEl) titleEl.textContent = getCatLabel(cat);
  if (dotEl) dotEl.style.background = getCatColor(cat);

  const isCatalogCat = CATEGORIES.includes(cat);
  if (filtersBox) filtersBox.style.display = isCatalogCat ? 'flex' : 'none';
  if (!isCatalogCat) return;

  const cfg = state.schema?.categories?.[cat] || {};
  const subTypes = cfg.sub_types || [];
  const subPillsEl = document.getElementById('subtype-pills');
  if (subPillsEl) {
    const items = ['all', ...subTypes];
    subPillsEl.innerHTML = items
      .map((v) => {
        const label = v === 'all' ? '全部类型' : v;
        const active = state.subTypeFilter === v ? 'active' : '';
        return `<button type="button" class="pill ${active}" data-subtype="${escapeHtml(v)}">${escapeHtml(label)}</button>`;
      })
      .join('');
    subPillsEl.querySelectorAll('.pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.subTypeFilter = btn.dataset.subtype;
        renderCategoryControls();
        renderCategoryList();
        renderCategoryOverviewOnMap(true);
      });
    });
  }

  const diffSel = document.getElementById('difficulty-filter');
  if (diffSel) {
    const levels = cfg.difficulty_levels || [];
    diffSel.innerHTML = '<option value="all">全部难度</option>' +
      levels.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    diffSel.value = state.difficultyFilter;
  }
}

export function getFilteredCategoryRoutes() {
  const q = state.query.trim().toLowerCase();
  const list = (state.catalog.routes || []).filter((r) => {
    if (CATEGORIES.includes(state.activeCat) && r.category !== state.activeCat) return false;
    if (state.subTypeFilter !== 'all' && (r.sub_type || '') !== state.subTypeFilter) return false;
    if (state.difficultyFilter !== 'all' && (r.difficulty || '') !== state.difficultyFilter) return false;
    if (state.statusFilter !== 'all' && (r.status || 'collected') !== state.statusFilter) return false;
    if (q) {
      const tagsTxt = Array.isArray(r.tags) ? r.tags.join(' ') : (r.tags || '');
      const hay = `${r.name || ''} ${r.region || ''} ${r.sub_type || ''} ${r.difficulty || ''} ${tagsTxt} ${r.notes || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (state.sortBy === 'distance') {
    list.sort((a, b) => (b.distance_km || 0) - (a.distance_km || 0));
  } else if (state.sortBy === 'gain') {
    list.sort((a, b) => (b.elevation_gain_m || 0) - (a.elevation_gain_m || 0));
  } else if (state.sortBy === 'maxele') {
    list.sort((a, b) => (b.max_ele_m || 0) - (a.max_ele_m || 0));
  }
  return list;
}

export function renderCategoryList() {
  const listEl = document.getElementById('route-list');
  const countEl = document.getElementById('cat-page-count');
  if (!listEl) return;

  if (CATEGORIES.includes(state.activeCat)) {
    const routes = getFilteredCategoryRoutes();
    if (countEl) countEl.textContent = `${routes.length} 条`;

    if (!routes.length) {
      listEl.innerHTML = state.readonly
        ? '<div class="empty-hint">该分类下暂无匹配路线。<br/>请调整上方筛选条件。</div>'
        : '<div class="empty-hint">该分类下暂无匹配路线。<br/>可将文件放入 <b>kmls/inbox/</b> 后在「Inbox」中归档，或直接拖入 KML 预览。</div>';
      return;
    }

    const catColor = getCatColor(state.activeCat);
    listEl.innerHTML = routes.map((r) => {
      const active = state.selectedMode === 'archived' && state.selectedId === r.id ? 'selected' : '';
      const status = r.status || 'collected';
      const spark = renderMiniSparklineSvg(r.ele_profile_preview, catColor, 68, 22);
      const eleSpan = (r.min_ele_m != null && r.max_ele_m != null)
        ? `${r.min_ele_m}~${r.max_ele_m}m`
        : (r.max_ele_m ? `▲${r.max_ele_m}m` : '-');
      return `
        <div class="route-card cat-${escapeHtml(r.category)} ${active}" data-id="${escapeHtml(r.id)}" title="单击预览地图与海拔 · 双击进入 3D 详细拆解">
          <div class="rc-top">
            <div class="rc-name-block">
              <div class="rc-title">${escapeHtml(r.name)}</div>
              <div class="rc-tags">
                ${r.region ? `<span class="badge">${escapeHtml(r.region)}</span>` : ''}
                ${r.sub_type ? `<span class="badge">${escapeHtml(r.sub_type)}</span>` : ''}
                ${r.difficulty ? `<span class="badge">${escapeHtml(r.difficulty)}</span>` : ''}
                ${(r.qc_issues_count ?? 0) > 0 ? `<span class="badge qc-${escapeHtml(r.qc_status || 'warning')}" title="KML 质检发现 ${r.qc_issues_count} 处异常">⚠️ 异常 ${r.qc_issues_count}</span>` : ''}
                <span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>
              </div>
            </div>
          </div>
          <div class="rc-bottom">
            <div class="rc-metrics">
              <span><b>${r.distance_km ?? 0}</b> km</span>
              <span>↑<b>${r.elevation_gain_m ?? '-'}</b> m</span>
              <span>⛰️<b>${eleSpan}</b></span>
              <span>POI <b>${r.waypoints_count ?? 0}</b></span>
            </div>
            ${spark}
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.route-card').forEach((card) => {
      card.addEventListener('click', () => selectArchivedRoute(card.dataset.id));
      card.addEventListener('dblclick', () => actions.openDetailForArchived?.(card.dataset.id));
    });
  } else if (state.activeCat === 'inbox') {
    if (countEl) countEl.textContent = `${state.inbox.length} 条`;
    if (!state.inbox.length) {
      listEl.innerHTML = '<div class="empty-hint">待分类目录 <b>kmls/inbox/</b> 当前为空。<br/>把未整理的 .kml / .kmz / .gpx 放入该目录，点击右上角「扫描同步」即可加载预览。</div>';
      return;
    }
    listEl.innerHTML = state.inbox.map((item) => {
      const active = state.selectedMode === 'inbox' && state.selectedInboxFile === item.file ? 'selected' : '';
      return `
        <div class="route-card cat-inbox ${active}" data-file="${escapeHtml(item.file)}">
          <div class="rc-top">
            <div class="rc-name-block">
              <div class="rc-title">${escapeHtml(item.name)}</div>
              <div class="rc-tags"><span class="badge">待分类</span><span class="badge">${escapeHtml(item.file)}</span>${(item.qc_issues_count ?? 0) > 0 ? `<span class="badge qc-${escapeHtml(item.qc_status || 'warning')}">⚠️ 异常 ${item.qc_issues_count}</span>` : ''}</div>
            </div>
          </div>
          <div class="rc-bottom">
            <div class="rc-metrics">
              ${item.error ? '<span style="color:#ff7b72;">解析失败</span>' : `<span><b>${item.distance_km ?? 0}</b> km</span><span>POI <b>${item.waypoints_count ?? 0}</b></span>`}
            </div>
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.route-card').forEach((card) => {
      card.addEventListener('click', () => selectInboxItem(card.dataset.file));
      card.addEventListener('dblclick', () => actions.openDetailForInbox?.(card.dataset.file));
    });
  } else {
    if (countEl) countEl.textContent = `${state.localRoutes.length} 条`;
    const actionsHtml = `
      <div style="display:flex; gap:6px; margin-bottom:4px;">
        <button type="button" id="btn-local-pick" class="icon-btn" style="flex:1;">📂 选择本地 KML/GPX</button>
        ${state.localRoutes.length ? '<button type="button" id="btn-local-clear" class="icon-btn">🗑️ 清空</button>' : ''}
      </div>
    `;
    if (!state.localRoutes.length) {
      listEl.innerHTML = actionsHtml + '<div class="empty-hint">暂无本地导入路线。<br/>将 <b>.kml / .kmz / .gpx / .geojson</b> 直接拖入浏览器窗口，或点击上方按钮即时预览与 3D 拆解。</div>';
    } else {
      const cardsHtml = state.localRoutes.map((item) => {
        const r = item.entry;
        const active = state.selectedMode === 'local' && state.selectedLocalId === item.id ? 'selected' : '';
        const spark = renderMiniSparklineSvg(r.ele_profile_preview, item.color, 64, 20);
        return `
          <div class="route-card ${active}" data-local-id="${escapeHtml(item.id)}" style="border-left-color:${escapeHtml(item.color)};">
            <div class="rc-top">
              <div class="rc-name-block">
                <div class="rc-title">${escapeHtml(r.name)}</div>
                <div class="rc-tags"><span class="badge">本地预览</span><span class="badge">${escapeHtml(getCatLabel(r.category))}</span>${(r.qc_issues_count ?? 0) > 0 ? `<span class="badge qc-${escapeHtml(r.qc_status || 'warning')}">⚠️ 异常 ${r.qc_issues_count}</span>` : '<span class="badge qc-passed">✓ 质检正常</span>'}</div>
              </div>
              <button type="button" class="rc-remove-btn" data-remove-local="${escapeHtml(item.id)}" title="移除">✕</button>
            </div>
            <div class="rc-bottom">
              <div class="rc-metrics">
                <span><b>${r.distance_km ?? 0}</b> km</span>
                ${r.elevation_gain_m != null ? `<span>↑<b>${r.elevation_gain_m}</b> m</span>` : ''}
                ${r.max_ele_m ? `<span>⛰️<b>${r.max_ele_m}m</b></span>` : ''}
              </div>
              ${spark}
            </div>
          </div>
        `;
      }).join('');
      listEl.innerHTML = actionsHtml + cardsHtml;
    }

    listEl.querySelector('#btn-local-pick')?.addEventListener('click', () => document.getElementById('local-kml-input')?.click());
    listEl.querySelector('#btn-local-clear')?.addEventListener('click', () => actions.clearLocalRoutes?.());
    listEl.querySelectorAll('.route-card[data-local-id]').forEach((card) => {
      card.addEventListener('click', () => selectLocalRoute(card.dataset.localId, true));
      card.addEventListener('dblclick', () => actions.openDetailForLocal?.(card.dataset.localId));
    });
    listEl.querySelectorAll('[data-remove-local]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        actions.removeLocalRoute?.(btn.dataset.removeLocal);
      });
    });
  }
}

export async function renderCategoryOverviewOnMap(fit = false) {
  overviewLayerGroup.clearLayers();
  if (!state.overlayAll) return;

  const bounds = L.latLngBounds();

  if (state.activeCat === 'local') {
    for (const item of state.localRoutes) {
      const color = item.color || '#d946ef';
      for (const feat of item.geojson.features || []) {
        if (feat.geometry?.type === 'LineString') {
          const latlngs = feat.geometry.coordinates.map((c) => [c[1], c[0]]);
          latlngs.forEach((ll) => bounds.extend(ll));
          const poly = L.polyline(latlngs, { color, weight: 3, opacity: 0.78 }).addTo(overviewLayerGroup);
          poly.bindTooltip(`${escapeHtml(item.entry.name)} (${item.entry.distance_km} km)`, { sticky: true });
          poly.on('click', () => selectLocalRoute(item.id, false));
        }
      }
    }
    if (fit && bounds.isValid()) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
    return;
  }

  if (!CATEGORIES.includes(state.activeCat)) return;

  const routes = getFilteredCategoryRoutes();
  for (const r of routes) {
    try {
      const fc = await fetchRouteGeojson(r);
      const color = getCatColor(r.category);
      for (const feat of fc.features || []) {
        if (feat.geometry?.type === 'LineString') {
          const latlngs = feat.geometry.coordinates.map((c) => [c[1], c[0]]);
          latlngs.forEach((ll) => bounds.extend(ll));
          const poly = L.polyline(latlngs, { color, weight: 3, opacity: 0.75 }).addTo(overviewLayerGroup);
          poly.bindTooltip(`${escapeHtml(r.name)} · ${r.distance_km ?? 0} km`, { sticky: true });
          poly.on('click', () => selectArchivedRoute(r.id, false));
        }
      }
    } catch (_) {}
  }

  if (fit && bounds.isValid() && !state.userLatLng) {
    map.fitBounds(bounds, { padding: [52, 52], maxZoom: 13 });
  }
}

export function showPreviewCard(entry, category) {
  const card = document.getElementById('map-preview-card');
  if (!card || !entry) return;
  card.classList.add('visible');

  document.getElementById('mpc-title').textContent = entry.name || '未命名路线';
  const subParts = [getCatLabel(category)];
  if (entry.region) subParts.push(entry.region);
  if (entry.sub_type) subParts.push(entry.sub_type);
  if (entry.difficulty) subParts.push(entry.difficulty);
  document.getElementById('mpc-sub').textContent = subParts.join(' · ');

  const minE = entry.min_ele_m != null ? `${entry.min_ele_m}m` : '-';
  const maxE = entry.max_ele_m != null ? `${entry.max_ele_m}m` : '-';
  document.getElementById('mpc-stats').innerHTML = `
    <div><span>总里程</span><strong>${entry.distance_km ?? 0} km</strong></div>
    <div><span>累计爬升</span><strong>↑ ${entry.elevation_gain_m ?? '-'} m</strong></div>
    <div><span>海拔跨度</span><strong>${minE} ~ ${maxE}</strong></div>
  `;

  const qcBtn = document.getElementById('mpc-btn-qc');
  if (qcBtn) {
    const qc = state.currentQc;
    const cnt = qc?.issues_count ?? entry.qc_issues_count ?? 0;
    const st = qc?.status || entry.qc_status || 'passed';
    if (cnt > 0) {
      qcBtn.textContent = `⚠️ 异常 ${cnt}`;
      qcBtn.style.color = st === 'error' ? '#ff7b72' : '#f59e0b';
      qcBtn.style.borderColor = st === 'error' ? 'rgba(248,81,73,0.5)' : 'rgba(245,158,11,0.5)';
    } else {
      qcBtn.textContent = '🛡️ 质检通过';
      qcBtn.style.color = '#3fb950';
      qcBtn.style.borderColor = 'rgba(63,185,80,0.4)';
    }
  }

  const color = entry._color || getCatColor(category);
  document.getElementById('mpc-sparkline').innerHTML = renderMiniSparklineSvg(
    entry.ele_profile_preview,
    color,
    132,
    38
  );
}

export function hidePreviewCard() {
  document.getElementById('map-preview-card')?.classList.remove('visible');
}

export async function selectArchivedRoute(routeId, fit = true) {
  const entry = (state.catalog.routes || []).find((r) => r.id === routeId);
  if (!entry) return;
  try {
    const fc = await fetchRouteGeojson(entry);
    state.selectedMode = 'archived';
    state.selectedId = routeId;
    state.selectedInboxFile = null;
    state.selectedLocalId = null;
    state.currentEntry = entry;
    state.currentGeojson = fc;
    state.currentQc = getCurrentQcReport(fc, entry);
    renderCategoryList();
    renderGeojsonOnMap(activeLayerGroup, map, fc, entry.category, fit);
    renderQcMarkersOnLayer(qcMapLayerGroup, map, state.currentQc, null, false);
    showPreviewCard(entry, entry.category);
  } catch (err) {
    showToast(`加载路线失败: ${err.message}`);
  }
}

export async function selectInboxItem(relFile, fit = true) {
  const summary = state.inbox.find((i) => i.file === relFile);
  if (!summary) return;
  try {
    const res = await fetchJson(`/api/kmls/inbox_preview?file=${encodeURIComponent(relFile)}`);
    const fc = res.geojson;
    const guessedCat = guessCategoryFromSummary(summary);
    const pseudoEntry = {
      id: `[inbox] ${relFile}`,
      region: '',
      name: summary.name,
      status: 'collected',
      ...fc.properties,
      category: fc.properties?.suggested_category || guessedCat
    };
    state.selectedMode = 'inbox';
    state.selectedId = null;
    state.selectedInboxFile = relFile;
    state.selectedLocalId = null;
    state.currentEntry = pseudoEntry;
    state.currentGeojson = fc;
    state.currentQc = getCurrentQcReport(fc, pseudoEntry);
    renderCategoryList();
    renderGeojsonOnMap(activeLayerGroup, map, fc, 'inbox', fit);
    renderQcMarkersOnLayer(qcMapLayerGroup, map, state.currentQc, null, false);
    showPreviewCard(pseudoEntry, 'inbox');
  } catch (err) {
    showToast(`预览失败: ${err.message}`);
  }
}

export function selectLocalRoute(localId, fit = true) {
  const item = state.localRoutes.find((r) => r.id === localId);
  if (!item) return;
  if (state.addPoiMode) toggleAddPoiMode(false);
  state.selectedMode = 'local';
  state.selectedId = null;
  state.selectedInboxFile = null;
  state.selectedLocalId = localId;
  state.currentEntry = item.entry;
  state.currentGeojson = item.geojson;
  state.currentQc = getCurrentQcReport(item.geojson, item.entry);
  renderCategoryList();
  renderGeojsonOnMap(activeLayerGroup, map, item.geojson, 'local', fit, item.color);
  renderQcMarkersOnLayer(qcMapLayerGroup, map, state.currentQc, null, false);
  showPreviewCard(item.entry, 'local');
}

export function setUserMapCenter(lat, lng, label = '当前参考位置') {
  state.userLatLng = [lat, lng];
  userLocLayerGroup.clearLayers();

  const icon = L.divIcon({
    className: '',
    html: '<div class="user-loc-dot"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
  const marker = L.marker([lat, lng], { icon }).addTo(userLocLayerGroup);
  marker.bindTooltip(label, { direction: 'top' });

  L.circle([lat, lng], {
    radius: 50000,
    color: '#38bdf8',
    weight: 1.2,
    dashArray: '5 5',
    fillColor: '#38bdf8',
    fillOpacity: 0.05,
    interactive: false
  }).addTo(userLocLayerGroup);

  map.setView([lat, lng], 10);
}

export function locateUserOnMap() {
  if (!navigator.geolocation) {
    showToast('浏览器不支持定位，可使用「🎯 地图设中心」在地图点选位置');
    return;
  }
  showToast('正在获取你的当前位置...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      setUserMapCenter(latitude, longitude, '我的当前位置 (50km 周边参照圈)');
      showToast('已定位到你的周边区域');
    },
    (err) => {
      const reason = err.code === 1 ? '定位权限被拒绝' : '暂无法获取 GPS 定位';
      showToast(`${reason}，可点击「🎯 地图设中心」手动点击位置`);
    },
    { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 }
  );
}

export function togglePickCenterMode(forceVal) {
  state.pickCenterMode = typeof forceVal === 'boolean' ? forceVal : !state.pickCenterMode;
  if (state.pickCenterMode && state.addPoiMode) toggleAddPoiMode(false);
  document.getElementById('btn-pick-center')?.classList.toggle('active', state.pickCenterMode);
  document.getElementById('map')?.classList.toggle('crosshair-mode', state.pickCenterMode);
  if (state.pickCenterMode) showToast('请在地图上点击想要查看周边的中心位置');
}

export function toggleAddPoiMode(forceVal) {
  if (state.readonly) return;
  state.addPoiMode = typeof forceVal === 'boolean' ? forceVal : !state.addPoiMode;
  if (state.addPoiMode && state.pickCenterMode) togglePickCenterMode(false);
  document.getElementById('btn-add-poi')?.classList.toggle('active', state.addPoiMode);
  document.getElementById('map')?.classList.toggle('crosshair-mode', state.addPoiMode);
  if (state.addPoiMode) {
    if (!state.currentGeojson) {
      showToast('请先从左侧选择一条路线，再点选地图添加 POI');
      state.addPoiMode = false;
      document.getElementById('btn-add-poi')?.classList.remove('active');
      document.getElementById('map')?.classList.remove('crosshair-mode');
      return;
    }
    showToast('请在地图上点击要标注 POI 的位置');
  }
}

async function openSelectedDetail(targetTab = null) {
  if (!state.currentEntry || !state.currentGeojson) return;
  if (state.selectedMode === 'archived') await actions.openDetailForArchived?.(state.selectedId);
  else if (state.selectedMode === 'inbox') await actions.enterDetailView?.(state.currentEntry, state.currentGeojson, true, false);
  else if (state.selectedMode === 'local') await actions.enterDetailView?.(state.currentEntry, state.currentGeojson, false, true);
  if (targetTab) actions.switchDetailTab?.(targetTab);
}

export function bindCategoryEvents() {
  document.getElementById('difficulty-filter')?.addEventListener('change', (e) => {
    state.difficultyFilter = e.target.value;
    renderCategoryList();
    renderCategoryOverviewOnMap(true);
  });
  document.getElementById('status-filter')?.addEventListener('change', (e) => {
    state.statusFilter = e.target.value;
    renderCategoryList();
    renderCategoryOverviewOnMap(true);
  });
  document.getElementById('sort-select')?.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    renderCategoryList();
  });
  document.getElementById('search-input')?.addEventListener('input', (e) => {
    state.query = e.target.value;
    renderCategoryList();
    renderCategoryOverviewOnMap(false);
  });

  document.getElementById('btn-locate-me')?.addEventListener('click', locateUserOnMap);
  document.getElementById('btn-pick-center')?.addEventListener('click', () => togglePickCenterMode());
  document.getElementById('btn-overlay-all')?.addEventListener('click', (e) => {
    state.overlayAll = !state.overlayAll;
    e.currentTarget.classList.toggle('active', state.overlayAll);
    renderCategoryOverviewOnMap(false);
  });
  document.getElementById('btn-fit-category')?.addEventListener('click', () => {
    state.userLatLng = null;
    userLocLayerGroup.clearLayers();
    renderCategoryOverviewOnMap(true);
  });

  const popover = document.getElementById('basemap-popover');
  document.getElementById('btn-basemap-popover')?.addEventListener('click', (e) => {
    e.stopPropagation();
    popover?.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (popover?.classList.contains('open') && !popover.contains(e.target) && e.target.id !== 'btn-basemap-popover') {
      popover.classList.remove('open');
    }
  });

  document.getElementById('basemap-select')?.addEventListener('change', (e) => setBasemap(e.target.value, true));
  document.getElementById('toggle-hillshade')?.addEventListener('change', updateHillshade);
  document.getElementById('hillshade-opacity')?.addEventListener('input', updateHillshade);
  document.getElementById('toggle-gcj-fix')?.addEventListener('change', () => {
    const key = document.getElementById('basemap-select')?.value || 'openmap-vector';
    setBasemap(key, true);
  });

  document.getElementById('mpc-close')?.addEventListener('click', hidePreviewCard);
  document.getElementById('mpc-btn-fit')?.addEventListener('click', () => {
    if (state.currentGeojson) {
      const cat = state.selectedMode === 'inbox' ? 'inbox' : (state.selectedMode === 'local' ? 'local' : state.currentEntry?.category);
      renderGeojsonOnMap(activeLayerGroup, map, state.currentGeojson, cat, true, state.currentEntry?._color);
    }
  });
  document.getElementById('mpc-btn-kml')?.addEventListener('click', () => exportCurrentRoute('kml'));
  document.getElementById('mpc-btn-qc')?.addEventListener('click', () => openSelectedDetail('qc'));
  document.getElementById('mpc-btn-detail')?.addEventListener('click', () => openSelectedDetail(null));

  document.getElementById('btn-add-poi')?.addEventListener('click', () => toggleAddPoiMode());
  map.on('click', (ev) => {
    if (state.pickCenterMode) {
      togglePickCenterMode(false);
      setUserMapCenter(ev.latlng.lat, ev.latlng.lng, '自定义周边参照点 (50km 圈)');
      showToast('已将该位置设为周边探索中心');
      return;
    }
    if (state.addPoiMode && state.currentGeojson && state.selectedMode !== 'local') {
      toggleAddPoiMode(false);
      if (state.selectedMode === 'archived') actions.openDetailForArchived?.(state.selectedId);
      else actions.enterDetailView?.(state.currentEntry, state.currentGeojson, state.selectedMode === 'inbox', false);
      setTimeout(() => {
        actions.switchDetailTab?.('edit');
        actions.openPoiEditor?.(null, ev.latlng);
      }, 120);
    }
  });
}
