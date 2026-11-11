/**
 * Client-side KML / KMZ / GPX / GeoJSON trajectory Quality Check (QC) engine.
 * Mirrors scripts/kml_qc.py so browser previews and backend ingest share identical rules.
 */

export const DEFAULT_QC_THRESHOLDS = {
  max_speed_kmh: 120,
  min_jump_dist_m: 30,
  zero_dt_dist_m: 50,
  short_time_s: 5,
  short_time_dist_m: 150,
  max_gap_m: 5000,
  spike_dist_m: 150,
  max_ele_rate_ms: 15
};

export const CATEGORY_SPEED_PRESETS = {
  hiking: 35,
  cycling: 90,
  offroad: 140
};

export const QC_TYPE_META = {
  speed_jump: { label: '距离大时间短 (瞬时超速)', fixable: true },
  zero_time_jump: { label: '零耗时大位移跳变', fixable: true },
  time_reversal: { label: '时间戳倒流', fixable: true },
  spatial_spike: { label: '空间往返毛刺飞点', fixable: true },
  large_gap: { label: '大跨度轨迹断点', fixable: false },
  elevation_spike: { label: '高程垂直突变', fixable: false },
  timestamp_mismatch: { label: '时间戳与坐标数量不匹配', fixable: false }
};

export const MAX_STORED_ISSUES = 200;

