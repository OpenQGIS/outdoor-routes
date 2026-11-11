/**
 * Outdoor Routes — 4-Page Portal, Category Subpages, Standalone Leaderboard & L-Shaped 3D Breakdown
 */
import { parseLocalRouteFile, computeMetrics } from './local-kml-parser.js';
import {
  inspectTrackSegments,
  inspectGeojson,
  removeAnomalyPoints,
  QC_TYPE_META
} from './kml-qc.js';
import { ContourBackground } from './contour-bg.js';
import {
  buildRouteAnalysis,
  ElevationProfileChart,
  renderMiniSparklineSvg
} from './elevation-profile.js';
import { TerrainBlockViewer } from './terrain-block-3d.js';
import { createBasemapLayer } from './map-layers.js';

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const CATEGORIES = ['offroad', 'cycling', 'hiking'];
const LOCAL_ROUTE_PALETTE = ['#d946ef', '#06b6d4', '#f43f5e', '#a855f7', '#eab308', '#22d3ee'];

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
    offroad: {
      label: '越野穿越',
      color: '#E85D04',
      line_width: 3.5,
      sub_types: ['穿越', '无人区', '沙漠', '林道', '涉水', '冰雪'],
      difficulty_levels: ['素车可过', '轻度改装', '重度改装', '极限探险']
    },
    cycling: {
      label: '自行车',
      color: '#0EA5E9',
      line_width: 3.0,
      sub_types: ['公路', '山地XC', '砾石Gravel', '绿道', '长途'],
      difficulty_levels: ['休闲', '进阶', '挑战', '虐线']
    },
    hiking: {
      label: '徒步',
      color: '#16A34A',
      line_width: 2.5,
      sub_types: ['轻徒步', '重装', '古道', '高海拔', '环线'],
      difficulty_levels: ['1星-入门', '2星-初级', '3星-进阶', '4星-高难', '5星-极限']
    }
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
  page: 'home', // 'home' | 'category' | 'leaderboard' | 'detail'
  returnPage: 'category',
  activeCat: 'offroad', // 'offroad' | 'cycling' | 'hiking' | 'inbox' | 'local'
  subTypeFilter: 'all',
  difficultyFilter: 'all',
  statusFilter: 'all',
  sortBy: 'default',
  query: '',

  lbCat: 'all',
  lbYear: 'all',
  lbMetric: 'distance_km',

  catalog: { routes: [], summary: {} },
  inbox: [],
  localRoutes: [],
  schema: DEFAULT_SCHEMA,

  selectedMode: null, // 'archived' | 'inbox' | 'local'
  selectedId: null,
  selectedInboxFile: null,
  selectedLocalId: null,
  currentEntry: null,
  currentGeojson: null,
  currentAnalysis: null,
  currentQc: null,
  qcShowOnMap: true,
  qcActiveIssueId: null,
  qcOriginalSnapshot: null,
  detailTab: 'breakdown', // 'breakdown' | 'pois' | 'qc' | 'edit'

  overlayAll: true,
  pickCenterMode: false,
  addPoiMode: false,
  editingPoiIndex: null,
  pendingNewPoiCoords: null,
  userLatLng: null
};

