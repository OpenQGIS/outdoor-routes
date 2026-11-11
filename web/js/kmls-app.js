/**
 * Outdoor Routes — App Coordinator, Router & Data Loader
 */
import {
  DEFAULT_SCHEMA,
  state,
  geojsonCache,
  escapeHtml,
  fetchJson,
  showToast,
  actions
} from './app-state.js';
import { initHomeContour, renderHomeContour, renderHomePortal, bindHomeEvents } from './page-home.js';
import {
  setBasemap,
  updateHillshade,
  updateHud,
  invalidateCategoryMap,
  clearCategorySelectedLayers,
  renderCategoryControls,
  renderCategoryList,
  renderCategoryOverviewOnMap,
  hidePreviewCard,
  locateUserOnMap,
  togglePickCenterMode,
  toggleAddPoiMode,
  bindCategoryEvents
} from './page-category.js';
import { renderLeaderboardPage, bindLeaderboardEvents } from './page-leaderboard.js';
import {
  resizeDetailViews,
  focusDetailCoords,
  syncDetailQcMarkers,
  openDetailForArchived,
  openDetailForInbox,
  openDetailForLocal,
  enterDetailView,
  refreshViewsAfterQcClean,
  switchDetailTab,
  openPoiEditor,
  bindDetailEvents
} from './page-detail.js';
import { removeLocalRoute, clearLocalRoutes, bindLocalImportEvents } from './local-import.js';

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
    renderHomeContour();
  } else if (pageName === 'category') {
    invalidateCategoryMap();
  } else if (pageName === 'leaderboard') {
    renderLeaderboardPage();
  } else if (pageName === 'detail') {
    resizeDetailViews();
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
  if (resetFilters) clearCategorySelectedLayers();
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

function registerActions() {
  Object.assign(actions, {
    showPage,
    openHomePage,
    openCategoryPage,
    openLeaderboardPage,
    loadCatalogAndInbox,
    renderCounts,
    openDetailForArchived,
    openDetailForInbox,
    openDetailForLocal,
    enterDetailView,
    refreshAfterQcClean: refreshViewsAfterQcClean,
    syncQcMarkers: syncDetailQcMarkers,
    focusDetailCoords,
    switchDetailTab,
    openPoiEditor,
    removeLocalRoute,
    clearLocalRoutes
  });
}

function bindGlobalNavEvents() {
  document.getElementById('brand-home-btn')?.addEventListener('click', openHomePage);
  document.querySelectorAll('.topbar-nav .nav-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nav = btn.dataset.nav;
      if (nav === 'home') openHomePage();
      else if (nav === 'leaderboard') openLeaderboardPage();
      else if (nav.startsWith('cat-')) openCategoryPage(nav.slice(4));
    });
  });

  document.getElementById('btn-sync-kmls')?.addEventListener('click', async () => {
    try {
      await fetchJson('/api/kmls/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prune: false })
      });
      geojsonCache.clear();
      await loadCatalogAndInbox();
      showToast('已扫描同步路线库与待分类 Inbox');
    } catch (err) {
      showToast(`同步失败: ${err.message}`);
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  registerActions();
  initHomeContour();

  const initBasemap = document.getElementById('basemap-select')?.value || 'openmap-vector';
  setBasemap(initBasemap, false);
  updateHillshade();
  updateHud();

  bindGlobalNavEvents();
  bindHomeEvents({ onLocateNearby: locateUserOnMap });
  bindCategoryEvents();
  bindLeaderboardEvents();
  bindDetailEvents();
  bindLocalImportEvents();

  try {
    await loadCatalogAndInbox();
  } catch (err) {
    showToast(`初始化路线库失败: ${err.message}`);
  }
});
