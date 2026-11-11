/**
 * Route elevation analysis, mini sparklines, and interactive Canvas profile chart.
 */

export function haversineKm(p1, p2) {
  const rKm = 6371.0088;
  const toRad = Math.PI / 180;
  const lon1 = p1[0] * toRad;
  const lat1 = p1[1] * toRad;
  const lon2 = p2[0] * toRad;
  const lat2 = p2[1] * toRad;
  const dlon = lon2 - lon1;
  const dlat = lat2 - lat1;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * rKm * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function renderMiniSparklineSvg(values, color = '#2f81f7', width = 64, height = 22) {
  if (!Array.isArray(values) || values.length < 2) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <line x1="2" y1="${height / 2}" x2="${width - 2}" y2="${height / 2}" stroke="rgba(139,148,158,0.28)" stroke-width="1.2" stroke-dasharray="2 2"/>
    </svg>`;
  }
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = Math.max(1, maxV - minV);
  const padX = 1.5;
  const padY = 2.5;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const pts = values.map((v, i) => {
    const x = padX + (i / (values.length - 1)) * innerW;
    const y = padY + innerH - ((v - minV) / span) * innerH;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length - 1][0]},${height} L${pts[0][0]},${height} Z`;

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="mini-sparkline" aria-hidden="true">
    <path d="${areaPath}" fill="${color}" fill-opacity="0.16" />
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

export function gradeColor(gradePct) {
  if (!Number.isFinite(gradePct)) return '#38bdf8';
  if (gradePct >= 10) return '#ef4444';
  if (gradePct >= 5) return '#f97316';
  if (gradePct >= 1.5) return '#eab308';
  if (gradePct > -2.5) return '#22c55e';
  return '#38bdf8';
}

export function buildRouteAnalysis(fc, fallbackEleSampler = null) {
  const features = fc?.features || [];
  const routeFeats = features.filter((f) => f.geometry?.type === 'LineString');
  const poiFeats = features.filter((f) => f.geometry?.type === 'Point');

  const rawPoints = [];
  let cumKm = 0;
  let hasRawEle = false;

  routeFeats.forEach((feat, segIdx) => {
    const coords = feat.geometry?.coordinates || [];
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (!Array.isArray(c) || c.length < 2) continue;
      if (rawPoints.length > 0 && i > 0) {
        cumKm += haversineKm(coords[i - 1], c);
      } else if (rawPoints.length > 0 && i === 0) {
        // Small gap jump across disconnected segments doesn't add fake distance if far, or add actual gap
        const prev = rawPoints[rawPoints.length - 1];
        const gap = haversineKm([prev.lng, prev.lat], c);
        if (gap < 0.5) cumKm += gap;
      }
      const ele = c.length >= 3 && Number.isFinite(c[2]) ? c[2] : null;
      if (ele !== null) hasRawEle = true;
      rawPoints.push({
        lng: c[0],
        lat: c[1],
        ele,
        distKm: cumKm,
        segIndex: segIdx
      });
    }
  });

  // Fill missing elevation using DEM sampler if provided
  let eleSource = hasRawEle ? 'track' : 'none';
  if (!hasRawEle && typeof fallbackEleSampler === 'function' && rawPoints.length) {
    let sampledAny = false;
    for (const pt of rawPoints) {
      const e = fallbackEleSampler(pt.lng, pt.lat);
      if (Number.isFinite(e)) {
        pt.ele = Math.round(e * 10) / 10;
        sampledAny = true;
      }
    }
    if (sampledAny) eleSource = 'dem';
  } else if (hasRawEle && typeof fallbackEleSampler === 'function') {
    for (const pt of rawPoints) {
      if (pt.ele === null) {
        const e = fallbackEleSampler(pt.lng, pt.lat);
        if (Number.isFinite(e)) pt.ele = Math.round(e * 10) / 10;
      }
    }
  }

  // Fill remaining gaps linearly
  let lastValidEle = null;
  for (let i = 0; i < rawPoints.length; i++) {
    if (rawPoints[i].ele !== null) {
      lastValidEle = rawPoints[i].ele;
    } else if (lastValidEle !== null) {
      rawPoints[i].ele = lastValidEle;
    }
  }
  let nextValidEle = null;
  for (let i = rawPoints.length - 1; i >= 0; i--) {
    if (rawPoints[i].ele !== null) {
      nextValidEle = rawPoints[i].ele;
    } else if (nextValidEle !== null) {
      rawPoints[i].ele = nextValidEle;
    }
  }

  // Downsample dense tracks to <= 900 points for smooth canvas & grade calc while keeping extremes
  let points = rawPoints;
  if (rawPoints.length > 900) {
    const step = (rawPoints.length - 1) / 899;
    points = [];
    for (let i = 0; i < 900; i++) {
      points.push({ ...rawPoints[Math.min(rawPoints.length - 1, Math.round(i * step))] });
    }
  }

  // Compute smoothed elevation and grade
  let gainM = 0;
  let lossM = 0;
  let minEle = Infinity;
  let maxEle = -Infinity;
  let maxGrade = 0;
  let sumAbsGradeDist = 0;
  let gradeDistTotal = 0;

  let lastThresholdEle = null;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (pt.ele !== null) {
      if (pt.ele < minEle) minEle = pt.ele;
      if (pt.ele > maxEle) maxEle = pt.ele;
      if (lastThresholdEle === null) {
        lastThresholdEle = pt.ele;
      } else if (pt.ele - lastThresholdEle >= 3.0) {
        gainM += pt.ele - lastThresholdEle;
        lastThresholdEle = pt.ele;
      } else if (lastThresholdEle - pt.ele >= 3.0) {
        lossM += lastThresholdEle - pt.ele;
        lastThresholdEle = pt.ele;
      }
    }

    // Windowed grade calculation over ~100m-250m lookback/lookahead to avoid GPS jitter
    let j0 = i;
    while (j0 > 0 && pt.distKm - points[j0].distKm < 0.08) j0--;
    let j1 = i;
    while (j1 < points.length - 1 && points[j1].distKm - pt.distKm < 0.08) j1++;
    const spanKm = points[j1].distKm - points[j0].distKm;
    if (spanKm > 0.015 && points[j0].ele !== null && points[j1].ele !== null) {
      const g = ((points[j1].ele - points[j0].ele) / (spanKm * 1000)) * 100;
      pt.gradePct = Math.max(-45, Math.min(45, g));
      if (Math.abs(pt.gradePct) > Math.abs(maxGrade)) maxGrade = pt.gradePct;
    } else {
      pt.gradePct = 0;
    }

    if (i > 0) {
      const segKm = Math.max(0, pt.distKm - points[i - 1].distKm);
      if (segKm > 0) {
        sumAbsGradeDist += Math.abs(pt.gradePct) * segKm;
        gradeDistTotal += segKm;
      }
    }
  }

  // Altitude & grade bands
  const altBuckets = [
    { label: '< 1,500 m', min: -Infinity, max: 1500, km: 0, color: '#38bdf8' },
    { label: '1,500 ~ 3,000 m', min: 1500, max: 3000, km: 0, color: '#22c55e' },
    { label: '3,000 ~ 4,000 m', min: 3000, max: 4000, km: 0, color: '#eab308' },
    { label: '4,000 ~ 5,000 m', min: 4000, max: 5000, km: 0, color: '#f97316' },
    { label: '> 5,000 m', min: 5000, max: Infinity, km: 0, color: '#ef4444' }
  ];
  const gradeBuckets = [
    { label: '陡坡 (≥ 8%)', min: 8, max: Infinity, km: 0, color: '#ef4444' },
    { label: '爬坡 (3% ~ 8%)', min: 3, max: 8, km: 0, color: '#f97316' },
    { label: '缓行 (-3% ~ 3%)', min: -3, max: 3, km: 0, color: '#22c55e' },
    { label: '下坡 (< -3%)', min: -Infinity, max: -3, km: 0, color: '#38bdf8' }
  ];

  for (let i = 1; i < points.length; i++) {
    const segKm = Math.max(0, points[i].distKm - points[i - 1].distKm);
    if (!segKm) continue;
    const ele = points[i].ele;
    if (ele !== null) {
      const b = altBuckets.find((item) => ele >= item.min && ele < item.max);
      if (b) b.km += segKm;
    }
    const g = points[i].gradePct || 0;
    const gb = gradeBuckets.find((item) => g >= item.min && g < item.max);
    if (gb) gb.km += segKm;
  }

  // Project POIs onto nearest point along track
  const projectedPois = poiFeats.map((feat, poiIdx) => {
    const coords = feat.geometry?.coordinates || [0, 0];
    const props = feat.properties || {};
    let bestPt = points[0] || null;
    let bestDist = Infinity;
    for (const pt of points) {
      const d = haversineKm([coords[0], coords[1]], [pt.lng, pt.lat]);
      if (d < bestDist) {
        bestDist = d;
        bestPt = pt;
      }
    }
    const ele = Number.isFinite(coords[2])
      ? Math.round(coords[2])
      : (Number.isFinite(props.ele) ? Math.round(props.ele) : (bestPt?.ele !== null ? Math.round(bestPt.ele) : null));
    return {
      poiIdx,
      feat,
      name: props.name || '未命名路点',
      poiKind: props.poi_kind || 'waypoint',
      description: props.description || '',
      lng: coords[0],
      lat: coords[1],
      ele,
      distKm: bestPt ? Number(bestPt.distKm.toFixed(2)) : 0,
      snapOffsetKm: Number(bestDist.toFixed(2))
    };
  }).sort((a, b) => a.distKm - b.distKm);

  const hasElevation = Number.isFinite(minEle) && Number.isFinite(maxEle);
  return {
    points,
    rawPointCount: rawPoints.length,
    hasElevation,
    eleSource,
    totalKm: Number(cumKm.toFixed(2)),
    gainM: hasElevation ? Math.round(gainM) : null,
    lossM: hasElevation ? Math.round(lossM) : null,
    minEleM: hasElevation ? Math.round(minEle) : null,
    maxEleM: hasElevation ? Math.round(maxEle) : null,
    avgGradePct: gradeDistTotal > 0 ? Number((sumAbsGradeDist / gradeDistTotal).toFixed(1)) : 0,
    maxGradePct: Number(Math.abs(maxGrade).toFixed(1)),
    altitudeBands: altBuckets.filter((b) => b.km > 0.01),
    gradeBands: gradeBuckets,
    projectedPois
  };
}