// Leaflet Main Map (Page 2)
const map = L.map('map', {
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

const activeLayerGroup = L.layerGroup().addTo(map);
const qcMapLayerGroup = L.layerGroup().addTo(map);
const overviewLayerGroup = L.layerGroup().addTo(map);
const userLocLayerGroup = L.layerGroup().addTo(map);

let activeBasemapLayer = null;
let esriHillshadeLayer = null;
let contourBg = null;

// Page 4 Instances (lazy-initialized)
let terrainViewer = null;
let profileChart = null;
let minimap = null;
let minimapLayerGroup = null;
let minimapQcLayerGroup = null;
let minimapBasemapLayer = null;
let minimapHoverDot = null;
let detailAddPoiMode = false;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getCatColor(cat) {
  return state.schema?.categories?.[cat]?.color || (cat === 'inbox' ? '#d29922' : '#f59e0b');
}

function getCatLabel(cat) {
  if (cat === 'inbox') return '待分类 Inbox';
  if (cat === 'local') return '本地预览';
  return state.schema?.categories?.[cat]?.label || cat;
}

function getPoiLabel(kind) {
  return state.schema?.poi_kinds?.[kind]?.label || kind || '路点';
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('visible'), 2300);
}

function encodeRelPath(relPath) {
  return String(relPath || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (res.status === 404) throw new Error('后端接口 404：请确认已启动根目录 server.py 服务');
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

const _geojsonCache = new Map();

async function fetchRouteGeojson(entry, forceRefresh = false) {
  if (!forceRefresh && _geojsonCache.has(entry.id)) {
    return _geojsonCache.get(entry.id);
  }
  let fc;
  if (state.readonly) {
    const res = await fetch(`./kmls/${encodeRelPath(entry.geojson_file)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fc = await res.json();
  } else {
    fc = await fetchJson(`./api/kmls/geojson?id=${encodeURIComponent(entry.id)}`);
  }
  _geojsonCache.set(entry.id, fc);
  return fc;
}

/* ==================== BASEMAPS & HILLSHADE ==================== */
function setBasemap(key, notify = false) {
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

function updateHillshade() {
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

function updateHud() {
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

/* ==================== ROUTER & PAGE SWITCHING ==================== */
function updateTopNavActive() {
  document.querySelectorAll('.topbar-nav .nav-pill').forEach((btn) => {
    const nav = btn.dataset.nav;
    let isActive = false;
    if (state.page === 'home' && nav === 'home') isActive = true;
    else if (state.page === 'leaderboard' && nav === 'leaderboard') isActive = true;
    else if (state.page === 'category' && nav === `cat-${state.activeCat}`) isActive = true;
    else if (state.page === 'detail' && state.returnPage === 'leaderboard' && nav === 'leaderboard') isActive = true;
    else if (state.page === 'detail' && nav === `cat-${state.activeCat}`) isActive = true;
    btn.classList.toggle('active', isActive);
  });
}

function showPage(pageName) {
  state.page = pageName;
  document.querySelectorAll('.view-pane').forEach((el) => {
    el.classList.toggle('active', el.id === `view-${pageName}`);
  });
  updateTopNavActive();

  if (pageName === 'home') {
    contourBg?.render();
  } else if (pageName === 'category') {
    requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  } else if (pageName === 'leaderboard') {
    renderLeaderboardPage();
  } else if (pageName === 'detail') {
    requestAnimationFrame(() => {
      terrainViewer?.resize();
      profileChart?.draw();
      minimap?.invalidateSize({ pan: false });
    });
  }
}

function openHomePage() {
  showPage('home');
}

function openCategoryPage(cat, { resetFilters = true, fitRoutes = true } = {}) {
  state.activeCat = cat;
  state.returnPage = 'category';
  if (resetFilters) {
    state.subTypeFilter = 'all';
    state.difficultyFilter = 'all';
    state.statusFilter = 'all';
    state.sortBy = 'default';
    state.query = '';
    const si = document.getElementById('search-input');
    if (si) si.value = '';
    const st = document.getElementById('status-filter');
    if (st) st.value = 'all';
    const so = document.getElementById('sort-select');
    if (so) so.value = 'default';
  }
  if (state.addPoiMode) toggleAddPoiMode(false);
  if (state.pickCenterMode) togglePickCenterMode(false);
  if (resetFilters) {
    activeLayerGroup.clearLayers();
    qcMapLayerGroup.clearLayers();
  }
  hidePreviewCard();

  showPage('category');
  renderCategoryControls();
  renderCategoryList();
  renderCategoryOverviewOnMap(fitRoutes);
}

function openLeaderboardPage() {
  state.returnPage = 'leaderboard';
  showPage('leaderboard');
}

/* ==================== DATA LOADING ==================== */
function applyModeUi() {
  document.body.classList.toggle('readonly-mode', state.readonly);
  const badge = document.getElementById('mode-badge');
  if (badge) {
    badge.textContent = state.readonly ? '🌐 静态展示' : '🟢 本地标注';
    badge.title = state.readonly
      ? '纯静态只读展示模式（直接读取 kmls/catalog.json 与 GeoJSON）'
      : '本地编辑模式（已连接 server.py，支持归档与 POI 写回）';
  }
  if (state.readonly && state.activeCat === 'inbox') {
    state.activeCat = 'offroad';
  }
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
    } catch (_) {}
  }

  if (!loadedFromApi) {
    const catRes = await fetch('./kmls/catalog.json');
    if (!catRes.ok) throw new Error(`无法读取 ./kmls/catalog.json (HTTP ${catRes.status})`);
    state.catalog = (await catRes.json()) || { routes: [] };
    try {
      const schemaRes = await fetch('./kmls/schema.json');
      state.schema = schemaRes.ok ? ((await schemaRes.json()) || DEFAULT_SCHEMA) : DEFAULT_SCHEMA;
    } catch (_) {
      state.schema = DEFAULT_SCHEMA;
    }
    state.inbox = [];
    state.readonly = true;
  }

  applyModeUi();
  populatePoiKindSelect();
  renderCounts();
  renderHomePortal();

  if (state.page === 'category') {
    renderCategoryControls();
    renderCategoryList();
    renderCategoryOverviewOnMap(false);
  } else if (state.page === 'leaderboard') {
    renderLeaderboardPage();
  }
}

function populatePoiKindSelect() {
  const sel = document.getElementById('p-kind');
  if (!sel) return;
  const kinds = state.schema?.poi_kinds || {};
  sel.innerHTML = Object.entries(kinds)
    .map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(v.label || k)} (${escapeHtml(k)})</option>`)
    .join('');
}

function renderCounts() {
  const inboxEl = document.getElementById('cnt-inbox');
  if (inboxEl) inboxEl.textContent = String(state.inbox.length);
  const localEl = document.getElementById('cnt-local');
  if (localEl) localEl.textContent = String(state.localRoutes.length);
}

/* ==================== PAGE 1: HOME PORTAL ==================== */
function renderHomePortal() {
  const routes = state.catalog.routes || [];
  let totalKm = 0;
  let totalGain = 0;
  let maxEle = 0;

  for (const cat of CATEGORIES) {
    const catRoutes = routes.filter((r) => r.category === cat);
    const catKm = catRoutes.reduce((acc, r) => acc + (Number(r.distance_km) || 0), 0);
    const catMaxEle = catRoutes.reduce((m, r) => Math.max(m, Number(r.max_ele_m) || 0), 0);
    totalKm += catKm;
    maxEle = Math.max(maxEle, catMaxEle);

    const statsEl = document.getElementById(`portal-stats-${cat}`);
    if (statsEl) {
      statsEl.innerHTML = `
        <div><div class="portal-stat-val">${catRoutes.length}</div><div class="portal-stat-lbl">路线数</div></div>
        <div><div class="portal-stat-val">${Math.round(catKm)} km</div><div class="portal-stat-lbl">总里程</div></div>
        <div><div class="portal-stat-val">${catMaxEle ? `${catMaxEle} m` : '-'}</div><div class="portal-stat-lbl">最高海拔</div></div>
      `;
    }
  }

  for (const r of routes) totalGain += Number(r.elevation_gain_m) || 0;

  const summaryEl = document.getElementById('home-summary-stats');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <span>全库 <strong>${routes.length}</strong> 条归档路线</span>
      <span>总里程 <strong>${totalKm.toFixed(1)} km</strong></span>
      <span>累计爬升 <strong>${Math.round(totalGain).toLocaleString()} m</strong></span>
      <span>最高海拔 <strong>${maxEle ? `${maxEle} m` : '-'}</strong></span>
    `;
  }
}

/* ==================== PAGE 2: CATEGORY SUBPAGE ==================== */
function renderCategoryControls() {
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
    diffSel.innerHTML = `<option value="all">全部难度</option>` +
      levels.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    diffSel.value = state.difficultyFilter;
  }
}

function getFilteredCategoryRoutes() {
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

function renderCategoryList() {
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
      card.addEventListener('dblclick', () => openDetailForArchived(card.dataset.id));
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
              ${item.error ? `<span style="color:#ff7b72;">解析失败</span>` : `<span><b>${item.distance_km ?? 0}</b> km</span><span>POI <b>${item.waypoints_count ?? 0}</b></span>`}
            </div>
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.route-card').forEach((card) => {
      card.addEventListener('click', () => selectInboxItem(card.dataset.file));
      card.addEventListener('dblclick', () => openDetailForInbox(card.dataset.file));
    });
  } else {
    // local
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
    listEl.querySelector('#btn-local-clear')?.addEventListener('click', () => clearLocalRoutes());
    listEl.querySelectorAll('.route-card[data-local-id]').forEach((card) => {
      card.addEventListener('click', () => selectLocalRoute(card.dataset.localId, true));
      card.addEventListener('dblclick', () => openDetailForLocal(card.dataset.localId));
    });
    listEl.querySelectorAll('[data-remove-local]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeLocalRoute(btn.dataset.removeLocal);
      });
    });
  }
}

async function renderCategoryOverviewOnMap(fit = false) {
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

function renderGeojsonOnMap(targetGroup, targetMap, fc, category, fit = true, overrideColor = null) {
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
          switchDetailTab('edit');
          openPoiEditor(poiIdx);
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

function getCurrentQcReport(fc, entry) {
  if (fc?.properties?.qc) return fc.properties.qc;
  return inspectGeojson(fc, entry?.category || null);
}

function renderQcMarkersOnLayer(targetGroup, targetMap, qc, activeIssueId = null, focusActive = false) {
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

function showPreviewCard(entry, category) {
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

function hidePreviewCard() {
  document.getElementById('map-preview-card')?.classList.remove('visible');
}

async function selectArchivedRoute(routeId, fit = true) {
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

async function selectInboxItem(relFile, fit = true) {
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

function selectLocalRoute(localId, fit = true) {
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

function guessCategoryFromSummary(summary) {
  const txt = `${summary.file} ${(summary.poi_names || []).join(' ')} ${(summary.sample_descriptions || []).join(' ')}`.toLowerCase();
  if (/越野|穿越|无人区|坦克|牧马人|素车|炮弹坑|涉水|4x4|offroad/.test(txt)) return 'offroad';
  if (/骑行|公路车|山地车|砾石|绿道|cycling|bike|gravel/.test(txt)) return 'cycling';
  return 'hiking';
}

/* ==================== USER GEOLOCATION ON MAP ==================== */
function setUserMapCenter(lat, lng, label = '当前参考位置') {
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

  // Subtle 50km ambient ring for spatial context around user
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

function locateUserOnMap() {
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

function togglePickCenterMode(forceVal) {
  state.pickCenterMode = typeof forceVal === 'boolean' ? forceVal : !state.pickCenterMode;
  if (state.pickCenterMode && state.addPoiMode) toggleAddPoiMode(false);
  document.getElementById('btn-pick-center')?.classList.toggle('active', state.pickCenterMode);
  document.getElementById('map')?.classList.toggle('crosshair-mode', state.pickCenterMode);
  if (state.pickCenterMode) showToast('请在地图上点击想要查看周边的中心位置');
}

/* ==================== PAGE 3: STANDALONE LEADERBOARD ==================== */
function renderLeaderboardPage() {
  const routes = state.catalog.routes || [];
  const yearsSet = new Set();
  for (const r of routes) {
    if (r.year && String(r.year).trim()) yearsSet.add(String(r.year).trim());
  }
  const years = Array.from(yearsSet).sort().reverse();
  const yearSel = document.getElementById('lb-year-filter');
  if (yearSel) {
    const prevVal = state.lbYear;
    yearSel.innerHTML = `<option value="all">全部榜单</option>` +
      years.map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)} 年度</option>`).join('');
    yearSel.value = years.includes(prevVal) || prevVal === 'all' ? prevVal : 'all';
    state.lbYear = yearSel.value;
  }

  let scoped = routes.filter((r) => {
    if (state.lbCat !== 'all' && r.category !== state.lbCat) return false;
    if (state.lbYear !== 'all' && String(r.year || '').trim() !== state.lbYear) return false;
    return true;
  });

  const metricKey = state.lbMetric;
  scoped = [...scoped].sort((a, b) => (Number(b[metricKey]) || 0) - (Number(a[metricKey]) || 0));

  const totalKm = scoped.reduce((s, r) => s + (Number(r.distance_km) || 0), 0);
  const totalGain = scoped.reduce((s, r) => s + (Number(r.elevation_gain_m) || 0), 0);
  const maxEle = scoped.reduce((m, r) => Math.max(m, Number(r.max_ele_m) || 0), 0);

  document.getElementById('lb-summary-strip').innerHTML = `
    <div class="lb-kpi"><div class="lb-kpi-val">${scoped.length}</div><div class="lb-kpi-lbl">上榜路线数</div></div>
    <div class="lb-kpi"><div class="lb-kpi-val">${totalKm.toFixed(1)} km</div><div class="lb-kpi-lbl">累计里程</div></div>
    <div class="lb-kpi"><div class="lb-kpi-val">${Math.round(totalGain).toLocaleString()} m</div><div class="lb-kpi-lbl">累计爬升</div></div>
    <div class="lb-kpi"><div class="lb-kpi-val">${maxEle ? `${maxEle} m` : '-'}</div><div class="lb-kpi-lbl">最高触达海拔</div></div>
  `;

  // Category breakdown bar
  const catKms = {
    offroad: scoped.filter((r) => r.category === 'offroad').reduce((s, r) => s + (Number(r.distance_km) || 0), 0),
    cycling: scoped.filter((r) => r.category === 'cycling').reduce((s, r) => s + (Number(r.distance_km) || 0), 0),
    hiking: scoped.filter((r) => r.category === 'hiking').reduce((s, r) => s + (Number(r.distance_km) || 0), 0)
  };
  const sumCatKm = Math.max(0.01, catKms.offroad + catKms.cycling + catKms.hiking);
  document.getElementById('lb-cat-bar-wrap').innerHTML = `
    <div style="font-size:12px; font-weight:600; color:#cbd5e1;">三大类里程占比</div>
    <div class="lb-cat-bar">
      <div style="width:${(catKms.offroad / sumCatKm) * 100}%; background:#E85D04;" title="越野穿越"></div>
      <div style="width:${(catKms.cycling / sumCatKm) * 100}%; background:#0EA5E9;" title="自行车"></div>
      <div style="width:${(catKms.hiking / sumCatKm) * 100}%; background:#16A34A;" title="徒步"></div>
    </div>
    <div class="lb-cat-legend">
      <span><i class="nav-dot" style="background:#E85D04"></i> 越野穿越 ${catKms.offroad.toFixed(1)} km (${Math.round((catKms.offroad / sumCatKm) * 100)}%)</span>
      <span><i class="nav-dot" style="background:#0EA5E9"></i> 自行车 ${catKms.cycling.toFixed(1)} km (${Math.round((catKms.cycling / sumCatKm) * 100)}%)</span>
      <span><i class="nav-dot" style="background:#16A34A"></i> 徒步 ${catKms.hiking.toFixed(1)} km (${Math.round((catKms.hiking / sumCatKm) * 100)}%)</span>
    </div>
  `;

  const podiumEl = document.getElementById('lb-podium');
  const tableEl = document.getElementById('lb-table');

  if (!scoped.length) {
    podiumEl.innerHTML = '';
    tableEl.innerHTML = '<div class="empty-hint">当前筛选条件下暂无上榜路线。</div>';
    return;
  }

  const medals = ['🥇 TOP 1', '🥈 TOP 2', '🥉 TOP 3'];
  const top3 = scoped.slice(0, 3);
  podiumEl.innerHTML = top3.map((r, i) => {
    const color = getCatColor(r.category);
    const spark = renderMiniSparklineSvg(r.ele_profile_preview, color, 110, 32);
    return `
      <div class="podium-card rank-${i + 1}" data-lb-id="${escapeHtml(r.id)}">
        <div class="podium-top">
          <span>${medals[i]}</span>
          <span class="badge" style="color:${color}; border-color:${color}66;">${escapeHtml(getCatLabel(r.category))}</span>
        </div>
        <div>
          <div class="podium-name">${escapeHtml(r.name)}</div>
          <div style="font-size:11.5px; color:var(--text-muted); margin-top:3px;">
            ${[r.region, r.sub_type, r.year ? `${r.year}年` : ''].filter(Boolean).join(' · ') || '归档路线'}
          </div>
        </div>
        <div class="podium-metrics">
          <div>
            <div>里程 <b>${r.distance_km ?? 0} km</b></div>
            <div>爬升 <b>↑${r.elevation_gain_m ?? '-'} m</b> · 最高 <b>${r.max_ele_m ?? '-'} m</b></div>
          </div>
          ${spark}
        </div>
      </div>
    `;
  }).join('');

  const rest = scoped.slice(3);
  tableEl.innerHTML = rest.map((r, i) => {
    const rank = i + 4;
    const color = getCatColor(r.category);
    const spark = renderMiniSparklineSvg(r.ele_profile_preview, color, 74, 22);
    return `
      <div class="lb-row" data-lb-id="${escapeHtml(r.id)}">
        <div class="lb-rank-num">#${rank}</div>
        <div>
          <div style="font-weight:700; color:#fff; font-size:13.5px;">${escapeHtml(r.name)}</div>
          <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
            <span style="color:${color}; font-weight:600;">${escapeHtml(getCatLabel(r.category))}</span>
            ${r.region ? ` · ${escapeHtml(r.region)}` : ''}
            ${r.year ? ` · ${escapeHtml(r.year)}年` : ''}
          </div>
        </div>
        <div style="font-family:var(--mono); font-size:12px; color:#cbd5e1;">
          <b>${r.distance_km ?? 0}</b> km · ↑<b>${r.elevation_gain_m ?? '-'}</b> m · ⛰️<b>${r.max_ele_m ?? '-'}m</b>
        </div>
        <div>${spark}</div>
        <button type="button" class="icon-btn" style="font-size:11.5px;">3D 拆解 →</button>
      </div>
    `;
  }).join('');

  document.querySelectorAll('[data-lb-id]').forEach((el) => {
    el.addEventListener('click', () => {
      state.returnPage = 'leaderboard';
      openDetailForArchived(el.dataset.lbId);
    });
  });
}

/* ==================== PAGE 4: L-SHAPED DETAIL BREAKDOWN ==================== */
function ensureDetailModules() {
  if (!terrainViewer) {
    const container = document.getElementById('terrain-3d-container');
    terrainViewer = new TerrainBlockViewer(container, {
      poiColors: POI_COLORS,
      onStatusChange: (st) => {
        const pill = document.getElementById('terrain-3d-status');
        if (pill) pill.textContent = st.message || '';
      }
    });
  }

  if (!profileChart) {
    const host = document.getElementById('profile-chart-host');
    profileChart = new ElevationProfileChart(host, {
      poiColors: POI_COLORS,
      onHover: (pt) => {
        if (!pt) {
          terrainViewer?.setHoverLngLat(null, null);
          if (minimapHoverDot && minimap?.hasLayer(minimapHoverDot)) {
            minimap.removeLayer(minimapHoverDot);
          }
          return;
        }
        terrainViewer?.setHoverLngLat(pt.lng, pt.lat);
        if (minimap) {
          if (!minimapHoverDot) {
            minimapHoverDot = L.circleMarker([pt.lat, pt.lng], {
              radius: 5,
              color: '#ffffff',
              weight: 2,
              fillColor: '#38bdf8',
              fillOpacity: 1
            });
          } else {
            minimapHoverDot.setLatLng([pt.lat, pt.lng]);
          }
          if (!minimap.hasLayer(minimapHoverDot)) minimapHoverDot.addTo(minimap);
        }
      }
    });
  }

  if (!minimap) {
    minimap = L.map('detail-minimap', {
      zoomControl: false,
      attributionControl: false,
      center: [30.65, 104.06],
      zoom: 12
    });
    minimapLayerGroup = L.layerGroup().addTo(minimap);
    minimapQcLayerGroup = L.layerGroup().addTo(minimap);
    const { layer } = createBasemapLayer('esri-sat', true);
    minimapBasemapLayer = layer.addTo(minimap);
    if (typeof minimapBasemapLayer.bringToBack === 'function') minimapBasemapLayer.bringToBack();

    minimap.on('click', (ev) => {
      if (!detailAddPoiMode || state.readonly || state.selectedMode === 'local') return;
      detailAddPoiMode = false;
      document.getElementById('detail-minimap')?.classList.remove('crosshair-mode');
      switchDetailTab('edit');
      openPoiEditor(null, ev.latlng);
    });
  }
}

async function openDetailForArchived(routeId) {
  const entry = (state.catalog.routes || []).find((r) => r.id === routeId);
  if (!entry) return;
  try {
    const fc = await fetchRouteGeojson(entry);
    state.selectedMode = 'archived';
    state.selectedId = routeId;
    state.selectedInboxFile = null;
    state.selectedLocalId = null;
    state.activeCat = entry.category;
    await enterDetailView(entry, fc, false, false);
  } catch (err) {
    showToast(`打开拆解页失败: ${err.message}`);
  }
}

async function openDetailForInbox(relFile) {
  await selectInboxItem(relFile, false);
  if (state.currentEntry && state.currentGeojson) {
    await enterDetailView(state.currentEntry, state.currentGeojson, true, false);
  }
}

async function openDetailForLocal(localId) {
  selectLocalRoute(localId, false);
  if (state.currentEntry && state.currentGeojson) {
    await enterDetailView(state.currentEntry, state.currentGeojson, false, true);
  }
}

async function enterDetailView(entry, fc, isInbox, isLocal) {
  state.currentEntry = entry;
  state.currentGeojson = fc;
  state.editingPoiIndex = null;
  state.pendingNewPoiCoords = null;
  state.qcActiveIssueId = null;
  state.qcOriginalSnapshot = null;
  state.currentQc = getCurrentQcReport(fc, entry);

  showPage('detail');
  ensureDetailModules();

  const detailRoot = document.getElementById('view-detail');
  detailRoot.classList.toggle('local-preview-mode', Boolean(isLocal));

  // Sub-header info
  const catColor = entry._color || getCatColor(entry.category);
  const catBadge = document.getElementById('detail-cat-badge');
  catBadge.textContent = isInbox ? '待分类 Inbox' : (isLocal ? '本地预览' : getCatLabel(entry.category));
  catBadge.style.color = catColor;
  catBadge.style.borderColor = `${catColor}66`;

  document.getElementById('detail-route-title').textContent = entry.name || '未命名路线';

  const regBadge = document.getElementById('detail-region-badge');
  if (entry.region) {
    regBadge.textContent = entry.region;
    regBadge.style.display = 'inline-block';
  } else {
    regBadge.style.display = 'none';
  }

  const yrBadge = document.getElementById('detail-year-badge');
  if (entry.year) {
    yrBadge.textContent = `${entry.year} 年`;
    yrBadge.style.display = 'inline-block';
  } else {
    yrBadge.style.display = 'none';
  }

  // Render initial profile from raw track coordinates
  let analysis = buildRouteAnalysis(fc, null);
  state.currentAnalysis = analysis;
  renderDetailAnalysis(entry, analysis);
  profileChart.setAnalysis(analysis);

  // Sync 2D minimap & QC markers
  renderGeojsonOnMap(minimapLayerGroup, minimap, fc, isInbox ? 'inbox' : (isLocal ? 'local' : entry.category), true, entry._color);
  renderQcMarkersOnLayer(minimapQcLayerGroup, minimap, state.currentQc, null, false);
  setTimeout(() => minimap?.invalidateSize({ pan: false }), 60);

  // Populate edit form & QC tab
  populateDetailEditForm(entry, isInbox, isLocal);
  renderDetailQcTab();

  // Load 3D Terrain Block (and backfill elevation if KML had no Z!)
  await terrainViewer.loadRoute(fc, {
    categoryColor: catColor,
    routeName: entry.name || ''
  });

  if (state.currentGeojson === fc && !analysis.hasElevation && terrainViewer.demLoaded) {
    analysis = buildRouteAnalysis(fc, (lng, lat) => terrainViewer.sampleElevation(lng, lat));
    state.currentAnalysis = analysis;
    renderDetailAnalysis(entry, analysis);
    profileChart.setAnalysis(analysis);
  }
}

function renderDetailAnalysis(entry, analysis) {
  const srcNote = analysis.eleSource === 'dem'
    ? '⚡ 已自动使用在线 DEM 补全轨迹高程 · 拖拽框选区间测坡'
    : '支持鼠标滑动联动 3D 光标 · 拖拽框选区间测坡（双击清除）';
  document.getElementById('profile-ele-source').textContent = srcNote;

  const minE = analysis.minEleM ?? entry.min_ele_m;
  const maxE = analysis.maxEleM ?? entry.max_ele_m;
  const gain = analysis.gainM ?? entry.elevation_gain_m;
  const loss = analysis.lossM ?? entry.elevation_loss_m;

  document.getElementById('detail-hero-metrics').innerHTML = `
    <div class="hero-num-pair">
      <div>
        <div class="hero-num-val">${analysis.totalKm || entry.distance_km || 0} <span style="font-size:13px; color:var(--text-muted);">km</span></div>
        <div class="hero-num-lbl">轨迹总里程</div>
      </div>
      <div>
        <div class="hero-num-val">+${gain != null ? gain.toLocaleString() : '-'} <span style="font-size:13px; color:var(--text-muted);">m</span></div>
        <div class="hero-num-lbl">累计爬升</div>
      </div>
    </div>
    <div class="sub-metrics-grid">
      <div class="sub-metric-row"><span>累计下降</span><b>-${loss != null ? loss.toLocaleString() : '-'} m</b></div>
      <div class="sub-metric-row"><span>海拔跨度</span><b>${minE ?? '-'}~${maxE ?? '-'}m</b></div>
      <div class="sub-metric-row"><span>平均坡度</span><b>${analysis.avgGradePct ?? 0}%</b></div>
      <div class="sub-metric-row"><span>最大坡度</span><b>${analysis.maxGradePct ?? 0}%</b></div>
    </div>
  `;

  // Breakdown Tab
  const totalKm = Math.max(0.01, analysis.totalKm);
  const altHtml = analysis.altitudeBands.length
    ? analysis.altitudeBands.map((b) => {
      const pct = Math.min(100, Math.round((b.km / totalKm) * 100));
      return `
        <div class="dist-bar-row">
          <div class="dist-bar-head"><span>${b.label}</span><span>${b.km.toFixed(1)} km (${pct}%)</span></div>
          <div class="dist-bar-track"><div class="dist-bar-fill" style="width:${pct}%; background:${b.color};"></div></div>
        </div>
      `;
    }).join('')
    : '<div style="font-size:11.5px; color:var(--text-muted);">暂无海拔分布数据</div>';

  const gradeHtml = analysis.gradeBands.map((b) => {
    const pct = Math.min(100, Math.round((b.km / totalKm) * 100));
    return `
      <div class="dist-bar-row">
        <div class="dist-bar-head"><span>${b.label}</span><span>${b.km.toFixed(1)} km (${pct}%)</span></div>
        <div class="dist-bar-track"><div class="dist-bar-fill" style="width:${pct}%; background:${b.color};"></div></div>
      </div>
    `;
  }).join('');

  const seasonsTxt = Array.isArray(entry.season) && entry.season.length ? entry.season.join(' · ') : '未标注';
  document.getElementById('dtab-breakdown').innerHTML = `
    <div>
      <div class="stat-section-title">海拔区间分布</div>
      ${altHtml}
    </div>
    <div>
      <div class="stat-section-title">坡度分级分布</div>
      ${gradeHtml}
    </div>
    <div>
      <div class="stat-section-title">路线信息与备注</div>
      <div style="background:var(--bg-card); border:1px solid var(--border); border-radius:7px; padding:10px; font-size:12px; line-height:1.6; color:#cbd5e1;">
        <div><b>适行季节：</b>${escapeHtml(seasonsTxt)}</div>
        ${entry.difficulty ? `<div><b>难度评级：</b>${escapeHtml(entry.difficulty)}</div>` : ''}
        ${entry.notes ? `<div style="margin-top:6px; white-space:pre-wrap;">${escapeHtml(entry.notes)}</div>` : '<div style="margin-top:4px; color:var(--text-muted);">暂无路线备注</div>'}
      </div>
    </div>
  `;

  // POI Timeline Tab
  const pois = analysis.projectedPois || [];
  document.getElementById('detail-poi-cnt').textContent = String(pois.length);
  const poiListEl = document.getElementById('detail-poi-list');
  if (!pois.length) {
    poiListEl.innerHTML = '<div style="font-size:12px; color:var(--text-muted); padding:10px 0;">该路线暂无 POI 路点。</div>';
  } else {
    poiListEl.innerHTML = pois.map((p) => {
      const col = POI_COLORS[p.poiKind] || POI_COLORS.waypoint;
      return `
        <div class="poi-tl-item" data-poi-idx="${p.poiIdx}" data-lng="${p.lng}" data-lat="${p.lat}" data-km="${p.distKm}">
          <div class="poi-tl-head">
            <span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};margin-right:6px;"></i>${escapeHtml(p.name)}</span>
            <span class="badge">${escapeHtml(getPoiLabel(p.poiKind))}</span>
          </div>
          <div class="poi-tl-meta">KM ${p.distKm.toFixed(1)}${p.ele != null ? ` · ${p.ele} m` : ''}</div>
          ${p.description ? `<div style="margin-top:4px; font-size:11px; color:var(--text-muted);">${escapeHtml(p.description)}</div>` : ''}
        </div>
      `;
    }).join('');

    poiListEl.querySelectorAll('.poi-tl-item').forEach((el) => {
      el.addEventListener('click', () => {
        const lng = Number(el.dataset.lng);
        const lat = Number(el.dataset.lat);
        const km = Number(el.dataset.km);
        terrainViewer?.focusLngLat(lng, lat);
        profileChart?.highlightDistKm(km);
        minimap?.setView([lat, lng], Math.max(minimap.getZoom(), 14));
      });
      el.addEventListener('dblclick', () => {
        if (!state.readonly && state.selectedMode !== 'local') {
          switchDetailTab('edit');
          openPoiEditor(Number(el.dataset.poiIdx));
        }
      });
    });
  }
}

function switchDetailTab(tabName) {
  state.detailTab = tabName;
  document.querySelectorAll('.detail-tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.dtab === tabName);
  });
  document.getElementById('dtab-breakdown').style.display = tabName === 'breakdown' ? 'flex' : 'none';
  document.getElementById('dtab-breakdown').style.flexDirection = 'column';
  document.getElementById('dtab-breakdown').style.gap = '14px';
  document.getElementById('dtab-pois').style.display = tabName === 'pois' ? 'flex' : 'none';
  document.getElementById('dtab-qc').style.display = tabName === 'qc' ? 'flex' : 'none';
  document.getElementById('dtab-edit').style.display = tabName === 'edit' ? 'flex' : 'none';
}

function updateDetailQcBadge(qc) {
  const pill = document.getElementById('detail-qc-cnt');
  if (!pill) return;
  const cnt = qc?.issues_count ?? 0;
  const st = qc?.status || 'passed';
  pill.className = `qc-tab-pill ${st}`;
  pill.textContent = cnt > 0 ? String(cnt) : '✓';
}

async function rerunQcWithThresholds(overrides) {
  const entry = state.currentEntry;
  const fc = state.currentGeojson;
  if (!entry || !fc) return;

  try {
    let nextQc = null;
    if (state.selectedMode === 'local' && Array.isArray(entry._qcSegments)) {
      nextQc = inspectTrackSegments(entry._qcSegments, entry.category, overrides);
    } else if (!state.readonly && (state.selectedMode === 'archived' || state.selectedMode === 'inbox')) {
      const payload = state.selectedMode === 'inbox'
        ? { mode: 'inbox', file: state.selectedInboxFile, category: entry.category, thresholds: overrides }
        : { mode: 'archived', id: state.selectedId, category: entry.category, thresholds: overrides };
      const res = await fetchJson('/api/kmls/qc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      nextQc = res.qc;
    } else {
      nextQc = inspectGeojson(fc, entry.category, overrides);
      showToast('静态模式下仅按 GeoJSON 几何坐标复检（无原始时间戳）');
    }

    state.currentQc = nextQc;
    state.qcActiveIssueId = null;
    if (fc.properties) fc.properties.qc = nextQc;
    renderDetailQcTab();
    renderQcMarkersOnLayer(minimapQcLayerGroup, minimap, nextQc, null, false);
    renderQcMarkersOnLayer(qcMapLayerGroup, map, nextQc, null, false);
    if (nextQc.issues_count === 0) showToast('复检完成：未发现异常点');
    else showToast(`复检完成：检出 ${nextQc.issues_count} 处异常`);
  } catch (err) {
    showToast(`重新质检失败: ${err.message}`);
  }
}

async function refreshViewsAfterQcClean(nextEntry, nextFc, nextQc) {
  state.currentEntry = nextEntry;
  state.currentGeojson = nextFc;
  state.currentQc = nextQc;
  state.qcActiveIssueId = null;

  const isInbox = state.selectedMode === 'inbox';
  const isLocal = state.selectedMode === 'local';
  const cat = isInbox ? 'inbox' : (isLocal ? 'local' : nextEntry.category);
  const catColor = nextEntry._color || getCatColor(nextEntry.category);

  let analysis = buildRouteAnalysis(nextFc, terrainViewer?.demLoaded ? (lng, lat) => terrainViewer.sampleElevation(lng, lat) : null);
  state.currentAnalysis = analysis;
  renderDetailAnalysis(nextEntry, analysis);
  profileChart?.setAnalysis(analysis);

  renderGeojsonOnMap(minimapLayerGroup, minimap, nextFc, cat, false, nextEntry._color);
  renderQcMarkersOnLayer(minimapQcLayerGroup, minimap, nextQc, null, false);
  renderGeojsonOnMap(activeLayerGroup, map, nextFc, cat, false, nextEntry._color);
  renderQcMarkersOnLayer(qcMapLayerGroup, map, nextQc, null, false);
  renderDetailQcTab();

  if (terrainViewer) {
    await terrainViewer.loadRoute(nextFc, {
      categoryColor: catColor,
      routeName: nextEntry.name || ''
    });
  }
}

async function applyQcPointRemoval(targets) {
  const entry = state.currentEntry;
  const fc = state.currentGeojson;
  const qc = state.currentQc;
  if (!entry || !fc || !targets?.length) return;

  if (!state.qcOriginalSnapshot) {
    state.qcOriginalSnapshot = {
      entry: {
        ...entry,
        _qcSegments: Array.isArray(entry._qcSegments)
          ? entry._qcSegments.map((s) => ({ ...s, points: [...s.points], times: [...(s.times || [])] }))
          : undefined
      },
      geojson: JSON.parse(JSON.stringify(fc)),
      qc: JSON.parse(JSON.stringify(qc))
    };
  }

  const { geojson: nextFc, qcSegments: nextSegs, removedCount } = removeAnomalyPoints(
    fc,
    entry._qcSegments || null,
    targets
  );
  if (!removedCount) {
    showToast('未能移除目标点（轨迹段至少需保留 2 个顶点）');
    return;
  }

  const routeFeats = (nextFc.features || []).filter((f) => f.geometry?.type === 'LineString');
  const poiFeats = (nextFc.features || []).filter((f) => f.geometry?.type === 'Point');
  const nextMetrics = computeMetrics(routeFeats, poiFeats);
  const thresholds = qc?.thresholds || null;
  const nextQc = nextSegs
    ? inspectTrackSegments(nextSegs, entry.category, thresholds)
    : inspectGeojson(nextFc, entry.category, thresholds);
  nextFc.properties = { ...(nextFc.properties || {}), ...nextMetrics, qc: nextQc };

  const nextEntry = {
    ...entry,
    ...nextMetrics,
    qc_status: nextQc.status,
    qc_issues_count: nextQc.issues_count,
    ...(nextSegs ? { _qcSegments: nextSegs } : {})
  };

  await refreshViewsAfterQcClean(nextEntry, nextFc, nextQc);
  showToast(`已剔除 ${removedCount} 个异常点（可在「标注与导出」下载清洗后 KML/GPX）`);
}

async function restoreOriginalRouteFromQc() {
  const snap = state.qcOriginalSnapshot;
  if (!snap) return;
  state.qcOriginalSnapshot = null;
  await refreshViewsAfterQcClean(snap.entry, snap.geojson, snap.qc);
  showToast('已还原清洗前的原始轨迹');
}

function renderDetailQcTab() {
  const container = document.getElementById('dtab-qc');
  const qc = state.currentQc;
  updateDetailQcBadge(qc);
  if (!container || !qc) return;

  const cfg = qc.thresholds || {};
  const statusLabels = {
    passed: '✅ 轨迹质检通过',
    warning: `⚠️ 检出 ${qc.issues_count} 处疑似异常`,
    error: `🚨 检出 ${qc.issues_count} 处异常点`
  };
  const fixableIssues = (qc.issues || []).filter((it) => QC_TYPE_META[it.type]?.fixable && it.point_index > 0);
  const tsModeLabel = qc.has_timestamps
    ? `含时间戳 (${qc.timed_points}/${qc.total_points} 点)`
    : '无时间戳 (仅几何/高程校验)';

  const issuesHtml = qc.issues?.length
    ? qc.issues.map((issue) => {
      const activeCls = state.qcActiveIssueId === issue.id ? 'active' : '';
      const sevCls = issue.severity === 'error' ? 'sev-error' : 'sev-warning';
      const sevText = issue.severity === 'error' ? '严重' : '疑似';
      const fixable = Boolean(QC_TYPE_META[issue.type]?.fixable && issue.point_index > 0);
      const statLine = [
        issue.distance_m != null ? `${issue.distance_m}m` : null,
        issue.dt_s != null ? `${issue.dt_s}s` : null,
        issue.speed_kmh != null ? `${issue.speed_kmh}km/h` : null
      ].filter(Boolean).join(' · ');

      return `
        <div class="qc-issue-item ${sevCls} ${activeCls}" data-qc-id="${escapeHtml(issue.id)}">
          <div class="qc-issue-head">
            <span>${escapeHtml(issue.type_label || issue.type)}</span>
            <span class="badge ${issue.severity === 'error' ? 'qc-error' : 'qc-warning'}">${sevText}</span>
          </div>
          <div class="qc-issue-msg">${escapeHtml(issue.message)}</div>
          <div class="qc-issue-sub">
            <span>#${issue.segment_index} · 点 ${issue.point_index}${statLine ? ` · ${escapeHtml(statLine)}` : ''}</span>
            ${fixable ? `<button type="button" class="icon-btn" data-qc-fix-one="${escapeHtml(issue.id)}" style="padding:1px 7px; font-size:10.5px;" title="从当前预览轨迹剔除此点">剔除</button>` : ''}
          </div>
        </div>
      `;
    }).join('')
    : '<div style="font-size:12px; color:#3fb950; padding:10px 4px; text-align:center;">所有轨迹点间距、时间与高程均在正常范围内。</div>';

  container.innerHTML = `
    <div class="qc-summary-card status-${escapeHtml(qc.status)}">
      <div class="qc-summary-head">
        <span>${escapeHtml(statusLabels[qc.status] || qc.status)}</span>
        <span class="badge">${escapeHtml(tsModeLabel)}</span>
      </div>
      <div class="qc-meta-grid">
        <div>总点数: <b>${qc.total_points ?? 0}</b></div>
        <div>最高瞬时速度: <b>${qc.max_speed_kmh != null ? `${qc.max_speed_kmh} km/h` : '-'}</b></div>
        <div>最大单步位移: <b>${qc.max_step_dist_m != null ? `${qc.max_step_dist_m} m` : '-'}</b></div>
        <div>严重 / 疑似: <b>${qc.error_count ?? 0} / ${qc.warning_count ?? 0}</b></div>
      </div>
    </div>

    <details class="qc-config-details">
      <summary>⚙️ 质检阈值参数（距离 / 时间 / 速度）</summary>
      <div class="qc-config-grid">
        <label>最大速度 (km/h)
          <input type="number" id="qc-cfg-speed" step="5" min="1" value="${cfg.max_speed_kmh ?? 120}" />
        </label>
        <label>零耗时跳变 (m)
          <input type="number" id="qc-cfg-zerodt" step="10" min="1" value="${cfg.zero_dt_dist_m ?? 50}" />
        </label>
        <label>短时窗口 (s)
          <input type="number" id="qc-cfg-short-s" step="1" min="0.5" value="${cfg.short_time_s ?? 5}" />
        </label>
        <label>短时大距离 (m)
          <input type="number" id="qc-cfg-short-m" step="10" min="10" value="${cfg.short_time_dist_m ?? 150}" />
        </label>
        <label>毛刺单臂 (m)
          <input type="number" id="qc-cfg-spike" step="20" min="10" value="${cfg.spike_dist_m ?? 150}" />
        </label>
        <label>断点跨度 (m)
          <input type="number" id="qc-cfg-gap" step="500" min="100" value="${cfg.max_gap_m ?? 5000}" />
        </label>
      </div>
      <div style="margin-top:8px; display:flex; justify-content:flex-end;">
        <button type="button" id="btn-qc-rerun" class="btn-primary" style="flex:0 0 auto; padding:4px 12px; font-size:11.5px;">🔍 按新阈值重新质检</button>
      </div>
    </details>

    <div class="qc-actions-row">
      <label class="hillshade-toggle" style="font-size:11.5px; margin-right:auto;">
        <input type="checkbox" id="toggle-qc-markers" ${state.qcShowOnMap ? 'checked' : ''} />
        <span>🗺️ 地图标出异常点</span>
      </label>
      ${fixableIssues.length ? `<button type="button" id="btn-qc-fix-all" class="btn-danger" style="flex:0 0 auto; padding:4px 9px; font-size:11px;">🧹 一键剔除 (${fixableIssues.length})</button>` : ''}
      ${state.qcOriginalSnapshot ? `<button type="button" id="btn-qc-restore" class="icon-btn" style="padding:4px 9px; font-size:11px;">↩️ 还原</button>` : ''}
    </div>

    ${state.qcOriginalSnapshot ? '<div style="font-size:11px; color:#58a6ff; background:rgba(56,139,253,0.1); border:1px solid rgba(56,139,253,0.3); border-radius:6px; padding:6px 8px;">已预览清洗轨迹：可直接点击顶部「导出 KML / GPX」保存洁净轨迹。</div>' : ''}

    <div class="qc-issue-list">${issuesHtml}</div>
    ${qc.truncated ? `<div style="font-size:11px; color:var(--text-muted);">仅展示前 ${qc.issues.length} 条（共 ${qc.issues_count} 条异常）</div>` : ''}
  `;

  container.querySelector('#toggle-qc-markers')?.addEventListener('change', (e) => {
    state.qcShowOnMap = Boolean(e.target.checked);
    renderQcMarkersOnLayer(minimapQcLayerGroup, minimap, state.currentQc, state.qcActiveIssueId, false);
    renderQcMarkersOnLayer(qcMapLayerGroup, map, state.currentQc, state.qcActiveIssueId, false);
  });

  container.querySelector('#btn-qc-rerun')?.addEventListener('click', () => {
    const overrides = {
      max_speed_kmh: Number(container.querySelector('#qc-cfg-speed')?.value),
      zero_dt_dist_m: Number(container.querySelector('#qc-cfg-zerodt')?.value),
      short_time_s: Number(container.querySelector('#qc-cfg-short-s')?.value),
      short_time_dist_m: Number(container.querySelector('#qc-cfg-short-m')?.value),
      spike_dist_m: Number(container.querySelector('#qc-cfg-spike')?.value),
      max_gap_m: Number(container.querySelector('#qc-cfg-gap')?.value)
    };
    rerunQcWithThresholds(overrides);
  });

  container.querySelector('#btn-qc-fix-all')?.addEventListener('click', () => {
    applyQcPointRemoval(fixableIssues.map((it) => ({ segment_index: it.segment_index, point_index: it.point_index })));
  });

  container.querySelector('#btn-qc-restore')?.addEventListener('click', () => {
    restoreOriginalRouteFromQc();
  });

  container.querySelectorAll('.qc-issue-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.qcId;
      const issue = (qc.issues || []).find((it) => it.id === id);
      if (!issue) return;
      state.qcActiveIssueId = id;
      container.querySelectorAll('.qc-issue-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.qcId === id);
      });
      if (Array.isArray(issue.coord) && issue.coord.length >= 2) {
        terrainViewer?.focusLngLat(issue.coord[0], issue.coord[1]);
      }
      renderQcMarkersOnLayer(minimapQcLayerGroup, minimap, qc, id, true);
      renderQcMarkersOnLayer(qcMapLayerGroup, map, qc, id, false);
    });
  });

  container.querySelectorAll('[data-qc-fix-one]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.qcFixOne;
      const issue = (qc.issues || []).find((it) => it.id === id);
      if (issue) {
        applyQcPointRemoval([{ segment_index: issue.segment_index, point_index: issue.point_index }]);
      }
    });
  });
}

