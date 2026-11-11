/**
 * KML 路线库与在线标注工作台前端逻辑 (Standalone Leaflet)
 */

const map = L.map('map', {
  center: [30.6586, 104.0648],
  zoom: 12,
  zoomSnap: 0.25,
  zoomControl: false
});
L.control.zoom({ position: 'bottomright' }).addTo(map);

const hillshadePane = map.createPane('hillshadePane');
hillshadePane.style.zIndex = '250';
hillshadePane.style.pointerEvents = 'none';
hillshadePane.classList.add('leaflet-hillshade-pane');

function tileToQuadKey(x, y, z) {
  let quad = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quad += digit;
  }
  return quad;
}

const BingTileLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    const subdomains = this.options.subdomains || ['0', '1', '2', '3'];
    const idx = Math.abs(coords.x + coords.y) % subdomains.length;
    const quad = tileToQuadKey(coords.x, coords.y, coords.z);
    return L.Util.template(this._url, {
      s: subdomains[idx],
      q: quad
    });
  }
});

const BASEMAPS = {
  'openmap-vector': {
    type: 'vector',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: '&copy; OpenFreeMap / OpenStreetMap'
  },
  'openmap-bright': {
    type: 'vector',
    style: 'https://tiles.openfreemap.org/styles/bright',
    attribution: '&copy; OpenFreeMap / OpenStreetMap'
  },
  'esri-sat': {
    type: 'raster',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19, attribution: '&copy; Esri World Imagery' }
  },
  'bing-sat': {
    type: 'bing',
    url: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=14275',
    options: { subdomains: ['0', '1', '2', '3'], maxZoom: 19, attribution: '&copy; Bing Maps' }
  },
  'gaode-sat': {
    type: 'raster',
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    options: { subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '&copy; 高德影像' }
  },
  opentopomap: {
    type: 'raster',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 17, attribution: '&copy; OpenTopoMap (CC-BY-SA)' }
  },
  osm: {
    type: 'raster',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }
  },
  'gaode-vec': {
    type: 'raster',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    options: { subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '&copy; 高德地图' }
  }
};

let activeBasemapLayer = null;
let esriHillshadeLayer = null;

function setBasemap(key, notify = false) {
  const cfg = BASEMAPS[key] || BASEMAPS.osm;
  if (activeBasemapLayer) {
    map.removeLayer(activeBasemapLayer);
    activeBasemapLayer = null;
  }

  if (cfg.type === 'vector') {
    if (typeof L.maplibreGL === 'function') {
      activeBasemapLayer = L.maplibreGL({
        style: cfg.style,
        pane: 'tilePane',
        attribution: cfg.attribution
      }).addTo(map);
    } else {
      const fallback = BASEMAPS.osm;
      activeBasemapLayer = L.tileLayer(fallback.url, fallback.options).addTo(map);
      showToast('MapLibre GL 未就绪，已回退至 OSM 栅格底图');
      return;
    }
  } else if (cfg.type === 'bing') {
    activeBasemapLayer = new BingTileLayer(cfg.url, cfg.options).addTo(map);
  } else {
    activeBasemapLayer = L.tileLayer(cfg.url, cfg.options).addTo(map);
  }

  if (typeof activeBasemapLayer.bringToBack === 'function') {
    activeBasemapLayer.bringToBack();
  }
  if (notify) showToast('已切换地图底图');
}

function updateHillshade() {
  const enabled = Boolean(document.getElementById('toggle-hillshade')?.checked);
  const opacitySlider = document.getElementById('hillshade-opacity');
  const opacityPct = Number(opacitySlider?.value ?? 45);
  const valEl = document.getElementById('hillshade-opacity-val');
  if (valEl) valEl.textContent = `${opacityPct}%`;
  if (opacitySlider) opacitySlider.disabled = !enabled;

  if (!enabled) {
    if (esriHillshadeLayer && map.hasLayer(esriHillshadeLayer)) {
      map.removeLayer(esriHillshadeLayer);
    }
    return;
  }

  const opacity = Math.max(0, Math.min(1, opacityPct / 100));
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

  if (!map.hasLayer(esriHillshadeLayer)) {
    esriHillshadeLayer.addTo(map);
  }
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('visible'), 2200);
}

function updateHud() {
  const c = map.getCenter();
  const zoomEl = document.getElementById('hud-zoom');
  const latEl = document.getElementById('hud-lat');
  const lngEl = document.getElementById('hud-lng');
  if (zoomEl) zoomEl.textContent = map.getZoom().toFixed(2);
  if (latEl) latEl.textContent = c.lat.toFixed(5);
  if (lngEl) lngEl.textContent = c.lng.toFixed(5);
}