export class ElevationProfileChart {
  constructor(containerEl, options = {}) {
    this.containerEl = containerEl;
    this.onHover = options.onHover || (() => {});
    this.onRangeSelect = options.onRangeSelect || (() => {});
    this.onPoiClick = options.onPoiClick || (() => {});

    this.analysis = null;
    this.poiColors = options.poiColors || {};
    this.hoverIdx = null;
    this.dragStartIdx = null;
    this.dragEndIdx = null;
    this.isDragging = false;
    this.selection = null; // [idxA, idxB]

    this._setupDom();
    this._bindEvents();
  }

  _setupDom() {
    this.containerEl.innerHTML = `
      <div class="profile-chart-wrap">
        <canvas class="profile-canvas"></canvas>
        <div class="profile-tooltip" style="display:none;"></div>
        <div class="profile-range-pill" style="display:none;"></div>
        <div class="profile-empty-msg" style="display:none;"></div>
      </div>
    `;
    this.wrap = this.containerEl.querySelector('.profile-chart-wrap');
    this.canvas = this.containerEl.querySelector('.profile-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.tooltip = this.containerEl.querySelector('.profile-tooltip');
    this.rangePill = this.containerEl.querySelector('.profile-range-pill');
    this.emptyMsg = this.containerEl.querySelector('.profile-empty-msg');

    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(this.wrap);
    }
  }

