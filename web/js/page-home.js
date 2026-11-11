/**
 * Page 1: Full-Screen Contour Portal
 */
import { CATEGORIES, state, getCatColor, actions } from './app-state.js';
import { ContourBackground } from './contour-bg.js';

let contourBg = null;

export function initHomeContour() {
  const contourCanvas = document.getElementById('home-contour-canvas');
  if (contourCanvas && !contourBg) {
    contourBg = new ContourBackground(contourCanvas);
  }
}

export function renderHomeContour() {
  contourBg?.render();
}

export function renderHomePortal() {
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

export function bindHomeEvents({ onLocateNearby }) {
  document.querySelectorAll('.portal-card').forEach((card) => {
    const cat = card.dataset.cat;
    card.addEventListener('mouseenter', () => contourBg?.setAccentColor(getCatColor(cat)));
    card.addEventListener('mouseleave', () => contourBg?.setAccentColor(null));
    card.addEventListener('click', () => actions.openCategoryPage?.(cat));
  });

  document.getElementById('home-btn-leaderboard')?.addEventListener('click', () => {
    actions.openLeaderboardPage?.();
  });

  document.getElementById('home-btn-nearby')?.addEventListener('click', () => {
    const routes = state.catalog.routes || [];
    const firstNonEmpty = CATEGORIES.find((c) => routes.some((r) => r.category === c)) || 'offroad';
    actions.openCategoryPage?.(firstNonEmpty, { resetFilters: true, fitRoutes: false });
    onLocateNearby?.();
  });
}