map.on('move zoom', updateHud);
updateHud();

if (window.ResizeObserver) {
  let _resizeRaf = null;
  const ro = new ResizeObserver(() => {
    if (_resizeRaf) cancelAnimationFrame(_resizeRaf);
    _resizeRaf = requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  });
  const mapEl = document.getElementById('map');
  if (mapEl) ro.observe(mapEl);
}

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

const POI_COLORS = {
  campground: '#22c55e',
  water_source: '#38bdf8',
  pass: '#f59e0b',
  peak: '#ef4444',
  viewpoint: '#a855f7',
  fuel: '#fb923c',
  shelter: '#14b8a6',
  hazard: '#f43f5e',
  parking: '#60a5fa',
  waypoint: '#94a3b8'
};

const DEFAULT_SCHEMA = {
  categories: {
    offroad: { label: '越野穿越', color: '#E85D04', line_width: 3.5 },
    cycling: { label: '自行车', color: '#0EA5E9', line_width: 3.0 },
    hiking: { label: '徒步', color: '#16A34A', line_width: 2.5 }
  },
  poi_kinds: {
    campground: { label: '营地' },
    water_source: { label: '水源' },
    pass: { label: '垭口' },
    peak: { label: '山峰' },
    viewpoint: { label: '观景/打卡点' },
    fuel: { label: '补给/加油' },
    shelter: { label: '驿站/住宿' },
    hazard: { label: '风险/路况' },
    parking: { label: '起终点/停车' },
    waypoint: { label: '普通路点' }
  }
};

const state = {
  readonly: false,
  tab: 'catalog', // 'catalog' | 'inbox'
  catFilter: 'all',
  statusFilter: 'all',
  query: '',
  catalog: { routes: [], summary: {} },
  inbox: [],
  schema: DEFAULT_SCHEMA,
  selectedMode: null, // 'archived' | 'inbox'
  selectedId: null,
  selectedInboxFile: null,
  currentEntry: null,
  currentGeojson: null,
  overlayAll: false,
  addPoiMode: false,
  editingPoiIndex: null,
  pendingNewPoiCoords: null
};

const activeLayerGroup = L.layerGroup().addTo(map);
const overviewLayerGroup = L.layerGroup().addTo(map);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getCatColor(cat) {
  return state.schema?.categories?.[cat]?.color || '#f59e0b';
}

function getCatLabel(cat) {
  return state.schema?.categories?.[cat]?.label || cat;
}