function updateCategoryDependentOptions(cat) {
  const cfg = state.schema?.categories?.[cat] || {};
  const subList = document.getElementById('subtype-options');
  const diffList = document.getElementById('difficulty-options');
  if (subList) subList.innerHTML = (cfg.sub_types || []).map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  if (diffList) diffList.innerHTML = (cfg.difficulty_levels || []).map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
}

function renderSeasonGrid(selectedSeasons = [], readonly = state.readonly) {
  const set = new Set(selectedSeasons || []);
  const grid = document.getElementById('season-grid');
  if (!grid) return;
  grid.innerHTML = MONTHS.map((m) =>
    `<div class="season-pill ${set.has(m) ? 'active' : ''}" data-month="${m}">${m}</div>`
  ).join('');
  if (!readonly) {
    grid.querySelectorAll('.season-pill').forEach((el) => {
      el.addEventListener('click', () => el.classList.toggle('active'));
    });
  }
}

function populateDetailEditForm(entry, isInbox, isLocal) {
  const formReadonly = state.readonly || isLocal;
  const saveBtn = document.getElementById('btn-save-meta');
  if (saveBtn) saveBtn.textContent = isInbox ? '📥 分类并归档入库' : '💾 保存标注';

  document.getElementById('f-id').value = entry.id || '';
  document.getElementById('f-category').value = entry.category || 'hiking';
  updateCategoryDependentOptions(entry.category || 'hiking');
  document.getElementById('f-subtype').value = entry.sub_type || '';
  document.getElementById('f-region').value = entry.region || '';
  document.getElementById('f-name').value = entry.name || '';
  document.getElementById('f-difficulty').value = entry.difficulty || '';
  document.getElementById('f-year').value = entry.year || '';
  document.getElementById('f-status').value = entry.status || 'collected';
  document.getElementById('f-notes').value = entry.notes || '';
  renderSeasonGrid(entry.season || [], formReadonly);

  ['f-category', 'f-subtype', 'f-region', 'f-name', 'f-difficulty', 'f-year', 'f-status', 'f-notes'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = formReadonly;
  });

  document.getElementById('poi-editor').style.display = 'none';
}

