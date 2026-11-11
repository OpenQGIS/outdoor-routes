/**
 * Pure procedural vector topographic contour canvas for the Landing Screen.
 * Zero external tile dependencies; crisp on high-DPI displays.
 */

function terrainField(x, y) {
  // Multi-ridge deterministic topographic scalar field
  const a = Math.sin(x * 1.35 + Math.cos(y * 1.15) * 0.85);
  const b = Math.cos(y * 1.6 - Math.sin(x * 0.9) * 0.9);
  const c = Math.sin((x + y) * 2.3 + 0.6) * 0.45;
  const d = Math.cos((x - y) * 3.1 - 0.4) * 0.28;
  const ridge = Math.exp(-Math.pow((x - 0.15) * 0.85, 2) - Math.pow((y + 0.1) * 0.95, 2)) * 1.35;
  const peak2 = Math.exp(-Math.pow((x + 0.9) * 1.05, 2) - Math.pow((y - 0.55) * 1.1, 2)) * 1.1;
  const peak3 = Math.exp(-Math.pow((x - 0.95) * 1.1, 2) - Math.pow((y + 0.65) * 1.0, 2)) * 1.05;
  return a * 0.55 + b * 0.48 + c + d + ridge + peak2 + peak3;
}

function interp(v1, v2, level) {
  const denom = v2 - v1;
  if (Math.abs(denom) < 1e-6) return 0.5;
  return Math.max(0, Math.min(1, (level - v1) / denom));
}

function hexToRgb(hex) {
  const clean = String(hex || '#2f81f7').replace('#', '');
  if (clean.length !== 6) return [47, 129, 247];
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16)
  ];
}

export class ContourBackground {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.accentRgb = [148, 163, 184];
    this.targetRgb = [148, 163, 184];
    this.gridCols = 116;
    this.gridRows = 72;
    this.grid = null;
    this.minVal = 0;
    this.maxVal = 1;
    this._raf = null;
    this._resizeObserver = null;

    this._buildField();
    this._bindResize();
    this.render();
  }

  _buildField() {
    const cols = this.gridCols;
    const rows = this.gridRows;
    const grid = new Float32Array((cols + 1) * (rows + 1));
    let minV = Infinity;
    let maxV = -Infinity;

    for (let j = 0; j <= rows; j++) {
      const ny = (j / rows - 0.5) * 3.1;
      for (let i = 0; i <= cols; i++) {
        const nx = (i / cols - 0.5) * 4.4;
        const val = terrainField(nx, ny);
        grid[j * (cols + 1) + i] = val;
        if (val < minV) minV = val;
        if (val > maxV) maxV = val;
      }
    }
    this.grid = grid;
    this.minVal = minV;
    this.maxVal = maxV;
  }

  _bindResize() {
    if (window.ResizeObserver && this.canvas.parentElement) {
      this._resizeObserver = new ResizeObserver(() => this.render());
      this._resizeObserver.observe(this.canvas.parentElement);
    }
    window.addEventListener('resize', () => this.render());
  }

  setAccentColor(hex) {
    this.targetRgb = hex ? hexToRgb(hex) : [148, 163, 184];
    if (!this._raf) {
      this._animateAccent();
    }
  }

  _animateAccent() {
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const diff = this.targetRgb[i] - this.accentRgb[i];
      if (Math.abs(diff) > 0.8) {
        this.accentRgb[i] += diff * 0.16;
        changed = true;
      } else {
        this.accentRgb[i] = this.targetRgb[i];
      }
    }
    this.render();
    if (changed) {
      this._raf = requestAnimationFrame(() => this._animateAccent());
    } else {
      this._raf = null;
    }
  }

  render() {
    const canvas = this.canvas;
    if (!canvas || !this.ctx) return;
    const rect = canvas.parentElement?.getBoundingClientRect() || { width: window.innerWidth, height: window.innerHeight };
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(240, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Light topographic paper base
    ctx.fillStyle = '#f4f6f9';
    ctx.fillRect(0, 0, w, h);

    // Subtle graticule grid
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.04)';
    ctx.lineWidth = 1;
    const stepX = Math.max(96, Math.floor(w / 10));
    const stepY = Math.max(96, Math.floor(h / 6));
    ctx.beginPath();
    for (let x = stepX; x < w; x += stepX) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = stepY; y < h; y += stepY) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    const cols = this.gridCols;
    const rows = this.gridRows;
    const cw = w / cols;
    const ch = h / rows;
    const grid = this.grid;
    const levels = 24;
    const span = this.maxVal - this.minVal || 1;
    const [ar, ag, ab] = this.accentRgb.map((v) => Math.round(v));

    for (let l = 1; l < levels; l++) {
      const level = this.minVal + (l / levels) * span;
      const isIndex = l % 4 === 0;
      const alpha = isIndex ? 0.28 : 0.14;
      ctx.strokeStyle = isIndex
        ? `rgba(${ar}, ${ag}, ${ab}, ${alpha})`
        : `rgba(100, 116, 139, ${alpha})`;
      ctx.lineWidth = isIndex ? 1.25 : 0.75;
      ctx.beginPath();

      for (let j = 0; j < rows; j++) {
        const y0 = j * ch;
        const y1 = y0 + ch;
        const rowOff = j * (cols + 1);
        const nextRowOff = (j + 1) * (cols + 1);

        for (let i = 0; i < cols; i++) {
          const v0 = grid[rowOff + i];
          const v1 = grid[rowOff + i + 1];
          const v2 = grid[nextRowOff + i + 1];
          const v3 = grid[nextRowOff + i];

          const mask =
            (v0 >= level ? 8 : 0) |
            (v1 >= level ? 4 : 0) |
            (v2 >= level ? 2 : 0) |
            (v3 >= level ? 1 : 0);

          if (mask === 0 || mask === 15) continue;

          const x0 = i * cw;
          const x1 = x0 + cw;
          const top = [x0 + cw * interp(v0, v1, level), y0];
          const right = [x1, y0 + ch * interp(v1, v2, level)];
          const bottom = [x0 + cw * interp(v3, v2, level), y1];
          const left = [x0, y0 + ch * interp(v0, v3, level)];

          const segs = [];
          switch (mask) {
            case 1: case 14: segs.push([left, bottom]); break;
            case 2: case 13: segs.push([bottom, right]); break;
            case 3: case 12: segs.push([left, right]); break;
            case 4: case 11: segs.push([top, right]); break;
            case 5: segs.push([left, top], [bottom, right]); break;
            case 6: case 9: segs.push([top, bottom]); break;
            case 7: case 8: segs.push([left, top]); break;
            case 10: segs.push([top, right], [left, bottom]); break;
          }

          for (const [pA, pB] of segs) {
            ctx.moveTo(pA[0], pA[1]);
            ctx.lineTo(pB[0], pB[1]);
          }
        }
      }
      ctx.stroke();
    }

    // Soft radial vignette so center cards stand out crisply
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.15, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    grad.addColorStop(0, 'rgba(244, 246, 249, 0.05)');
    grad.addColorStop(1, 'rgba(226, 232, 240, 0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
}
