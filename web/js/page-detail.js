/**
 * Page 4: L-Shaped Detail Breakdown (3D Terrain Block + Elevation Profile + POIs/Edit)
 */
import {
  MONTHS,
  POI_COLORS,
  state,
  geojsonCache,
  escapeHtml,
  getCatColor,
  getCatLabel,
  getPoiLabel,
  fetchJson,
  fetchRouteGeojson,
  showToast,
  getPoiFeatures,
  actions
} from './app-state.js';
import { buildRouteAnalysis, ElevationProfileChart } from './elevation-profile.js';
import { TerrainBlockViewer } from './terrain-block-3d.js';
import { createBasemapLayer } from './map-layers.js';
import { getCurrentQcReport, renderGeojsonOnMap, renderQcMarkersOnLayer } from './qc-map-overlay.js';
import { exportCurrentRoute } from './route-export.js';
import {
  map as categoryMap,
  activeLayerGroup,
  qcMapLayerGroup,
  getFilteredCategoryRoutes,
  selectInboxItem,
  selectLocalRoute
} from './page-category.js';
import { renderDetailQcTab } from './page-detail-qc.js';

let terrainViewer = null;
let profileChart = null;
let minimap = null;
let minimapLayerGroup = null;
let minimapQcLayerGroup = null;
let minimapBasemapLayer = null;
let minimapHoverDot = null;
let detailAddPoiMode = false;

export function resizeDetailViews() {
  requestAnimationFrame(() => {
    terrainViewer?.resize();
    profileChart?.draw();
    minimap?.invalidateSize({ pan: false });
  });
}

export function focusDetailCoords(lng, lat) {
  terrainViewer?.focusLngLat(lng, lat);
}

export function syncDetailQcMarkers(qc, activeIssueId = null, focusMinimap = false) {
  renderQcMarkersOnLayer(minimapQcLayerGroup, minimap, qc, activeIssueId, focusMinimap);
  renderQcMarkersOnLayer(qcMapLayerGroup, categoryMap, qc, activeIssueId, false);
}

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

export async function openDetailForArchived(routeId) {
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

export async function openDetailForInbox(relFile) {
  await selectInboxItem(relFile, false);
  if (state.currentEntry && state.currentGeojson) {
    await enterDetailView(state.currentEntry, state.currentGeojson, true, false);
  }
}

export async function openDetailForLocal(localId) {
  selectLocalRoute(localId, false);
  if (state.currentEntry && state.currentGeojson) {
    await enterDetailView(state.currentEntry, state.currentGeojson, false, true);
  }
}

export async function enterDetailView(entry, fc, isInbox, isLocal) {
  state.currentEntry = entry;
  state.currentGeojson = fc;
  state.editingPoiIndex = null;
  state.pendingNewPoiCoords = null;
  state.qcActiveIssueId = null;
  state.qcOriginalSnapshot = null;
  state.currentQc = getCurrentQcReport(fc, entry);

  actions.showPage?.('detail');
  ensureDetailModules();

  const detailRoot = document.getElementById('view-detail');
  detailRoot.classList.toggle('local-preview-mode', Boolean(isLocal));

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

  let analysis = buildRouteAnalysis(fc, null);
  state.currentAnalysis = analysis;
  renderDetailAnalysis(entry, analysis);
  profileChart.setAnalysis(analysis);

  renderGeojsonOnMap(minimapLayerGroup, minimap, fc, isInbox ? 'inbox' : (isLocal ? 'local' : entry.category), true, entry._color);
  renderQcMarkersOnLayer(minimapQcLayerGroup, minimap, state.currentQc, null, false);
  setTimeout(() => minimap?.invalidateSize({ pan: false }), 60);

  populateDetailEditForm(entry, isInbox, isLocal);
  renderDetailQcTab();

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

export async function refreshViewsAfterQcClean(nextEntry, nextFc, nextQc) {
  state.currentEntry = nextEntry;
  state.currentGeojson = nextFc;
  state.currentQc = nextQc;
  state.qcActiveIssueId = null;

  const isInbox = state.selectedMode === 'inbox';
  const isLocal = state.selectedMode === 'local';
  const cat = isInbox ? 'inbox' : (isLocal ? 'local' : nextEntry.category);
  const catColor = nextEntry._color || getCatColor(nextEntry.category);

  const analysis = buildRouteAnalysis(nextFc, terrainViewer?.demLoaded ? (lng, lat) => terrainViewer.sampleElevation(lng, lat) : null);
  state.currentAnalysis = analysis;
  renderDetailAnalysis(nextEntry, analysis);
  profileChart?.setAnalysis(analysis);

  renderGeojsonOnMap(minimapLayerGroup, minimap, nextFc, cat, false, nextEntry._color);
  renderGeojsonOnMap(activeLayerGroup, categoryMap, nextFc, cat, false, nextEntry._color);
  syncDetailQcMarkers(nextQc, null, false);
  renderDetailQcTab();

  if (terrainViewer) {
    await terrainViewer.loadRoute(nextFc, {
      categoryColor: catColor,
      routeName: nextEntry.name || ''
    });
  }
}

export function renderDetailAnalysis(entry, analysis) {
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

export function switchDetailTab(tabName) {
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

export function openPoiEditor(poiIndex, newLatLng = null) {
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
    geojsonCache.set(state.selectedId, res.geojson);
    state.currentGeojson = res.geojson;
    state.currentEntry = res.route;
    const idx = (state.catalog.routes || []).findIndex((r) => r.id === state.selectedId);
    if (idx >= 0) state.catalog.routes[idx] = res.route;

    await enterDetailView(res.route, res.geojson, false, false);
  } else {
    renderGeojsonOnMap(activeLayerGroup, categoryMap, state.currentGeojson, cat, false);
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

export function bindDetailEvents() {
  document.getElementById('btn-detail-back')?.addEventListener('click', () => {
    if (state.returnPage === 'leaderboard') actions.openLeaderboardPage?.();
    else actions.openCategoryPage?.(state.activeCat, { resetFilters: false, fitRoutes: false });
  });
  document.getElementById('btn-detail-prev')?.addEventListener('click', () => stepDetailRoute(-1));
  document.getElementById('btn-detail-next')?.addEventListener('click', () => stepDetailRoute(1));
  document.getElementById('btn-detail-export-kml')?.addEventListener('click', () => exportCurrentRoute('kml'));
  document.getElementById('btn-detail-export-gpx')?.addEventListener('click', () => exportCurrentRoute('gpx'));
  document.querySelectorAll('#export-bar .export-btn').forEach((btn) => {
    btn.addEventListener('click', () => exportCurrentRoute(btn.dataset.export));
  });

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
        geojsonCache.clear();
        await actions.loadCatalogAndInbox?.();
        state.activeCat = newRoute.category;
        await openDetailForArchived(newRoute.id);
        showToast(`已归档至 ${newRoute.raw_file}`);
      } else if (state.selectedMode === 'archived' && state.selectedId) {
        const res = await fetchJson('/api/kmls/update_meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.selectedId, ...payload })
        });
        geojsonCache.delete(state.selectedId);
        geojsonCache.delete(res.route.id);
        await actions.loadCatalogAndInbox?.();
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