function getPoiFeatures() {
  if (!state.currentGeojson || !Array.isArray(state.currentGeojson.features)) return [];
  return state.currentGeojson.features.filter((f) => f.properties?.feature_type === 'poi');
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
    const demEle = terrainViewer?.sampleElevation(newLatLng.lng, newLatLng.lat);
    document.getElementById('p-ele').value = Number.isFinite(demEle) ? String(Math.round(demEle)) : '';
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
    _geojsonCache.set(state.selectedId, res.geojson);
    state.currentGeojson = res.geojson;
    state.currentEntry = res.route;
    const idx = (state.catalog.routes || []).findIndex((r) => r.id === state.selectedId);
    if (idx >= 0) state.catalog.routes[idx] = res.route;

    await enterDetailView(res.route, res.geojson, false, false);
  } else {
    renderGeojsonOnMap(activeLayerGroup, map, state.currentGeojson, cat, false);
    if (state.page === 'detail') {
      await enterDetailView(state.currentEntry, state.currentGeojson, state.selectedMode === 'inbox', false);
    }
    showToast('已暂存 POI（归档入库时自动保存）');
  }
}

function stepDetailRoute(delta) {
  if (state.selectedMode !== 'archived' || !state.selectedId) return;
  const list = state.returnPage === 'leaderboard'
    ? [...(state.catalog.routes || [])].sort((a, b) => (b[state.lbMetric] || 0) - (a[state.lbMetric] || 0))
    : getFilteredCategoryRoutes();
  if (list.length < 2) return;
  const idx = list.findIndex((r) => r.id === state.selectedId);
  const nextIdx = (idx + delta + list.length) % list.length;
  openDetailForArchived(list[nextIdx].id);
}