function getPoiLabel(kind) {
  return state.schema?.poi_kinds?.[kind]?.label || kind || '路点';
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (res.status === 404) {
      throw new Error('后端接口 404：请确认已启动根目录 server.py 服务');
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return data;
}

function encodeRelPath(relPath) {
  return String(relPath || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function applyModeUi() {
  document.body.classList.toggle('readonly-mode', state.readonly);
  const badge = document.getElementById('mode-badge');
  if (badge) {
    badge.textContent = state.readonly ? '🌐 静态展示' : '🟢 本地标注';
    badge.title = state.readonly
      ? '纯静态只读展示模式（直接读取 kmls/catalog.json 与 GeoJSON）'
      : '本地编辑模式（已连接 server.py，支持归档与 POI 写回）';
  }
  if (state.readonly) {
    state.tab = 'catalog';
  }
}

async function fetchRouteGeojson(entry) {
  if (state.readonly) {
    const res = await fetch(`./kmls/${encodeRelPath(entry.geojson_file)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  return fetchJson(`./api/kmls/geojson?id=${encodeURIComponent(entry.id)}`);
}

async function loadCatalogAndInbox() {
  const forceStatic = new URLSearchParams(window.location.search).get('mode') === 'static';
  let loadedFromApi = false;

  if (!forceStatic) {
    try {
      const res = await fetch('./api/kmls/catalog');
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        const data = await res.json();
        if (data.ok !== false) {
          state.readonly = false;
          state.catalog = data.catalog || { routes: [] };
          state.schema = data.schema || DEFAULT_SCHEMA;
          state.inbox = data.inbox || [];
          loadedFromApi = true;
        }
      }
    } catch (_) {
      // Fallback to static catalog.json
    }
  }

  if (!loadedFromApi) {
    const catRes = await fetch('./kmls/catalog.json');
    if (!catRes.ok) {
      throw new Error(`无法读取 ./kmls/catalog.json (HTTP ${catRes.status})`);
    }
    state.catalog = (await catRes.json()) || { routes: [] };
    try {
      const schemaRes = await fetch('./kmls/schema.json');
      if (schemaRes.ok) {
        state.schema = (await schemaRes.json()) || DEFAULT_SCHEMA;
      } else {
        state.schema = DEFAULT_SCHEMA;
      }
    } catch (_) {
      state.schema = DEFAULT_SCHEMA;
    }
    state.inbox = [];
    state.readonly = true;
  }

  applyModeUi();
  populatePoiKindSelect();
  renderCounts();
  renderList();
  if (state.overlayAll) {
    renderOverviewAll();
  }
}

function populatePoiKindSelect() {
  const sel = document.getElementById('p-kind');
  const kinds = state.schema?.poi_kinds || {};
  sel.innerHTML = Object.entries(kinds)
    .map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(v.label || k)} (${escapeHtml(k)})</option>`)
    .join('');
}

function renderCounts() {
  document.getElementById('cnt-catalog').textContent = String((state.catalog.routes || []).length);
  document.getElementById('cnt-inbox').textContent = String(state.inbox.length);
}

function getFilteredRoutes() {
  const q = state.query.trim().toLowerCase();
  return (state.catalog.routes || []).filter((r) => {
    if (state.catFilter !== 'all' && r.category !== state.catFilter) return false;
    if (state.statusFilter !== 'all' && (r.status || 'collected') !== state.statusFilter) return false;
    if (q) {
      const hay = `${r.name || ''} ${r.region || ''} ${r.sub_type || ''} ${r.notes || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderList() {
  const listEl = document.getElementById('route-list');
  const filtersEl = document.getElementById('catalog-filters');
  filtersEl.style.display = state.tab === 'catalog' ? 'flex' : 'none';

  if (state.tab === 'catalog') {
    const routes = getFilteredRoutes();
    if (!routes.length) {
      listEl.innerHTML = state.readonly
        ? '<div class="empty-hint">暂无匹配路线。<br/>当前为纯静态展示模式，请调整筛选条件或查看 <code>kmls/catalog.json</code>。</div>'
        : '<div class="empty-hint">暂无匹配路线。<br/>可将文件放入 <b>kmls/inbox/</b> 后在「待分类 Inbox」标签中预览并一键归档。</div>';
      return;
    }
    listEl.innerHTML = routes.map((r) => {
      const active = state.selectedMode === 'archived' && state.selectedId === r.id ? 'selected' : '';
      const status = r.status || 'collected';
      return `
        <div class="route-card cat-${escapeHtml(r.category)} ${active}" data-id="${escapeHtml(r.id)}">
          <div class="rc-title">
            <span>${escapeHtml(r.name)}</span>
            <span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>
          </div>
          <div class="rc-meta">
            <span>${escapeHtml(getCatLabel(r.category))}</span>
            ${r.region ? `<span>${escapeHtml(r.region)}</span>` : ''}
            <span>${r.distance_km ?? 0} km</span>
            ${r.max_ele_m ? `<span>▲${r.max_ele_m}m</span>` : ''}
            <span>POI ${r.waypoints_count ?? 0}</span>
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.route-card').forEach((card) => {
      card.addEventListener('click', () => selectArchivedRoute(card.dataset.id));
    });
  } else {
    if (!state.inbox.length) {
      listEl.innerHTML = '<div class="empty-hint">待分类目录 <b>kmls/inbox/</b> 当前为空。<br/>直接把未整理的 .kml / .kmz / .gpx 拖入该目录，点击右上角「扫描同步」即可加载预览。</div>';
      return;
    }
    listEl.innerHTML = state.inbox.map((item) => {
      const active = state.selectedMode === 'inbox' && state.selectedInboxFile === item.file ? 'selected' : '';
      return `
        <div class="route-card cat-inbox ${active}" data-file="${escapeHtml(item.file)}">
          <div class="rc-title">
            <span>${escapeHtml(item.name)}</span>
            <span class="badge">待分类</span>
          </div>
          <div class="rc-meta">
            <span>${escapeHtml(item.file)}</span>
            ${item.error ? `<span style="color:#ff7b72;">解析失败</span>` : `<span>${item.distance_km ?? 0} km · POI ${item.waypoints_count ?? 0}</span>`}
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.route-card').forEach((card) => {
      card.addEventListener('click', () => selectInboxItem(card.dataset.file));
    });
  }
}

async function selectArchivedRoute(routeId) {
  const entry = (state.catalog.routes || []).find((r) => r.id === routeId);
  if (!entry) return;
  try {
    const fc = await fetchRouteGeojson(entry);
    state.selectedMode = 'archived';
    state.selectedId = routeId;
    state.selectedInboxFile = null;
    state.currentEntry = entry;
    state.currentGeojson = fc;
    state.editingPoiIndex = null;
    state.pendingNewPoiCoords = null;
    renderList();
    renderGeojsonOnMap(fc, entry.category, true);
    openDrawerForRoute(entry, false);
  } catch (err) {
    showToast(`加载路线失败: ${err.message}`);
  }
}

async function selectInboxItem(relFile) {
  const summary = state.inbox.find((i) => i.file === relFile);
  if (!summary) return;
  try {
    const res = await fetchJson(`/api/kmls/inbox_preview?file=${encodeURIComponent(relFile)}`);
    const fc = res.geojson;
    state.selectedMode = 'inbox';
    state.selectedId = null;
    state.selectedInboxFile = relFile;
    state.currentEntry = { name: summary.name };
    state.currentGeojson = fc;
    state.editingPoiIndex = null;
    state.pendingNewPoiCoords = null;
    renderList();
    renderGeojsonOnMap(fc, 'inbox', true);

    const guessedCat = guessCategoryFromSummary(summary);
    const pseudoEntry = {
      id: `[inbox] ${relFile}`,
      category: guessedCat,
      region: '',
      name: summary.name,
      status: 'collected',
      ...fc.properties
    };
    openDrawerForRoute(pseudoEntry, true);
  } catch (err) {
    showToast(`预览失败: ${err.message}`);
  }
}

function guessCategoryFromSummary(summary) {
  const txt = `${summary.file} ${(summary.poi_names || []).join(' ')} ${(summary.sample_descriptions || []).join(' ')}`.toLowerCase();
  if (/越野|穿越|无人区|坦克|牧马人|素车|炮弹坑|涉水|4x4|offroad/.test(txt)) return 'offroad';
  if (/骑行|公路车|山地车|砾石|绿道|cycling|bike|gravel/.test(txt)) return 'cycling';
  return 'hiking';
}

function renderGeojsonOnMap(fc, category, fit = true) {
  activeLayerGroup.clearLayers();
  if (!fc || !Array.isArray(fc.features)) return;

  const lineColor = category === 'inbox' ? '#f59e0b' : getCatColor(category);
  const lineWeight = state.schema?.categories?.[category]?.line_width || 3.5;
  const bounds = L.latLngBounds();

  const pois = [];
  fc.features.forEach((feat, idx) => {
    const geom = feat.geometry || {};
    const props = feat.properties || {};
    if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      const latlngs = geom.coordinates.map((c) => [c[1], c[0]]);
      latlngs.forEach((ll) => bounds.extend(ll));
      const poly = L.polyline(latlngs, {
        color: lineColor,
        weight: lineWeight + 1,
        opacity: 0.92
      }).addTo(activeLayerGroup);
      poly.bindTooltip(escapeHtml(props.name || '轨迹'), { sticky: true });
    } else if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      pois.push({ feat, idx });
    }
  });

  pois.forEach(({ feat }) => {
    const [lng, lat] = feat.geometry.coordinates;
    const props = feat.properties || {};
    const kind = props.poi_kind || 'waypoint';
    const color = POI_COLORS[kind] || POI_COLORS.waypoint;
    bounds.extend([lat, lng]);

    const marker = L.circleMarker([lat, lng], {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: color,
      fillOpacity: 0.95
    }).addTo(activeLayerGroup);

    marker.bindTooltip(
      `<b>${escapeHtml(props.name || '未命名路点')}</b><br/><span style="opacity:0.8">${escapeHtml(getPoiLabel(kind))}${props.ele ? ` · ${props.ele}m` : ''}</span>`,
      { direction: 'top' }
    );
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (state.readonly) {
        marker.openTooltip();
        return;
      }
      const poiIdx = getPoiFeatures().indexOf(feat);
      if (poiIdx >= 0) openPoiEditor(poiIdx);
    });
  });

  if (fit && bounds.isValid()) {
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
  }
}

async function renderOverviewAll() {
  overviewLayerGroup.clearLayers();
  if (!state.overlayAll) return;

  const routes = getFilteredRoutes();
  for (const r of routes) {
    try {
      const fc = await fetchRouteGeojson(r);
      const color = getCatColor(r.category);
      for (const feat of fc.features || []) {
        if (feat.geometry?.type === 'LineString') {
          const latlngs = feat.geometry.coordinates.map((c) => [c[1], c[0]]);
          const poly = L.polyline(latlngs, { color, weight: 2.5, opacity: 0.72 }).addTo(overviewLayerGroup);
          poly.bindTooltip(`${escapeHtml(r.name)} (${r.distance_km} km)`, { sticky: true });
          poly.on('click', () => selectArchivedRoute(r.id));
        }
      }
    } catch (_) {}
  }
}

function updateCategoryDependentOptions(cat) {
  const cfg = state.schema?.categories?.[cat] || {};
  const subList = document.getElementById('subtype-options');
  const diffList = document.getElementById('difficulty-options');
  subList.innerHTML = (cfg.sub_types || []).map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  diffList.innerHTML = (cfg.difficulty_levels || []).map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
}

function renderSeasonGrid(selectedSeasons = []) {
  const set = new Set(selectedSeasons || []);
  const grid = document.getElementById('season-grid');
  grid.innerHTML = MONTHS.map((m) =>
    `<div class="season-pill ${set.has(m) ? 'active' : ''}" data-month="${m}">${m}</div>`
  ).join('');
  if (!state.readonly) {
    grid.querySelectorAll('.season-pill').forEach((el) => {
      el.addEventListener('click', () => el.classList.toggle('active'));
    });
  }
}

function openDrawerForRoute(entry, isInbox) {
  document.getElementById('right-panel').classList.remove('hidden');
  document.getElementById('drawer-title').textContent = state.readonly
    ? '路线详情'
    : (isInbox ? '待分类路线预览与归档' : '路线详情与标注');
  document.getElementById('btn-save-meta').textContent = isInbox ? '📥 分类并归档入库' : '💾 保存标注';

  const metricsEl = document.getElementById('route-metrics');
  metricsEl.innerHTML = `
    <div class="metric-card"><div class="metric-label">总里程</div><div class="metric-val">${entry.distance_km ?? 0} km</div></div>
    <div class="metric-card"><div class="metric-label">累计爬升 / 最高海拔</div><div class="metric-val">${entry.elevation_gain_m ?? '-'}m / ${entry.max_ele_m ?? '-'}m</div></div>
    <div class="metric-card"><div class="metric-label">轨迹段 / POI 点</div><div class="metric-val">${entry.segments_count ?? 0} 段 / ${entry.waypoints_count ?? 0} 点</div></div>
    <div class="metric-card"><div class="metric-label">BBox</div><div class="metric-val" style="font-size:10px;">${entry.bbox ? entry.bbox.join(', ') : '-'}</div></div>
  `;

  document.getElementById('f-id').value = entry.id || '';
  document.getElementById('f-category').value = entry.category || 'hiking';
  updateCategoryDependentOptions(entry.category || 'hiking');
  document.getElementById('f-subtype').value = entry.sub_type || '';
  document.getElementById('f-region').value = entry.region || '';
  document.getElementById('f-name').value = entry.name || '';
  document.getElementById('f-difficulty').value = entry.difficulty || '';
  document.getElementById('f-status').value = entry.status || 'collected';
  document.getElementById('f-notes').value = entry.notes || '';
  renderSeasonGrid(entry.season || []);

  ['f-category', 'f-subtype', 'f-region', 'f-name', 'f-difficulty', 'f-status', 'f-notes'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = state.readonly;
  });

  document.getElementById('poi-editor').style.display = 'none';
  renderPoiList();
}

function getPoiFeatures() {
  if (!state.currentGeojson || !Array.isArray(state.currentGeojson.features)) return [];
  return state.currentGeojson.features.filter((f) => f.properties?.feature_type === 'poi');
}

function renderPoiList() {
  const pois = getPoiFeatures();
  document.getElementById('poi-count').textContent = String(pois.length);
  const listEl = document.getElementById('poi-list');
  if (!pois.length) {
    listEl.innerHTML = state.readonly
      ? '<div style="font-size:11.5px; color:var(--text-muted); padding:6px 0;">该路线暂无 POI 路点标注。</div>'
      : '<div style="font-size:11.5px; color:var(--text-muted); padding:6px 0;">暂无 POI，可点击上方「➕ 地图选点新增」在轨迹沿线补充营地、水源、垭口等路点。</div>';
    return;
  }
  listEl.innerHTML = pois.map((f, idx) => {
    const p = f.properties || {};
    const kind = p.poi_kind || 'waypoint';
    const color = POI_COLORS[kind] || POI_COLORS.waypoint;
    return `
      <div class="poi-item" data-poi-idx="${idx}">
        <div class="poi-item-head">
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;"></span>${escapeHtml(p.name || '未命名路点')}</span>
          <span class="badge">${escapeHtml(getPoiLabel(kind))}${p.ele ? ` · ${p.ele}m` : ''}</span>
        </div>
        ${p.description ? `<div style="margin-top:4px;font-size:11px;color:var(--text-muted);">${escapeHtml(p.description)}</div>` : ''}
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.poi-item').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.poiIdx);
      const feat = getPoiFeatures()[idx];
      if (feat) {
        const [lng, lat] = feat.geometry.coordinates;
        map.setView([lat, lng], Math.max(map.getZoom(), 14));
        if (!state.readonly) openPoiEditor(idx);
      }
    });
  });
}

function openPoiEditor(poiIndex, newLatLng = null) {
  const editor = document.getElementById('poi-editor');
  editor.style.display = 'flex';
  if (newLatLng) {
    state.editingPoiIndex = null;
    state.pendingNewPoiCoords = [Number(newLatLng.lng.toFixed(6)), Number(newLatLng.lat.toFixed(6))];
    document.getElementById('poi-editor-title').textContent = '新增 POI 标注';
    document.getElementById('p-name').value = '';
    document.getElementById('p-kind').value = 'waypoint';
    document.getElementById('p-coords').value = `${state.pendingNewPoiCoords[0]}, ${state.pendingNewPoiCoords[1]}`;
    document.getElementById('p-ele').value = '';
    document.getElementById('p-desc').value = '';
    document.getElementById('btn-delete-poi').style.display = 'none';
  } else {
    const feat = getPoiFeatures()[poiIndex];
    if (!feat) return;
    state.editingPoiIndex = poiIndex;
    state.pendingNewPoiCoords = null;
    const p = feat.properties || {};
    const c = feat.geometry.coordinates;
    document.getElementById('poi-editor-title').textContent = `编辑 POI #${poiIndex + 1}`;
    document.getElementById('p-name').value = p.name || '';
    document.getElementById('p-kind').value = p.poi_kind || 'waypoint';
    document.getElementById('p-coords').value = `${c[0]}, ${c[1]}`;
    document.getElementById('p-ele').value = c[2] ?? p.ele ?? '';
    document.getElementById('p-desc').value = p.description || '';
    document.getElementById('btn-delete-poi').style.display = 'inline-block';
  }
}

async function persistPoisToServer() {
  const pois = getPoiFeatures();
  const cat = state.selectedMode === 'inbox' ? 'inbox' : document.getElementById('f-category').value;
  if (state.selectedMode === 'archived' && state.selectedId) {
    const res = await fetchJson('/api/kmls/save_pois', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.selectedId, pois })
    });
    state.currentGeojson = res.geojson;
    const idx = (state.catalog.routes || []).findIndex((r) => r.id === state.selectedId);
    if (idx >= 0) state.catalog.routes[idx] = res.route;
    renderList();
    renderGeojsonOnMap(state.currentGeojson, res.route.category, false);
    openDrawerForRoute(res.route, false);
  } else {
    renderGeojsonOnMap(state.currentGeojson, cat, false);
    renderPoiList();
    showToast('已暂存 POI（归档入库时自动保存）');
  }
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function geojsonToGpx(fc, routeName) {
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
      if (ele !== undefined && ele !== null) lines.push(`    <ele>${ele}</ele>`);
      if (p.name) lines.push(`    <name>${escapeXml(p.name)}</name>`);
      if (p.description) lines.push(`    <desc>${escapeXml(p.description)}</desc>`);
      lines.push('  </wpt>');
    } else if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      lines.push('  <trk>');
      if (p.name) lines.push(`    <name>${escapeXml(p.name)}</name>`);
      lines.push('    <trkseg>');
      for (const c of geom.coordinates) {
        const eleTag = c[2] !== undefined && c[2] !== null ? `<ele>${c[2]}</ele>` : '';
        lines.push(`      <trkpt lat="${c[1]}" lon="${c[0]}">${eleTag}</trkpt>`);
      }
      lines.push('    </trkseg>');
      lines.push('  </trk>');
    }
  }
  lines.push('</gpx>');
  return lines.join('\n') + '\n';
}

