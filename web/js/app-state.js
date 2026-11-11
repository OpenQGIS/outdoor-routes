/**
 * Shared Application State, Constants, API Fetchers & Navigation Registry
 */

export const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
export const CATEGORIES = ['offroad', 'cycling', 'hiking'];
export const LOCAL_ROUTE_PALETTE = ['#d946ef', '#06b6d4', '#f43f5e', '#a855f7', '#eab308', '#22d3ee'];

export const POI_COLORS = {
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

export const DEFAULT_SCHEMA = {
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

export const state = {
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

export const geojsonCache = new Map();

/**
 * Lightweight cross-page action bridge populated during app bootstrap
 * so page modules remain strictly acyclic.
 */
export const actions = {};

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getCatColor(cat) {
  return state.schema?.categories?.[cat]?.color || (cat === 'inbox' ? '#d29922' : '#f59e0b');
}

export function getCatLabel(cat) {
  if (cat === 'inbox') return '待分类 Inbox';
  if (cat === 'local') return '本地预览';
  return state.schema?.categories?.[cat]?.label || cat;
}

export function getPoiLabel(kind) {
  return state.schema?.poi_kinds?.[kind]?.label || kind || '路点';
}

export function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('visible'), 2300);
}

export function encodeRelPath(relPath) {
  return String(relPath || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export async function fetchJson(url, options = {}) {
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

export async function fetchRouteGeojson(entry, forceRefresh = false) {
  if (!forceRefresh && geojsonCache.has(entry.id)) {
    return geojsonCache.get(entry.id);
  }
  let fc;
  if (state.readonly) {
    const res = await fetch(`./kmls/${encodeRelPath(entry.geojson_file)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fc = await res.json();
  } else {
    fc = await fetchJson(`./api/kmls/geojson?id=${encodeURIComponent(entry.id)}`);
  }
  geojsonCache.set(entry.id, fc);
  return fc;
}

export function getPoiFeatures() {
  if (!state.currentGeojson || !Array.isArray(state.currentGeojson.features)) return [];
  return state.currentGeojson.features.filter((f) => f.properties?.feature_type === 'poi');
}

export function guessCategoryFromSummary(summary) {
  const txt = `${summary.file} ${(summary.poi_names || []).join(' ')} ${(summary.sample_descriptions || []).join(' ')}`.toLowerCase();
  if (/越野|穿越|无人区|坦克|牧马人|素车|炮弹坑|涉水|4x4|offroad/.test(txt)) return 'offroad';
  if (/骑行|公路车|山地车|砾石|绿道|cycling|bike|gravel/.test(txt)) return 'cycling';
  return 'hiking';
}