/* ==================== LOCAL KML DRAG & DROP ==================== */
function removeLocalRoute(localId) {
  const idx = state.localRoutes.findIndex((r) => r.id === localId);
  if (idx < 0) return;
  state.localRoutes.splice(idx, 1);
  if (state.selectedMode === 'local' && state.selectedLocalId === localId) {
    activeLayerGroup.clearLayers();
    qcMapLayerGroup.clearLayers();
    hidePreviewCard();
    state.selectedMode = null;
    state.selectedLocalId = null;
    state.currentEntry = null;
    state.currentGeojson = null;
    state.currentQc = null;
  }
  renderCounts();
  renderCategoryList();
  renderCategoryOverviewOnMap(false);
}

function clearLocalRoutes() {
  state.localRoutes = [];
  if (state.selectedMode === 'local') {
    activeLayerGroup.clearLayers();
    qcMapLayerGroup.clearLayers();
    hidePreviewCard();
    state.selectedMode = null;
    state.selectedLocalId = null;
    state.currentEntry = null;
    state.currentGeojson = null;
    state.currentQc = null;
  }
  renderCounts();
  renderCategoryList();
  renderCategoryOverviewOnMap(false);
  showToast('已清空本地预览列表');
}

async function handleLocalFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const imported = [];
  const errors = [];

  for (const file of files) {
    try {
      const { entry, geojson } = await parseLocalRouteFile(file, state.schema);
      const id = `local__${file.name}__${file.size}`;
      const existingIdx = state.localRoutes.findIndex((r) => r.id === id);
      const color = existingIdx >= 0
        ? state.localRoutes[existingIdx].color
        : LOCAL_ROUTE_PALETTE[state.localRoutes.length % LOCAL_ROUTE_PALETTE.length];
      entry._color = color;
      const item = { id, color, entry, geojson };
      if (existingIdx >= 0) state.localRoutes[existingIdx] = item;
      else state.localRoutes.unshift(item);
      imported.push(item);
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  if (imported.length) {
    renderCounts();
    openCategoryPage('local', { resetFilters: false, fitRoutes: false });
    selectLocalRoute(imported[0].id, imported.length === 1);
    if (imported.length > 1) {
      await renderCategoryOverviewOnMap(true);
    }
    showToast(errors.length
      ? `已导入 ${imported.length} 个文件，${errors.length} 个失败`
      : `已导入本地路线：${imported[0].entry.name}`);
  } else if (errors.length) {
    showToast(errors[0]);
  }
}

function setupDragAndDrop() {
  const dropOverlay = document.getElementById('drop-overlay');
  let dragDepth = 0;
  const isFileDrag = (e) => Boolean(e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files'));
  const hideOverlay = () => {
    dragDepth = 0;
    dropOverlay?.classList.remove('active');
  };
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    dropOverlay?.classList.add('active');
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay?.classList.remove('active');
  });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    hideOverlay();
    if (e.dataTransfer?.files?.length) handleLocalFiles(e.dataTransfer.files);
  });
  window.addEventListener('blur', hideOverlay);
}