  setAnalysis(analysis) {
    this.analysis = analysis;
    this.hoverIdx = null;
    this.selection = null;
    this.isDragging = false;
    this.tooltip.style.display = 'none';
    this.rangePill.style.display = 'none';
    this.onRangeSelect(null);
    this.draw();
  }

  highlightDistKm(distKm) {
    if (!this.analysis?.points?.length) return;
    const pts = this.analysis.points;
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const diff = Math.abs(pts[i].distKm - distKm);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    this.hoverIdx = best;
    this.draw();
  }

  _getLayout(w, h) {
    return {
      padLeft: 54,
      padRight: 20,
      padTop: 22,
      padBottom: 26,
      plotW: Math.max(40, w - 74),
      plotH: Math.max(40, h - 48)
    };
  }

  _xToPointIndex(clientX) {
    if (!this.analysis?.points?.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { padLeft, plotW } = this._getLayout(rect.width, rect.height);
    const ratio = Math.max(0, Math.min(1, (x - padLeft) / plotW));
    const targetKm = ratio * (this.analysis.totalKm || 1);
    const pts = this.analysis.points;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].distKm < targetKm) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _bindEvents() {
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.analysis?.hasElevation || !this.analysis.points.length) return;
      const idx = this._xToPointIndex(e.clientX);
      if (idx === null) return;
      this.isDragging = true;
      this.dragStartIdx = idx;
      this.dragEndIdx = idx;
      this.canvas.setPointerCapture?.(e.pointerId);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.analysis?.hasElevation || !this.analysis.points.length) return;
      const idx = this._xToPointIndex(e.clientX);
      if (idx === null) return;
      this.hoverIdx = idx;
      if (this.isDragging) {
        this.dragEndIdx = idx;
        const a = Math.min(this.dragStartIdx, this.dragEndIdx);
        const b = Math.max(this.dragStartIdx, this.dragEndIdx);
        this.selection = b - a >= 3 ? [a, b] : null;
      }
      this.draw();
      const pt = this.analysis.points[idx];
      this._updateTooltip(e, pt);
      this.onHover(pt);
    });

    const endDrag = () => {
      if (!this.isDragging) return;
      this.isDragging = false;
      if (this.selection) {
        this._emitRangeStats();
      } else {
        this.rangePill.style.display = 'none';
        this.onRangeSelect(null);
      }
      this.draw();
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    this.canvas.addEventListener('dblclick', () => {
      this.selection = null;
      this.rangePill.style.display = 'none';
      this.onRangeSelect(null);
      this.draw();
    });

    this.canvas.addEventListener('pointerleave', () => {
      if (this.isDragging) return;
      this.hoverIdx = null;
      this.tooltip.style.display = 'none';
      this.onHover(null);
      this.draw();
    });
  }

  _emitRangeStats() {
    if (!this.selection || !this.analysis?.points?.length) return;
    const [a, b] = this.selection;
    const pts = this.analysis.points;
    const distKm = Math.max(0, pts[b].distKm - pts[a].distKm);
    let gain = 0;
    let loss = 0;
    let lastE = pts[a].ele;
    for (let i = a + 1; i <= b; i++) {
      const e = pts[i].ele;
      if (e - lastE >= 2.0) {
        gain += e - lastE;
        lastE = e;
      } else if (lastE - e >= 2.0) {
        loss += lastE - e;
        lastE = e;
      }
    }
    const netEle = (pts[b].ele ?? 0) - (pts[a].ele ?? 0);
    const avgSlope = distKm > 0.01 ? (netEle / (distKm * 1000)) * 100 : 0;

    this.rangePill.style.display = 'flex';
    this.rangePill.innerHTML = `
      <span>选区 <b>${pts[a].distKm.toFixed(1)}–${pts[b].distKm.toFixed(1)} km</b> (${distKm.toFixed(2)} km)</span>
      <span>↑ <b>${Math.round(gain)} m</b></span>
      <span>↓ <b>${Math.round(loss)} m</b></span>
      <span>净坡 <b>${avgSlope.toFixed(1)}%</b></span>
      <button type="button" class="range-clear-btn" title="清除框选">✕</button>
    `;
    this.rangePill.querySelector('.range-clear-btn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.selection = null;
      this.rangePill.style.display = 'none';
      this.onRangeSelect(null);
      this.draw();
    });
    this.onRangeSelect({ startIdx: a, endIdx: b, startKm: pts[a].distKm, endKm: pts[b].distKm });
  }

  _updateTooltip(e, pt) {
    if (!pt) {
      this.tooltip.style.display = 'none';
      return;
    }
    const rect = this.wrap.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const leftSide = relX > rect.width * 0.72;
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = leftSide ? `${Math.max(8, relX - 154)}px` : `${Math.min(rect.width - 156, relX + 12)}px`;
    this.tooltip.innerHTML = `
      <div class="pt-row"><span>里程</span><b>${pt.distKm.toFixed(2)} km</b></div>
      <div class="pt-row"><span>海拔</span><b>${pt.ele !== null ? `${Math.round(pt.ele)} m` : '-'}</b></div>
      <div class="pt-row"><span>坡度</span><b style="color:${gradeColor(pt.gradePct)}">${pt.gradePct >= 0 ? '+' : ''}${pt.gradePct.toFixed(1)}%</b></div>
    `;
  }

  draw() {
    const rect = this.wrap.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width));
    const h = Math.max(120, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!this.analysis || !this.analysis.points.length || !this.analysis.hasElevation) {
      this.emptyMsg.style.display = 'flex';
      this.emptyMsg.textContent = this.analysis?.points?.length
        ? '正在从在线地形切片补全高程剖面...'
        : '当前路线暂无有效轨迹坐标';
      return;
    }
    this.emptyMsg.style.display = 'none';

    const { padLeft, padTop, plotW, plotH } = this._getLayout(w, h);
    const pts = this.analysis.points;
    const totalKm = Math.max(0.01, this.analysis.totalKm);
    const minE = this.analysis.minEleM;
    const maxE = this.analysis.maxEleM;
    const padE = Math.max(20, (maxE - minE) * 0.08);
    const yMin = Math.floor((minE - padE) / 10) * 10;
    const yMax = Math.ceil((maxE + padE) / 10) * 10;
    const ySpan = Math.max(20, yMax - yMin);

    const xFor = (km) => padLeft + (km / totalKm) * plotW;
    const yFor = (ele) => padTop + plotH - ((ele - yMin) / ySpan) * plotH;

    // Horizontal grid lines & altitude labels
    ctx.font = '10.5px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const val = yMin + (t / yTicks) * ySpan;
      const y = yFor(val);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#8b949e';
      ctx.fillText(`${Math.round(val)}m`, padLeft - 7, y);
    }

    // Distance X axis ticks
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = Math.max(4, Math.min(10, Math.floor(plotW / 110)));
    for (let t = 0; t <= xTicks; t++) {
      const km = (t / xTicks) * totalKm;
      const x = xFor(km);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();
      ctx.fillStyle = '#8b949e';
      ctx.fillText(`${km.toFixed(totalKm >= 20 ? 0 : 1)}km`, x, padTop + plotH + 6);
    }

    // Selected range highlight backdrop
    if (this.selection) {
      const [a, b] = this.selection;
      const x0 = xFor(pts[a].distKm);
      const x1 = xFor(pts[b].distKm);
      ctx.fillStyle = 'rgba(47, 129, 247, 0.14)';
      ctx.fillRect(x0, padTop, x1 - x0, plotH);
      ctx.strokeStyle = 'rgba(88, 166, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, padTop, x1 - x0, plotH);
    }

    // Area fill under elevation curve
    const areaGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    areaGrad.addColorStop(0, 'rgba(56, 189, 248, 0.28)');
    areaGrad.addColorStop(1, 'rgba(56, 189, 248, 0.02)');
    ctx.beginPath();
    pts.forEach((pt, idx) => {
      const x = xFor(pt.distKm);
      const y = yFor(pt.ele ?? yMin);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xFor(pts[pts.length - 1].distKm), padTop + plotH);
    ctx.lineTo(xFor(pts[0].distKm), padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = areaGrad;
    ctx.fill();

    // Grade-colored segments
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      ctx.strokeStyle = gradeColor(p1.gradePct);
      ctx.beginPath();
      ctx.moveTo(xFor(p0.distKm), yFor(p0.ele ?? yMin));
      ctx.lineTo(xFor(p1.distKm), yFor(p1.ele ?? yMin));
      ctx.stroke();
    }

    // POI markers projected onto curve
    const pois = this.analysis.projectedPois || [];
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    let lastLabelX = -100;
    for (const poi of pois) {
      if (poi.snapOffsetKm > 1.5) continue;
      const px = xFor(poi.distKm);
      const pe = poi.ele !== null ? poi.ele : yMin;
      const py = yFor(pe);
      const col = this.poiColors[poi.poiKind] || '#f59e0b';

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px, py, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0d0f12';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      if (px - lastLabelX > 62) {
        const shortName = poi.name.length > 7 ? `${poi.name.slice(0, 6)}…` : poi.name;
        ctx.fillStyle = 'rgba(230, 237, 243, 0.85)';
        ctx.fillText(shortName, px, Math.max(padTop + 10, py - 6));
        lastLabelX = px;
      }
    }

    // Hover indicator
    if (this.hoverIdx !== null && pts[this.hoverIdx]) {
      const hp = pts[this.hoverIdx];
      const hx = xFor(hp.distKm);
      const hy = yFor(hp.ele ?? yMin);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padTop);
      ctx.lineTo(hx, padTop + plotH);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1f6feb';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}