function geojsonToKml(fc, routeName) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${escapeXml(routeName)}</name>`
  ];
  for (const feat of fc.features || []) {
    const geom = feat.geometry || {};
    const p = feat.properties || {};
    if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      const coord = geom.coordinates.join(',');
      lines.push('    <Placemark>');
      lines.push(`      <name>${escapeXml(p.name || 'POI')}</name>`);
      if (p.description) lines.push(`      <description>${escapeXml(p.description)}</description>`);
      lines.push(`      <Point><coordinates>${coord}</coordinates></Point>`);
      lines.push('    </Placemark>');
    } else if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      const coords = geom.coordinates.map((c) => c.join(',')).join(' ');
      lines.push('    <Placemark>');
      lines.push(`      <name>${escapeXml(p.name || routeName)}</name>`);
      if (p.description) lines.push(`      <description>${escapeXml(p.description)}</description>`);
      lines.push(`      <LineString><coordinates>${coords}</coordinates></LineString>`);
      lines.push('    </Placemark>');
    }
  }
  lines.push('  </Document>', '</kml>');
  return lines.join('\n') + '\n';
}

function exportCurrentRoute(format) {
  if (!state.currentGeojson) {
    showToast('请先选择一条路线');
    return;
  }
  const baseName = (state.currentEntry?.name || 'route').replace(/[<>:"/\\|?*]/g, '_');
  let content = '';
  let mime = 'application/octet-stream';
  if (format === 'geojson') {
    content = JSON.stringify(state.currentGeojson, null, 2) + '\n';
    mime = 'application/geo+json;charset=utf-8';
  } else if (format === 'gpx') {
    content = geojsonToGpx(state.currentGeojson, baseName);
    mime = 'application/gpx+xml;charset=utf-8';
  } else if (format === 'kml') {
    content = geojsonToKml(state.currentGeojson, baseName);
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

function toggleAddPoiMode(forceVal) {
  if (state.readonly) return;
  state.addPoiMode = typeof forceVal === 'boolean' ? forceVal : !state.addPoiMode;
  const btn = document.getElementById('btn-add-poi');
  const mapEl = document.getElementById('map');
  btn.classList.toggle('active', state.addPoiMode);
  mapEl.classList.toggle('crosshair-mode', state.addPoiMode);
  if (state.addPoiMode) {
    if (!state.currentGeojson) {
      showToast('请先从左侧选择一条路线，再点选地图添加 POI');
      state.addPoiMode = false;
      btn.classList.remove('active');
      mapEl.classList.remove('crosshair-mode');
      return;
    }
    showToast('已开启选点模式：请在地图上点击要标注的位置');
  }
}

function bindEvents() {
  document.getElementById('basemap-select').addEventListener('change', (e) => {
    setBasemap(e.target.value, true);
  });

  document.getElementById('toggle-hillshade').addEventListener('change', () => {
    updateHillshade();
  });

  document.getElementById('hillshade-opacity').addEventListener('input', () => {
    updateHillshade();
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.tab = btn.dataset.tab;
      renderList();
    });
  });

  document.querySelectorAll('#cat-pills .pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#cat-pills .pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      state.catFilter = pill.dataset.cat;
      renderList();
      if (state.overlayAll) renderOverviewAll();
    });
  });

  document.getElementById('status-filter').addEventListener('change', (e) => {
    state.statusFilter = e.target.value;
    renderList();
    if (state.overlayAll) renderOverviewAll();
  });

  document.getElementById('search-input').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
    if (state.overlayAll) renderOverviewAll();
  });

  document.querySelectorAll('#export-bar .export-btn').forEach((btn) => {
    btn.addEventListener('click', () => exportCurrentRoute(btn.dataset.export));
  });

  document.getElementById('btn-sync-kmls').addEventListener('click', async () => {
    try {
      await fetchJson('/api/kmls/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prune: false })
      });
      await loadCatalogAndInbox();
      showToast('已扫描同步路线库与待分类 Inbox');
    } catch (err) {
      showToast(`同步失败: ${err.message}`);
    }
  });

  document.getElementById('btn-fit-route').addEventListener('click', () => {
    if (state.currentGeojson) {
      renderGeojsonOnMap(state.currentGeojson, state.selectedMode === 'inbox' ? 'inbox' : document.getElementById('f-category').value, true);
    }
  });

  document.getElementById('btn-overlay-all').addEventListener('click', (e) => {
    state.overlayAll = !state.overlayAll;
    e.currentTarget.classList.toggle('active', state.overlayAll);
    renderOverviewAll();
  });

  document.getElementById('btn-add-poi').addEventListener('click', () => toggleAddPoiMode());
  document.getElementById('btn-drawer-add-poi').addEventListener('click', () => toggleAddPoiMode(true));

  document.getElementById('btn-close-drawer').addEventListener('click', () => {
    document.getElementById('right-panel').classList.add('hidden');
  });

  document.getElementById('f-category').addEventListener('change', (e) => {
    updateCategoryDependentOptions(e.target.value);
  });

  document.getElementById('meta-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const seasons = Array.from(document.querySelectorAll('#season-grid .season-pill.active')).map((el) => el.dataset.month);
    const payload = {
      category: document.getElementById('f-category').value,
      sub_type: document.getElementById('f-subtype').value.trim(),
      region: document.getElementById('f-region').value.trim(),
      name: document.getElementById('f-name').value.trim(),
      difficulty: document.getElementById('f-difficulty').value.trim(),
      season: seasons,
      status: document.getElementById('f-status').value,
      notes: document.getElementById('f-notes').value.trim()
    };

    try {
      if (state.selectedMode === 'inbox' && state.selectedInboxFile) {
        const res = await fetchJson('/api/kmls/classify_inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: state.selectedInboxFile, ...payload })
        });
        const newRoute = res.route;
        const editedPois = getPoiFeatures();
        if (editedPois.length) {
          await fetchJson('/api/kmls/save_pois', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: newRoute.id, pois: editedPois })
          });
        }
        await loadCatalogAndInbox();
        state.tab = 'catalog';
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'catalog'));
        await selectArchivedRoute(newRoute.id);
        showToast(`已归档至 ${newRoute.raw_file}`);
      } else if (state.selectedMode === 'archived' && state.selectedId) {
        const res = await fetchJson('/api/kmls/update_meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.selectedId, ...payload })
        });
        await loadCatalogAndInbox();
        await selectArchivedRoute(res.route.id);
        showToast('路线标注已保存到 catalog.json');
      }
    } catch (err) {
      showToast(`保存失败: ${err.message}`);
    }
  });

  document.getElementById('btn-cancel-poi').addEventListener('click', () => {
    document.getElementById('poi-editor').style.display = 'none';
    state.editingPoiIndex = null;
    state.pendingNewPoiCoords = null;
  });

  document.getElementById('btn-save-poi').addEventListener('click', async () => {
    if (!state.currentGeojson) return;
    const name = document.getElementById('p-name').value.trim() || '未命名路点';
    const poiKind = document.getElementById('p-kind').value || 'waypoint';
    const eleRaw = document.getElementById('p-ele').value.trim();
    const ele = eleRaw !== '' && !Number.isNaN(Number(eleRaw)) ? Number(eleRaw) : null;
    const desc = document.getElementById('p-desc').value.trim();

    if (state.pendingNewPoiCoords) {
      const coords = ele !== null ? [...state.pendingNewPoiCoords, ele] : [...state.pendingNewPoiCoords];
      state.currentGeojson.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords },
        properties: {
          feature_type: 'poi',
          name,
          poi_kind: poiKind,
          ...(desc ? { description: desc } : {}),
          ...(ele !== null ? { ele } : {})
        }
      });
    } else if (state.editingPoiIndex !== null) {
      const feat = getPoiFeatures()[state.editingPoiIndex];
      if (feat) {
        const [lng, lat] = feat.geometry.coordinates;
        feat.geometry.coordinates = ele !== null ? [lng, lat, ele] : [lng, lat];
        feat.properties.name = name;
        feat.properties.poi_kind = poiKind;
        if (desc) feat.properties.description = desc;
        else delete feat.properties.description;
        if (ele !== null) feat.properties.ele = ele;
        else delete feat.properties.ele;
      }
    }

    document.getElementById('poi-editor').style.display = 'none';
    state.editingPoiIndex = null;
    state.pendingNewPoiCoords = null;
    try {
      await persistPoisToServer();
      if (state.selectedMode === 'archived') showToast('POI 标注已保存');
    } catch (err) {
      showToast(`保存 POI 失败: ${err.message}`);
    }
  });

  document.getElementById('btn-delete-poi').addEventListener('click', async () => {
    if (state.editingPoiIndex === null || !state.currentGeojson) return;
    const targetFeat = getPoiFeatures()[state.editingPoiIndex];
    state.currentGeojson.features = state.currentGeojson.features.filter((f) => f !== targetFeat);
    document.getElementById('poi-editor').style.display = 'none';
    state.editingPoiIndex = null;
    try {
      await persistPoisToServer();
      if (state.selectedMode === 'archived') showToast('已删除 POI');
    } catch (err) {
      showToast(`删除 POI 失败: ${err.message}`);
    }
  });

  map.on('click', (ev) => {
    if (!state.addPoiMode || !state.currentGeojson) return;
    toggleAddPoiMode(false);
    openPoiEditor(null, ev.latlng);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const initBasemap = document.getElementById('basemap-select')?.value || 'openmap-vector';
  setBasemap(initBasemap, false);
  updateHillshade();
  bindEvents();
  try {
    await loadCatalogAndInbox();
  } catch (err) {
    showToast(`初始化路线库失败: ${err.message}`);
  }
});
