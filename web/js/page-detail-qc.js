/**
 * Page 4 Submodule: Track Quality Control (QC) Inspection & Anomaly Removal
 */
import { state, escapeHtml, fetchJson, showToast, actions } from './app-state.js';
import { computeMetrics } from './local-kml-parser.js';
import {
  inspectTrackSegments,
  inspectGeojson,
  removeAnomalyPoints,
  QC_TYPE_META
} from './kml-qc.js';

export function updateDetailQcBadge(qc) {
  const pill = document.getElementById('detail-qc-cnt');
  if (!pill) return;
  const cnt = qc?.issues_count ?? 0;
  const st = qc?.status || 'passed';
  pill.className = `qc-tab-pill ${st}`;
  pill.textContent = cnt > 0 ? String(cnt) : '✓';
}

export async function rerunQcWithThresholds(overrides) {
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
    actions.syncQcMarkers?.(nextQc, null, false);
    if (nextQc.issues_count === 0) showToast('复检完成：未发现异常点');
    else showToast(`复检完成：检出 ${nextQc.issues_count} 处异常`);
  } catch (err) {
    showToast(`重新质检失败: ${err.message}`);
  }
}

export async function applyQcPointRemoval(targets) {
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

  await actions.refreshAfterQcClean?.(nextEntry, nextFc, nextQc);
  showToast(`已剔除 ${removedCount} 个异常点（可在「标注与导出」下载清洗后 KML/GPX）`);
}

export async function restoreOriginalRouteFromQc() {
  const snap = state.qcOriginalSnapshot;
  if (!snap) return;
  state.qcOriginalSnapshot = null;
  await actions.refreshAfterQcClean?.(snap.entry, snap.geojson, snap.qc);
  showToast('已还原清洗前的原始轨迹');
}

export function renderDetailQcTab() {
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
      ${state.qcOriginalSnapshot ? '<button type="button" id="btn-qc-restore" class="icon-btn" style="padding:4px 9px; font-size:11px;">↩️ 还原</button>' : ''}
    </div>

    ${state.qcOriginalSnapshot ? '<div style="font-size:11px; color:#58a6ff; background:rgba(56,139,253,0.1); border:1px solid rgba(56,139,253,0.3); border-radius:6px; padding:6px 8px;">已预览清洗轨迹：可直接点击顶部「导出 KML / GPX」保存洁净轨迹。</div>' : ''}

    <div class="qc-issue-list">${issuesHtml}</div>
    ${qc.truncated ? `<div style="font-size:11px; color:var(--text-muted);">仅展示前 ${qc.issues.length} 条（共 ${qc.issues_count} 条异常）</div>` : ''}
  `;

  container.querySelector('#toggle-qc-markers')?.addEventListener('change', (e) => {
    state.qcShowOnMap = Boolean(e.target.checked);
    actions.syncQcMarkers?.(state.currentQc, state.qcActiveIssueId, false);
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
        actions.focusDetailCoords?.(issue.coord[0], issue.coord[1]);
      }
      actions.syncQcMarkers?.(qc, id, true);
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