export function resolveQcThresholds(category = null, overrides = null) {
  const cfg = { ...DEFAULT_QC_THRESHOLDS };
  if (category && category in CATEGORY_SPEED_PRESETS) {
    cfg.max_speed_kmh = CATEGORY_SPEED_PRESETS[category];
  }
  if (overrides && typeof overrides === 'object') {
    for (const [key, defVal] of Object.entries(DEFAULT_QC_THRESHOLDS)) {
      const raw = overrides[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const num = Number(raw);
      cfg[key] = Number.isFinite(num) && num >= 0 ? num : defVal;
    }
  }
  return cfg;
}

export function parseIsoTimestamp(text) {
  if (!text) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

export function haversineMeters(p1, p2) {
  const rM = 6371008.8;
  const toRad = Math.PI / 180;
  const lon1 = p1[0] * toRad;
  const lat1 = p1[1] * toRad;
  const lon2 = p2[0] * toRad;
  const lat2 = p2[1] * toRad;
  const dlon = lon2 - lon1;
  const dlat = lat2 - lat1;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * rM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function round1(val) {
  return Math.round(val * 10) / 10;
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

function makeIssue({
  issueType,
  severity,
  segmentIndex,
  segmentName,
  pointIndex,
  prevIndex,
  coord,
  prevCoord,
  timeStr,
  prevTimeStr,
  distanceM,
  dtS,
  speedKmh,
  eleDiffM,
  message
}) {
  return {
    id: `seg${segmentIndex}-pt${pointIndex}-${issueType}`,
    type: issueType,
    type_label: QC_TYPE_META[issueType]?.label || issueType,
    severity,
    segment_index: segmentIndex,
    segment_name: segmentName,
    point_index: pointIndex,
    prev_index: prevIndex,
    coord: coord || null,
    prev_coord: prevCoord || null,
    time: timeStr || null,
    prev_time: prevTimeStr || null,
    distance_m: distanceM !== null && distanceM !== undefined ? round1(distanceM) : null,
    dt_s: dtS !== null && dtS !== undefined ? round2(dtS) : null,
    speed_kmh: speedKmh !== null && speedKmh !== undefined && Number.isFinite(speedKmh) ? round1(speedKmh) : null,
    ele_diff_m: eleDiffM !== null && eleDiffM !== undefined ? round1(eleDiffM) : null,
    message
  };
}

export function inspectTrackSegments(segments, category = null, thresholds = null) {
  const cfg = resolveQcThresholds(category, thresholds);
  const allIssues = [];
  const byType = {};
  let errorCount = 0;
  let warningCount = 0;
  let totalPoints = 0;
  let timedPoints = 0;
  let maxSpeedKmh = 0;
  let maxStepDistM = 0;

  const record = (issue) => {
    byType[issue.type] = (byType[issue.type] || 0) + 1;
    if (issue.severity === 'error') errorCount += 1;
    else warningCount += 1;
    if (allIssues.length < MAX_STORED_ISSUES) {
      allIssues.push(issue);
    }
  };

  for (let sIdx = 0; sIdx < (segments || []).length; sIdx++) {
    const seg = segments[sIdx];
    const segIndex = Number(seg.segment_index || sIdx + 1);
    const segName = String(seg.name || `轨迹段 ${segIndex}`);
    const pts = seg.points || [];
    const rawTimes = seg.times || [];
    totalPoints += pts.length;

    const parsedTimes = [];
    for (let i = 0; i < pts.length; i++) {
      const ts = parseIsoTimestamp(i < rawTimes.length ? rawTimes[i] : null);
      if (ts !== null) timedPoints += 1;
      parsedTimes.push(ts);
    }

    if (seg.timestamp_mismatch) {
      record(makeIssue({
        issueType: 'timestamp_mismatch',
        severity: 'warning',
        segmentIndex: segIndex,
        segmentName: segName,
        pointIndex: 0,
        prevIndex: null,
        coord: pts[0] || null,
        prevCoord: null,
        timeStr: null,
        prevTimeStr: null,
        distanceM: null,
        dtS: null,
        speedKmh: null,
        eleDiffM: null,
        message: `${segName}：<when> 与 <gx:coord> 数量不一致，时间校验可能不完整`
      }));
    }

    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const distM = haversineMeters(prev, curr);
      if (distM > maxStepDistM) maxStepDistM = distM;

      const tPrev = parsedTimes[i - 1];
      const tCurr = parsedTimes[i];
      const tPrevStr = (i - 1) < rawTimes.length ? rawTimes[i - 1] : null;
      const tCurrStr = i < rawTimes.length ? rawTimes[i] : null;
      const dtS = (tPrev !== null && tCurr !== null) ? (tCurr - tPrev) : null;
      const eleDiffM = (curr.length >= 3 && prev.length >= 3 && Number.isFinite(curr[2]) && Number.isFinite(prev[2]))
        ? (curr[2] - prev[2])
        : null;

      let flaggedJump = false;

      if (dtS !== null) {
        if (dtS < 0) {
          flaggedJump = true;
          record(makeIssue({
            issueType: 'time_reversal',
            severity: 'error',
            segmentIndex: segIndex,
            segmentName: segName,
            pointIndex: i,
            prevIndex: i - 1,
            coord: curr,
            prevCoord: prev,
            timeStr: tCurrStr,
            prevTimeStr: tPrevStr,
            distanceM: distM,
            dtS,
            speedKmh: null,
            eleDiffM,
            message: `${segName} 第 ${i} 点：时间倒流 ${Math.abs(dtS).toFixed(1)}s（位移 ${distM.toFixed(1)}m）`
          }));
        } else if (dtS === 0) {
          if (distM >= cfg.zero_dt_dist_m) {
            flaggedJump = true;
            record(makeIssue({
              issueType: 'zero_time_jump',
              severity: 'error',
              segmentIndex: segIndex,
              segmentName: segName,
              pointIndex: i,
              prevIndex: i - 1,
              coord: curr,
              prevCoord: prev,
              timeStr: tCurrStr,
              prevTimeStr: tPrevStr,
              distanceM: distM,
              dtS: 0,
              speedKmh: null,
              eleDiffM,
              message: `${segName} 第 ${i} 点：耗时 0s 但位移达 ${distM.toFixed(1)}m（超过阈值 ${cfg.zero_dt_dist_m.toFixed(0)}m）`
            }));
          }
        } else {
          const speedKmh = (distM / dtS) * 3.6;
          if (speedKmh > maxSpeedKmh) maxSpeedKmh = speedKmh;
          const isOverSpeed = distM >= cfg.min_jump_dist_m && speedKmh > cfg.max_speed_kmh;
          const isShortTimeBigDist = dtS <= cfg.short_time_s && distM >= cfg.short_time_dist_m;
          if (isOverSpeed || isShortTimeBigDist) {
            flaggedJump = true;
            const isSevere = speedKmh >= cfg.max_speed_kmh * 1.5 || isShortTimeBigDist;
            record(makeIssue({
              issueType: 'speed_jump',
              severity: isSevere ? 'error' : 'warning',
              segmentIndex: segIndex,
              segmentName: segName,
              pointIndex: i,
              prevIndex: i - 1,
              coord: curr,
              prevCoord: prev,
              timeStr: tCurrStr,
              prevTimeStr: tPrevStr,
              distanceM: distM,
              dtS,
              speedKmh,
              eleDiffM,
              message: `${segName} 第 ${i} 点：${dtS.toFixed(1)}s 内移动 ${distM.toFixed(1)}m（${speedKmh.toFixed(1)} km/h，阈值 ${cfg.max_speed_kmh.toFixed(0)} km/h）`
            }));
          }
        }
      }

      if (!flaggedJump && i < pts.length - 1) {
        const nxt = pts[i + 1];
        const dNext = haversineMeters(curr, nxt);
        const dAc = haversineMeters(prev, nxt);
        if (distM >= cfg.spike_dist_m && dNext >= cfg.spike_dist_m && dAc <= Math.min(distM, dNext) * 0.35) {
          flaggedJump = true;
          record(makeIssue({
            issueType: 'spatial_spike',
            severity: 'warning',
            segmentIndex: segIndex,
            segmentName: segName,
            pointIndex: i,
            prevIndex: i - 1,
            coord: curr,
            prevCoord: prev,
            timeStr: tCurrStr,
            prevTimeStr: tPrevStr,
            distanceM: distM,
            dtS,
            speedKmh: (dtS && dtS > 0) ? (distM / dtS) * 3.6 : null,
            eleDiffM,
            message: `${segName} 第 ${i} 点：疑似往返毛刺飞点（去程 ${distM.toFixed(1)}m / 回程 ${dNext.toFixed(1)}m，前后邻点直距仅 ${dAc.toFixed(1)}m）`
          }));
        }
      }

      if (!flaggedJump && distM >= cfg.max_gap_m) {
        record(makeIssue({
          issueType: 'large_gap',
          severity: 'warning',
          segmentIndex: segIndex,
          segmentName: segName,
          pointIndex: i,
          prevIndex: i - 1,
          coord: curr,
          prevCoord: prev,
          timeStr: tCurrStr,
          prevTimeStr: tPrevStr,
          distanceM: distM,
          dtS,
          speedKmh: (dtS && dtS > 0) ? (distM / dtS) * 3.6 : null,
          eleDiffM,
          message: `${segName} 第 ${i} 点：单步跨度 ${(distM / 1000).toFixed(2)}km（超过断点阈值 ${(cfg.max_gap_m / 1000).toFixed(1)}km）`
        }));
      }

      if (eleDiffM !== null) {
        const absDe = Math.abs(eleDiffM);
        if (dtS !== null && dtS > 0) {
          const vertRate = absDe / dtS;
          if (absDe >= 100 && vertRate > cfg.max_ele_rate_ms) {
            record(makeIssue({
              issueType: 'elevation_spike',
              severity: 'warning',
              segmentIndex: segIndex,
              segmentName: segName,
              pointIndex: i,
              prevIndex: i - 1,
              coord: curr,
              prevCoord: prev,
              timeStr: tCurrStr,
              prevTimeStr: tPrevStr,
              distanceM: distM,
              dtS,
              speedKmh: (distM / dtS) * 3.6,
              eleDiffM,
              message: `${segName} 第 ${i} 点：${dtS.toFixed(1)}s 内海拔变化 ${eleDiffM >= 0 ? '+' : ''}${eleDiffM.toFixed(1)}m（${vertRate.toFixed(1)} m/s）`
            }));
          }
        } else if (dtS === null && absDe >= 500 && distM < 200) {
          record(makeIssue({
            issueType: 'elevation_spike',
            severity: 'warning',
            segmentIndex: segIndex,
            segmentName: segName,
            pointIndex: i,
            prevIndex: i - 1,
            coord: curr,
            prevCoord: prev,
            timeStr: null,
            prevTimeStr: null,
            distanceM: distM,
            dtS: null,
            speedKmh: null,
            eleDiffM,
            message: `${segName} 第 ${i} 点：水平位移 ${distM.toFixed(1)}m 但海拔突变 ${eleDiffM >= 0 ? '+' : ''}${eleDiffM.toFixed(1)}m`
          }));
        }
      }
    }
  }

  const issuesCount = errorCount + warningCount;
  const status = errorCount > 0 ? 'error' : (warningCount > 0 ? 'warning' : 'passed');

  return {
    status,
    has_timestamps: timedPoints > 0,
    total_points: totalPoints,
    timed_points: timedPoints,
    issues_count: issuesCount,
    error_count: errorCount,
    warning_count: warningCount,
    by_type: byType,
    max_speed_kmh: timedPoints > 1 ? round1(maxSpeedKmh) : null,
    max_step_dist_m: totalPoints > 1 ? round1(maxStepDistM) : 0,
    thresholds: cfg,
    issues: allIssues,
    truncated: issuesCount > allIssues.length
  };
}

export function extractSegmentsFromGeojson(fc) {
  const segments = [];
  let segIdx = 0;
  for (const feat of fc?.features || []) {
    const geom = feat?.geometry || {};
    const props = feat?.properties || {};
    if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      segIdx += 1;
      segments.push({
        segment_index: Number(props.segment_index || segIdx),
        name: props.name || `轨迹段 ${segIdx}`,
        points: geom.coordinates,
        times: props.times || props.coordTimes || []
      });
    }
  }
  return segments;
}

export function inspectGeojson(fc, category = null, thresholds = null) {
  return inspectTrackSegments(extractSegmentsFromGeojson(fc), category, thresholds);
}

/**
 * Remove target point indices from cloned GeoJSON & optional qcSegments.
 * Always keeps at least 2 vertices per LineString segment.
 */
export function removeAnomalyPoints(fc, qcSegments, targets) {
  const dropBySeg = new Map();
  for (const t of targets || []) {
    const sIdx = Number(t.segment_index);
    const pIdx = Number(t.point_index);
    if (!Number.isInteger(sIdx) || !Number.isInteger(pIdx) || pIdx < 0) continue;
    if (!dropBySeg.has(sIdx)) dropBySeg.set(sIdx, new Set());
    dropBySeg.get(sIdx).add(pIdx);
  }

  const nextFc = JSON.parse(JSON.stringify(fc));
  let removedCount = 0;
  let segCounter = 0;

  for (const feat of nextFc.features || []) {
    if (feat.geometry?.type !== 'LineString' || !Array.isArray(feat.geometry.coordinates)) continue;
    segCounter += 1;
    const sIdx = Number(feat.properties?.segment_index || segCounter);
    const dropSet = dropBySeg.get(sIdx);
    if (!dropSet || !dropSet.size) continue;

    const oldCoords = feat.geometry.coordinates;
    const kept = [];
    for (let i = 0; i < oldCoords.length; i++) {
      if (dropSet.has(i) && (kept.length + (oldCoords.length - 1 - i)) >= 2) {
        removedCount += 1;
        continue;
      }
      kept.push(oldCoords[i]);
    }
    feat.geometry.coordinates = kept;
  }

  let nextSegments = null;
  if (Array.isArray(qcSegments)) {
    nextSegments = qcSegments.map((seg, idx) => {
      const sIdx = Number(seg.segment_index || idx + 1);
      const dropSet = dropBySeg.get(sIdx);
      if (!dropSet || !dropSet.size) {
        return { ...seg, points: [...(seg.points || [])], times: [...(seg.times || [])] };
      }
      const oldPts = seg.points || [];
      const oldTimes = seg.times || [];
      const keptPts = [];
      const keptTimes = [];
      for (let i = 0; i < oldPts.length; i++) {
        if (dropSet.has(i) && (keptPts.length + (oldPts.length - 1 - i)) >= 2) {
          continue;
        }
        keptPts.push(oldPts[i]);
        if (i < oldTimes.length) keptTimes.push(oldTimes[i]);
      }
      return { ...seg, points: keptPts, times: keptTimes };
    });
  }

  return { geojson: nextFc, qcSegments: nextSegments, removedCount };
}