/* ==================== EXPORT (GPX / KML / GEOJSON) ==================== */
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

function geojsonToKml(fc, routeName, meta = {}) {
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

function exportCurrentRoute(format) {
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

function toggleAddPoiMode(forceVal) {
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

/* ==================== EVENT BINDINGS ==================== */
function bindEvents() {
  // Top navigation
  document.getElementById('brand-home-btn')?.addEventListener('click', openHomePage);
  document.querySelectorAll('.topbar-nav .nav-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nav = btn.dataset.nav;
      if (nav === 'home') openHomePage();
      else if (nav === 'leaderboard') openLeaderboardPage();
      else if (nav.startsWith('cat-')) openCategoryPage(nav.slice(4));
    });
  });

  // Home 3 Big Category Cards
  document.querySelectorAll('.portal-card').forEach((card) => {
    const cat = card.dataset.cat;
    card.addEventListener('mouseenter', () => contourBg?.setAccentColor(getCatColor(cat)));
    card.addEventListener('mouseleave', () => contourBg?.setAccentColor(null));
    card.addEventListener('click', () => openCategoryPage(cat));
  });

  document.getElementById('home-btn-leaderboard')?.addEventListener('click', openLeaderboardPage);
  document.getElementById('home-btn-nearby')?.addEventListener('click', () => {
    const routes = state.catalog.routes || [];
    const firstNonEmpty = CATEGORIES.find((c) => routes.some((r) => r.category === c)) || 'offroad';
    openCategoryPage(firstNonEmpty, { resetFilters: true, fitRoutes: false });
    locateUserOnMap();
  });

  // Sync & local import
  document.getElementById('btn-sync-kmls')?.addEventListener('click', async () => {
    try {
      await fetchJson('/api/kmls/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prune: false })
      });
      _geojsonCache.clear();
      await loadCatalogAndInbox();
      showToast('已扫描同步路线库与待分类 Inbox');
    } catch (err) {
      showToast(`同步失败: ${err.message}`);
    }
  });

  document.getElementById('btn-open-local-kml')?.addEventListener('click', () => {
    document.getElementById('local-kml-input')?.click();
  });
  document.getElementById('local-kml-input')?.addEventListener('change', (e) => {
    if (e.target.files?.length) {
      handleLocalFiles(e.target.files);
      e.target.value = '';
    }
  });
  setupDragAndDrop();

  // Category page filters
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

  // Map toolbar
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

  // Floating preview card actions
  document.getElementById('mpc-close')?.addEventListener('click', hidePreviewCard);
  document.getElementById('mpc-btn-fit')?.addEventListener('click', () => {
    if (state.currentGeojson) {
      const cat = state.selectedMode === 'inbox' ? 'inbox' : (state.selectedMode === 'local' ? 'local' : state.currentEntry?.category);
      renderGeojsonOnMap(activeLayerGroup, map, state.currentGeojson, cat, true, state.currentEntry?._color);
    }
  });
  document.getElementById('mpc-btn-kml')?.addEventListener('click', () => exportCurrentRoute('kml'));
  document.getElementById('mpc-btn-qc')?.addEventListener('click', async () => {
    if (!state.currentEntry || !state.currentGeojson) return;
    if (state.selectedMode === 'archived') await openDetailForArchived(state.selectedId);
    else if (state.selectedMode === 'inbox') await enterDetailView(state.currentEntry, state.currentGeojson, true, false);
    else if (state.selectedMode === 'local') await enterDetailView(state.currentEntry, state.currentGeojson, false, true);
    switchDetailTab('qc');
  });
  document.getElementById('mpc-btn-detail')?.addEventListener('click', () => {
    if (!state.currentEntry || !state.currentGeojson) return;
    if (state.selectedMode === 'archived') openDetailForArchived(state.selectedId);
    else if (state.selectedMode === 'inbox') enterDetailView(state.currentEntry, state.currentGeojson, true, false);
    else if (state.selectedMode === 'local') enterDetailView(state.currentEntry, state.currentGeojson, false, true);
  });

  // Map clicks (pick center OR add POI)
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
      if (state.selectedMode === 'archived') openDetailForArchived(state.selectedId);
      else enterDetailView(state.currentEntry, state.currentGeojson, state.selectedMode === 'inbox', false);
      setTimeout(() => {
        switchDetailTab('edit');
        openPoiEditor(null, ev.latlng);
      }, 120);
    }
  });

  // Leaderboard controls
  document.querySelectorAll('#lb-cat-pills .pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#lb-cat-pills .pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      state.lbCat = pill.dataset.lbCat;
      renderLeaderboardPage();
    });
  });
  document.getElementById('lb-year-filter')?.addEventListener('change', (e) => {
    state.lbYear = e.target.value;
    renderLeaderboardPage();
  });
  document.querySelectorAll('#lb-metric-pills .pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#lb-metric-pills .pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      state.lbMetric = pill.dataset.lbMetric;
      renderLeaderboardPage();
    });
  });

  // Page 4 Detail controls
  document.getElementById('btn-detail-back')?.addEventListener('click', () => {
    if (state.returnPage === 'leaderboard') openLeaderboardPage();
    else openCategoryPage(state.activeCat, { resetFilters: false, fitRoutes: false });
  });
  document.getElementById('btn-detail-prev')?.addEventListener('click', () => stepDetailRoute(-1));
  document.getElementById('btn-detail-next')?.addEventListener('click', () => stepDetailRoute(1));
  document.getElementById('btn-detail-export-kml')?.addEventListener('click', () => exportCurrentRoute('kml'));
  document.getElementById('btn-detail-export-gpx')?.addEventListener('click', () => exportCurrentRoute('gpx'));
  document.querySelectorAll('#export-bar .export-btn').forEach((btn) => {
    btn.addEventListener('click', () => exportCurrentRoute(btn.dataset.export));
  });

  // 3D Stage controls
  document.querySelectorAll('#tex-mode-pills .mini-pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tex-mode-pills .mini-pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      terrainViewer?.setTextureMode(btn.dataset.tex);
    });
  });
  document.getElementById('terrain-exag-slider')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    document.getElementById('terrain-exag-val').textContent = `${val.toFixed(1)}x`;
    terrainViewer?.setExaggeration(val);
  });
  document.querySelectorAll('[data-cam]').forEach((btn) => {
    btn.addEventListener('click', () => terrainViewer?.setCameraPreset(btn.dataset.cam));
  });
  document.getElementById('btn-snapshot-3d')?.addEventListener('click', () => {
    const name = (state.currentEntry?.name || 'terrain-block').replace(/[<>:"/\\|?*]/g, '_');
    const sub = [state.currentEntry?.distance_km ? `${state.currentEntry.distance_km}km` : '', state.currentEntry?.max_ele_m ? `最高 ${state.currentEntry.max_ele_m}m` : ''].filter(Boolean).join(' · ');
    terrainViewer?.exportSnapshotPng(`${name}-3d.png`, `${state.currentEntry?.name || 'Outdoor Routes'}${sub ? `  (${sub})` : ''}`);
  });
  document.getElementById('btn-toggle-minimap')?.addEventListener('click', () => {
    const box = document.getElementById('detail-minimap-box');
    box?.classList.toggle('expanded');
    setTimeout(() => minimap?.invalidateSize({ pan: false }), 200);
  });

  // Detail right tabs
  document.querySelectorAll('.detail-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchDetailTab(btn.dataset.dtab));
  });

  document.getElementById('btn-detail-add-poi')?.addEventListener('click', () => {
    if (state.readonly || state.selectedMode === 'local') return;
    detailAddPoiMode = true;
    document.getElementById('detail-minimap')?.classList.add('crosshair-mode');
    showToast('请在 3D 舞台右下角的 2D 鹰眼图上点击标注 POI（可先点 ⤢ 放大）');
  });

  document.getElementById('f-category')?.addEventListener('change', (e) => {
    updateCategoryDependentOptions(e.target.value);
  });

  document.getElementById('meta-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const seasons = Array.from(document.querySelectorAll('#season-grid .season-pill.active')).map((el) => el.dataset.month);
    const payload = {
      category: document.getElementById('f-category').value,
      sub_type: document.getElementById('f-subtype').value.trim(),
      region: document.getElementById('f-region').value.trim(),
      name: document.getElementById('f-name').value.trim(),
      difficulty: document.getElementById('f-difficulty').value.trim(),
      year: document.getElementById('f-year').value.trim(),
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
        _geojsonCache.clear();
        await loadCatalogAndInbox();
        state.activeCat = newRoute.category;
        await openDetailForArchived(newRoute.id);
        showToast(`已归档至 ${newRoute.raw_file}`);
      } else if (state.selectedMode === 'archived' && state.selectedId) {
        const res = await fetchJson('/api/kmls/update_meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.selectedId, ...payload })
        });
        _geojsonCache.delete(state.selectedId);
        _geojsonCache.delete(res.route.id);
        await loadCatalogAndInbox();
        await openDetailForArchived(res.route.id);
        showToast('路线标注已保存到 catalog.json');
      }
    } catch (err) {
      showToast(`保存失败: ${err.message}`);
    }
  });

  document.getElementById('btn-cancel-poi')?.addEventListener('click', () => {
    document.getElementById('poi-editor').style.display = 'none';
    state.editingPoiIndex = null;
    state.pendingNewPoiCoords = null;
  });

  document.getElementById('btn-save-poi')?.addEventListener('click', async () => {
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

  document.getElementById('btn-delete-poi')?.addEventListener('click', async () => {
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
}

/* ==================== BOOTSTRAP ==================== */
document.addEventListener('DOMContentLoaded', async () => {
  const contourCanvas = document.getElementById('home-contour-canvas');
  if (contourCanvas) {
    contourBg = new ContourBackground(contourCanvas);
  }

  const initBasemap = document.getElementById('basemap-select')?.value || 'openmap-vector';
  setBasemap(initBasemap, false);
  updateHillshade();
  updateHud();
  bindEvents();

  try {
    await loadCatalogAndInbox();
  } catch (err) {
    showToast(`初始化路线库失败: ${err.message}`);
  }
});
