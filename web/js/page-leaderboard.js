/**
 * Page 3: Standalone Annual / Top Route Leaderboard
 */
import { state, escapeHtml, getCatColor, getCatLabel, actions } from './app-state.js';
import { renderMiniSparklineSvg } from './elevation-profile.js';

export function renderLeaderboardPage() {
  const routes = state.catalog.routes || [];
  const yearsSet = new Set();
  for (const r of routes) {
    if (r.year && String(r.year).trim()) yearsSet.add(String(r.year).trim());
  }
  const years = Array.from(yearsSet).sort().reverse();
  const yearSel = document.getElementById('lb-year-filter');
  if (yearSel) {
    const prevVal = state.lbYear;
    yearSel.innerHTML = '<option value="all">全部榜单</option>' +
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

  const catKms = {
    offroad: scoped.filter((r) => r.category === 'offroad').reduce((s, r) => s + (Number(r.distance_km) || 0), 0),
    cycling: scoped.filter((r) => r.category === 'cycling').reduce((s, r) => s + (Number(r.distance_km) || 0), 0),
    hiking: scoped.filter((r) => r.category === 'hiking').reduce((s, r) => s + (Number(r.distance_km) || 0), 0)
  };
  const sumCatKm = Math.max(0.01, catKms.offroad + catKms.cycling + catKms.hiking);
  document.getElementById('lb-cat-bar-wrap').innerHTML = `
    <div style="font-size:12px; font-weight:600; color:#334155;">三大类里程占比</div>
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
          <div style="font-weight:700; color:#0f172a; font-size:13.5px;">${escapeHtml(r.name)}</div>
          <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
            <span style="color:${color}; font-weight:600;">${escapeHtml(getCatLabel(r.category))}</span>
            ${r.region ? ` · ${escapeHtml(r.region)}` : ''}
            ${r.year ? ` · ${escapeHtml(r.year)}年` : ''}
          </div>
        </div>
        <div style="font-family:var(--mono); font-size:12px; color:#475569;">
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
      actions.openDetailForArchived?.(el.dataset.lbId);
    });
  });
}

export function bindLeaderboardEvents() {
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
}
