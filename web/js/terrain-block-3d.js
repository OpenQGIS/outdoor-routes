/**
 * Three.js 3D Terrain Block (3D 地形方块图) powered by online Terrarium DEM tiles
 * and selectable satellite / topo / procedural contour textures.
 */
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TEXTURE_TILE_URLS = {
  'esri-sat': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  opentopomap: 'https://tile.opentopomap.org/{z}/{x}/{y}.png'
};

function lngLatToTileFrac(lng, lat, z) {
  const n = Math.pow(2, z);
  const x = ((lng + 180) / 360) * n;
  const latRad = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return [x, y];
}

function chooseTileZoom(bounds, maxTilesPerAxis = 4) {
  const [minLng, minLat, maxLng, maxLat] = bounds;
  for (let z = 14; z >= 6; z--) {
    const [x0, y1] = lngLatToTileFrac(minLng, minLat, z);
    const [x1, y0] = lngLatToTileFrac(maxLng, maxLat, z);
    const spanX = Math.floor(x1) - Math.floor(x0) + 1;
    const spanY = Math.floor(y1) - Math.floor(y0) + 1;
    if (spanX <= maxTilesPerAxis && spanY <= maxTilesPerAxis && spanX * spanY <= 16) {
      return z;
    }
  }
  return 9;
}

const _corsImgCache = new Map();

function loadCorsImage(url) {
  if (_corsImgCache.has(url)) return _corsImgCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  if (_corsImgCache.size > 160) {
    const first = _corsImgCache.keys().next().value;
    _corsImgCache.delete(first);
  }
  _corsImgCache.set(url, p);
  return p;
}

function computePaddedBounds(fc) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (const feat of fc?.features || []) {
    const g = feat.geometry;
    if (!g) continue;
    if (g.type === 'LineString') {
      for (const c of g.coordinates || []) {
        if (c[0] < minLng) minLng = c[0];
        if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      }
    } else if (g.type === 'Point' && Array.isArray(g.coordinates)) {
      const c = g.coordinates;
      if (c[0] < minLng) minLng = c[0];
      if (c[0] > maxLng) maxLng = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    }
  }

  if (!Number.isFinite(minLng)) return null;
  const padLng = Math.max(0.012, (maxLng - minLng) * 0.22);
  const padLat = Math.max(0.012, (maxLat - minLat) * 0.22);
  return [minLng - padLng, minLat - padLat, maxLng + padLng, maxLat + padLat];
}

function makeSpriteLabel(text, accentColor = '#ffffff') {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = '600 22px "PingFang SC", "Microsoft YaHei", sans-serif';
  const metrics = ctx.measureText(text);
  const padX = 14;
  const w = Math.min(340, Math.ceil(metrics.width + padX * 2));
  const h = 38;
  canvas.width = w;
  canvas.height = h;

  ctx.fillStyle = 'rgba(13, 17, 23, 0.86)';
  ctx.beginPath();
  ctx.roundRect(1, 1, w - 2, h - 2, 10);
  ctx.fill();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = '600 20px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#f0f6fc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 1, w - padX);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set((w / 38) * 3.2, 3.2, 1);
  return sprite;
}

export class TerrainBlockViewer {
  constructor(containerEl, options = {}) {
    this.containerEl = containerEl;
    this.poiColors = options.poiColors || {};
    this.onStatusChange = options.onStatusChange || (() => {});

    this.gridSegs = 96; // 97x97 vertices -> ~18k triangles, crisp and silky smooth
    this.exaggeration = 1.6;
    this.textureMode = 'esri-sat'; // 'esri-sat' | 'opentopomap' | 'contour-dark'
    this.currentFc = null;
    this.currentCategoryColor = '#E85D04';
    this.currentRouteName = '';
    this.bounds = null;
    this.blockW = 100;
    this.blockD = 100;
    this.metersToWorld = 0.002;
    this.baseEleM = 0;
    this.heightGrid = null; // Float32Array((gridSegs+1)^2)
    this.demLoaded = false;

    this.terrainGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.hoverMarker = null;
    this.rangeHighlightMesh = null;
    this._loadToken = 0;
    this._disposed = false;

    this._initScene();
  }

  _initScene() {
    const w = Math.max(300, this.containerEl.clientWidth || 640);
    const h = Math.max(240, this.containerEl.clientHeight || 420);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e13);

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.5, 1200);
    this.camera.position.set(78, 68, 92);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.containerEl.innerHTML = '';
    this.containerEl.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.minDistance = 24;
    this.controls.maxDistance = 280;

    // Lighting tailored for relief clarity
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.05);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff7ed, 1.35);
    sun.position.set(75, 110, 55);
    this.scene.add(sun);

    const rim = new THREE.DirectionalLight(0x60a5fa, 0.42);
    rim.position.set(-80, 40, -70);
    this.scene.add(rim);

    // Subtle ground grid ring below block
    const gridHelper = new THREE.GridHelper(180, 24, 0x26303d, 0x151a22);
    gridHelper.position.y = -0.25;
    this.scene.add(gridHelper);

    this.scene.add(this.terrainGroup);
    this.scene.add(this.overlayGroup);

    // Hover sync orb + pin
    const orbGroup = new THREE.Group();
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.75, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45 })
    );
    orbGroup.add(orb, halo);
    orbGroup.visible = false;
    this.hoverMarker = orbGroup;
    this.scene.add(this.hoverMarker);

    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.containerEl);
    }

    const tick = () => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  resize() {
    if (!this.renderer || !this.containerEl) return;
    const w = Math.max(200, this.containerEl.clientWidth);
    const h = Math.max(180, this.containerEl.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      child.traverse?.((obj) => {
        obj.geometry?.dispose?.();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => {
            m.map?.dispose?.();
            m.dispose?.();
          });
        } else if (obj.material) {
          obj.material.map?.dispose?.();
          obj.material.dispose?.();
        }
      });
    }
  }

  async loadRoute(fc, { categoryColor = '#E85D04', routeName = '' } = {}) {
    const token = ++this._loadToken;
    this.currentFc = fc;
    this.currentCategoryColor = categoryColor;
    this.currentRouteName = routeName;
    this.bounds = computePaddedBounds(fc);
    this.hoverMarker.visible = false;

    if (!this.bounds) {
      this._clearGroup(this.terrainGroup);
      this._clearGroup(this.overlayGroup);
      this.onStatusChange({ loading: false, message: '暂无轨迹坐标' });
      return;
    }

    const [minLng, minLat, maxLng, maxLat] = this.bounds;
    const midLat = (minLat + maxLat) / 2;
    const widthKm = Math.max(0.2, (maxLng - minLng) * 111.32 * Math.cos((midLat * Math.PI) / 180));
    const depthKm = Math.max(0.2, (maxLat - minLat) * 110.57);
    const maxKm = Math.max(widthKm, depthKm);

    this.blockW = (widthKm / maxKm) * 100;
    this.blockD = (depthKm / maxKm) * 100;
    this.metersToWorld = 100 / (maxKm * 1000);

    this.onStatusChange({ loading: true, message: '正在拉取在线地形 DEM 切片...' });

    // Fetch DEM grid & build 3D block
    const demResult = await this._fetchDemGrid(this.bounds);
    if (token !== this._loadToken) return;

    this.heightGrid = demResult.grid;
    this.demLoaded = demResult.fromOnlineDem;
    this._computeBaseElevation();

    const surfaceTex = await this._buildSurfaceTexture(this.bounds, this.textureMode);
    if (token !== this._loadToken) return;

    this._rebuildTerrainMeshes(surfaceTex);
    this._rebuildRouteOverlays();
    this.setCameraPreset('iso');

    this.onStatusChange({
      loading: false,
      fromOnlineDem: this.demLoaded,
      message: this.demLoaded ? '在线 DEM 地形方块就绪' : '离线降级：使用轨迹高程构建地形块'
    });
  }

  async _fetchDemGrid(bounds) {
    const n = this.gridSegs + 1;
    const grid = new Float32Array(n * n);
    const [minLng, minLat, maxLng, maxLat] = bounds;
    const z = chooseTileZoom(bounds, 4);

    const [txMinF, tyMaxF] = lngLatToTileFrac(minLng, minLat, z);
    const [txMaxF, tyMinF] = lngLatToTileFrac(maxLng, maxLat, z);
    const tx0 = Math.floor(txMinF);
    const tx1 = Math.floor(txMaxF);
    const ty0 = Math.floor(tyMinF);
    const ty1 = Math.floor(tyMaxF);

    const cols = tx1 - tx0 + 1;
    const rows = ty1 - ty0 + 1;
    const tileMap = new Map();
    const tasks = [];

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const url = TERRARIUM_URL.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
        tasks.push(
          loadCorsImage(url).then((img) => {
            if (img && img.naturalWidth) {
              tileMap.set(`${tx}_${ty}`, img);
            }
          })
        );
      }
    }

    await Promise.all(tasks);

    if (tileMap.size > 0) {
      // Stitch into one offscreen canvas to read RGBA pixels once
      const canvas = document.createElement('canvas');
      canvas.width = cols * 256;
      canvas.height = rows * 256;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const img = tileMap.get(`${tx}_${ty}`);
          if (img) {
            ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256, 256, 256);
          }
        }
      }
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const cw = canvas.width;
      const ch = canvas.height;

      for (let j = 0; j < n; j++) {
        const lat = maxLat - (j / this.gridSegs) * (maxLat - minLat);
        for (let i = 0; i < n; i++) {
          const lng = minLng + (i / this.gridSegs) * (maxLng - minLng);
          const [fx, fy] = lngLatToTileFrac(lng, lat, z);
          const px = Math.max(0, Math.min(cw - 1, Math.round((fx - tx0) * 256)));
          const py = Math.max(0, Math.min(ch - 1, Math.round((fy - ty0) * 256)));
          const off = (py * cw + px) * 4;
          const r = imgData[off];
          const g = imgData[off + 1];
          const b = imgData[off + 2];
          const ele = r * 256 + g + b / 256 - 32768;
          grid[j * n + i] = Number.isFinite(ele) && ele > -500 && ele < 9000 ? ele : 0;
        }
      }
      return { grid, fromOnlineDem: true };
    }

    // Fallback: interpolate elevation from track Z coordinates (offline safety)
    const samplePts = [];
    for (const feat of this.currentFc?.features || []) {
      if (feat.geometry?.type === 'LineString') {
        const coords = feat.geometry.coordinates || [];
        const step = Math.max(1, Math.floor(coords.length / 80));
        for (let i = 0; i < coords.length; i += step) {
          const c = coords[i];
          if (c.length >= 3 && Number.isFinite(c[2])) {
            samplePts.push(c);
          }
        }
      }
    }
    if (!samplePts.length) {
      grid.fill(1000);
      return { grid, fromOnlineDem: false };
    }
    for (let j = 0; j < n; j++) {
      const lat = maxLat - (j / this.gridSegs) * (maxLat - minLat);
      for (let i = 0; i < n; i++) {
        const lng = minLng + (i / this.gridSegs) * (maxLng - minLng);
        let num = 0;
        let den = 0;
        for (const p of samplePts) {
          const d2 = (p[0] - lng) ** 2 + (p[1] - lat) ** 2 + 1e-7;
          const w = 1 / d2;
          num += p[2] * w;
          den += w;
        }
        grid[j * n + i] = den > 0 ? num / den : 1000;
      }
    }
    return { grid, fromOnlineDem: false };
  }

  _computeBaseElevation() {
    let minE = Infinity;
    let maxE = -Infinity;
    for (let i = 0; i < this.heightGrid.length; i++) {
      const e = this.heightGrid[i];
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
    }
    const relief = Math.max(50, maxE - minE);
    // Keep a sturdy geological skirt even if relief is small
    this.minTerrainEleM = minE;
    this.maxTerrainEleM = maxE;
    this.baseEleM = minE - Math.max(120, relief * 0.22);
  }

  sampleElevation(lng, lat) {
    if (!this.bounds || !this.heightGrid) return null;
    const [minLng, minLat, maxLng, maxLat] = this.bounds;
    const u = Math.max(0, Math.min(1, (lng - minLng) / (maxLng - minLng || 1)));
    const v = Math.max(0, Math.min(1, (maxLat - lat) / (maxLat - minLat || 1)));
    const n = this.gridSegs + 1;
    const fx = u * this.gridSegs;
    const fy = v * this.gridSegs;
    const i0 = Math.min(this.gridSegs - 1, Math.floor(fx));
    const j0 = Math.min(this.gridSegs - 1, Math.floor(fy));
    const tx = fx - i0;
    const ty = fy - j0;

    const h00 = this.heightGrid[j0 * n + i0];
    const h10 = this.heightGrid[j0 * n + i0 + 1];
    const h01 = this.heightGrid[(j0 + 1) * n + i0];
    const h11 = this.heightGrid[(j0 + 1) * n + i0 + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  }

  _lngLatToWorld(lng, lat, eleM = null) {
    const [minLng, minLat, maxLng, maxLat] = this.bounds;
    const u = (lng - minLng) / (maxLng - minLng || 1);
    const v = (maxLat - lat) / (maxLat - minLat || 1);
    const x = (u - 0.5) * this.blockW;
    const z = (v - 0.5) * this.blockD;
    const terrainE = this.sampleElevation(lng, lat) ?? this.minTerrainEleM;
    const targetE = Number.isFinite(eleM) ? Math.max(terrainE, eleM) : terrainE;
    const y = Math.max(0.2, (targetE - this.baseEleM) * this.metersToWorld * this.exaggeration);
    return new THREE.Vector3(x, y, z);
  }

  async _buildSurfaceTexture(bounds, mode) {
    if (mode !== 'contour-dark' && TEXTURE_TILE_URLS[mode]) {
      const tex = await this._fetchTiledTexture(bounds, TEXTURE_TILE_URLS[mode]);
      if (tex) return tex;
    }
    return this._buildProceduralContourTexture();
  }

  async _fetchTiledTexture(bounds, urlTemplate) {
    const [minLng, minLat, maxLng, maxLat] = bounds;
    const z = chooseTileZoom(bounds, 4);
    const [txMinF, tyMaxF] = lngLatToTileFrac(minLng, minLat, z);
    const [txMaxF, tyMinF] = lngLatToTileFrac(maxLng, maxLat, z);
    const tx0 = Math.floor(txMinF);
    const tx1 = Math.floor(txMaxF);
    const ty0 = Math.floor(tyMinF);
    const ty1 = Math.floor(tyMaxF);

    const tileMap = new Map();
    const tasks = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const url = urlTemplate.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
        tasks.push(
          loadCorsImage(url).then((img) => {
            if (img && img.naturalWidth) tileMap.set(`${tx}_${ty}`, img);
          })
        );
      }
    }
    await Promise.all(tasks);
    if (!tileMap.size) return null;

    const cols = tx1 - tx0 + 1;
    const rows = ty1 - ty0 + 1;
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = cols * 256;
    srcCanvas.height = rows * 256;
    const sctx = srcCanvas.getContext('2d');
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const img = tileMap.get(`${tx}_${ty}`);
        if (img) sctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256, 256, 256);
      }
    }

    // Crop exact bounds onto a 1024x1024 texture canvas
    const outCanvas = document.createElement('canvas');
    outCanvas.width = 1024;
    outCanvas.height = 1024;
    const octx = outCanvas.getContext('2d');
    const sx = (txMinF - tx0) * 256;
    const sy = (tyMinF - ty0) * 256;
    const sw = Math.max(4, (txMaxF - txMinF) * 256);
    const sh = Math.max(4, (tyMaxF - tyMinF) * 256);
    octx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, 1024, 1024);

    const tex = new THREE.CanvasTexture(outCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  _buildProceduralContourTexture() {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const n = this.gridSegs + 1;
    const minE = this.minTerrainEleM;
    const span = Math.max(20, this.maxTerrainEleM - minE);
    const interval = span > 1800 ? 100 : (span > 600 ? 50 : 25);

    for (let py = 0; py < size; py++) {
      const fy = (py / (size - 1)) * this.gridSegs;
      const j0 = Math.min(this.gridSegs - 1, Math.floor(fy));
      const ty = fy - j0;
      for (let px = 0; px < size; px++) {
        const fx = (px / (size - 1)) * this.gridSegs;
        const i0 = Math.min(this.gridSegs - 1, Math.floor(fx));
        const tx = fx - i0;

        const h00 = this.heightGrid[j0 * n + i0];
        const h10 = this.heightGrid[j0 * n + i0 + 1];
        const h01 = this.heightGrid[(j0 + 1) * n + i0];
        const h11 = this.heightGrid[(j0 + 1) * n + i0 + 1];
        const e = (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
        const norm = (e - minE) / span;

        // Dark hypsometric slate palette
        let r = 20 + norm * 36;
        let g = 28 + norm * 42;
        let b = 38 + norm * 44;

        // Crisp contour lines
        const mod = Math.abs((e % interval) / interval);
        if (mod < 0.075 || mod > 0.925) {
          const isMajor = Math.abs((e % (interval * 5)) / (interval * 5)) < 0.08;
          r += isMajor ? 52 : 24;
          g += isMajor ? 68 : 32;
          b += isMajor ? 82 : 42;
        }

        const off = (py * size + px) * 4;
        data[off] = Math.min(255, r);
        data[off + 1] = Math.min(255, g);
        data[off + 2] = Math.min(255, b);
        data[off + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  async setTextureMode(mode) {
    this.textureMode = mode;
    if (!this.bounds || !this.heightGrid) return;
    this.onStatusChange({ loading: true, message: '切换 3D 地形贴图...' });
    const tex = await this._buildSurfaceTexture(this.bounds, mode);
    this._rebuildTerrainMeshes(tex);
    this.onStatusChange({ loading: false, fromOnlineDem: this.demLoaded, message: '贴图已更新' });
  }

  setExaggeration(factor) {
    this.exaggeration = Math.max(0.5, Math.min(4.0, Number(factor) || 1.5));
    if (!this.heightGrid) return;
    const topMesh = this.terrainGroup.getObjectByName('terrain-top');
    const currentTex = topMesh?.material?.map || null;
    if (currentTex) currentTex._keepAlive = true;
    this._rebuildTerrainMeshes(currentTex);
    this._rebuildRouteOverlays();
  }

  _rebuildTerrainMeshes(surfaceTex) {
    // Preserve texture if reusing across exaggeration slider
    while (this.terrainGroup.children.length) {
      const child = this.terrainGroup.children.pop();
      child.geometry?.dispose?.();
      if (child.material) {
        if (child.material.map && !child.material.map._keepAlive) {
          child.material.map.dispose();
        }
        child.material.dispose();
      }
    }
    if (surfaceTex) delete surfaceTex._keepAlive;

    const segs = this.gridSegs;
    const n = segs + 1;

    // 1. Top surface geometry
    const topGeo = new THREE.PlaneGeometry(this.blockW, this.blockD, segs, segs);
    topGeo.rotateX(-Math.PI / 2);
    const posAttr = topGeo.attributes.position;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const ele = this.heightGrid[idx];
        const y = Math.max(0.2, (ele - this.baseEleM) * this.metersToWorld * this.exaggeration);
        posAttr.setY(idx, y);
      }
    }
    topGeo.computeVertexNormals();

    const topMat = new THREE.MeshStandardMaterial({
      map: surfaceTex || null,
      color: surfaceTex ? 0xffffff : 0x334155,
      roughness: 0.86,
      metalness: 0.04
    });
    const topMesh = new THREE.Mesh(topGeo, topMat);
    topMesh.name = 'terrain-top';
    this.terrainGroup.add(topMesh);

    // 2. Four vertical geological skirt walls down to y = 0
    const wallPositions = [];
    const wallColors = [];
    const pushQuad = (a, b, c, d, shade) => {
      // Two triangles: a-b-c and a-c-d
      const verts = [a, b, c, a, c, d];
      for (const v of verts) {
        wallPositions.push(v[0], v[1], v[2]);
        const f = v[1] > 0.01 ? shade : shade * 0.55;
        wallColors.push(0.11 * f, 0.14 * f, 0.18 * f);
      }
    };

    const getTopPoint = (i, j) => {
      const idx = j * n + i;
      return [posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx)];
    };

    // North edge (j = 0), South edge (j = segs), West edge (i = 0), East edge (i = segs)
    for (let i = 0; i < segs; i++) {
      const n0 = getTopPoint(i, 0);
      const n1 = getTopPoint(i + 1, 0);
      pushQuad(n1, n0, [n0[0], 0, n0[2]], [n1[0], 0, n1[2]], 1.0);

      const s0 = getTopPoint(i, segs);
      const s1 = getTopPoint(i + 1, segs);
      pushQuad(s0, s1, [s1[0], 0, s1[2]], [s0[0], 0, s0[2]], 1.15);
    }
    for (let j = 0; j < segs; j++) {
      const w0 = getTopPoint(0, j);
      const w1 = getTopPoint(0, j + 1);
      pushQuad(w0, w1, [w1[0], 0, w1[2]], [w0[0], 0, w0[2]], 0.9);

      const e0 = getTopPoint(segs, j);
      const e1 = getTopPoint(segs, j + 1);
      pushQuad(e1, e0, [e0[0], 0, e0[2]], [e1[0], 0, e1[2]], 1.05);
    }

    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
    wallGeo.setAttribute('color', new THREE.Float32BufferAttribute(wallColors, 3));
    wallGeo.computeVertexNormals();
    const wallMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.05,
      side: THREE.DoubleSide
    });
    this.terrainGroup.add(new THREE.Mesh(wallGeo, wallMat));

    // 3. Bottom base slab
    const baseGeo = new THREE.PlaneGeometry(this.blockW, this.blockD);
    baseGeo.rotateX(Math.PI / 2);
    const baseMat = new THREE.MeshBasicMaterial({ color: 0x0d1117 });
    this.terrainGroup.add(new THREE.Mesh(baseGeo, baseMat));
  }

  _rebuildRouteOverlays() {
    this._clearGroup(this.overlayGroup);
    if (!this.currentFc || !this.bounds) return;

    const lineColor = new THREE.Color(this.currentCategoryColor);
    const routeMat = new THREE.MeshStandardMaterial({
      color: lineColor,
      emissive: lineColor,
      emissiveIntensity: 0.45,
      roughness: 0.3
    });

    for (const feat of this.currentFc.features || []) {
      const g = feat.geometry;
      if (g?.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
        const coords = g.coordinates;
        const step = Math.max(1, Math.floor(coords.length / 450));
        const vecs = [];
        for (let i = 0; i < coords.length; i += step) {
          const c = coords[i];
          const v = this._lngLatToWorld(c[0], c[1], null);
          v.y += 0.45;
          vecs.push(v);
        }
        const last = coords[coords.length - 1];
        const lastV = this._lngLatToWorld(last[0], last[1], null);
        lastV.y += 0.45;
        vecs.push(lastV);

        if (vecs.length >= 2) {
          const curve = new THREE.CatmullRomCurve3(vecs);
          const tubeGeo = new THREE.TubeGeometry(curve, Math.min(480, vecs.length * 2), 0.34, 6, false);
          this.overlayGroup.add(new THREE.Mesh(tubeGeo, routeMat));
        }
      }
    }

    // POIs (limit floating text sprites to <= 16 to stay clean)
    const pois = (this.currentFc.features || []).filter((f) => f.geometry?.type === 'Point');
    let labelCount = 0;
    for (const feat of pois) {
      const [lng, lat] = feat.geometry.coordinates;
      const props = feat.properties || {};
      const kind = props.poi_kind || 'waypoint';
      const hex = this.poiColors[kind] || '#f59e0b';
      const basePos = this._lngLatToWorld(lng, lat, null);

      const pinHeight = 4.2;
      const stemGeo = new THREE.CylinderGeometry(0.11, 0.11, pinHeight, 8);
      const stemMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
      const stem = new THREE.Mesh(stemGeo, stemMat);
      stem.position.set(basePos.x, basePos.y + pinHeight / 2, basePos.z);
      this.overlayGroup.add(stem);

      const capGeo = new THREE.SphereGeometry(0.55, 12, 12);
      const capMat = new THREE.MeshBasicMaterial({ color: hex });
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.set(basePos.x, basePos.y + pinHeight + 0.3, basePos.z);
      this.overlayGroup.add(cap);

      if (labelCount < 16 && props.name) {
        const sprite = makeSpriteLabel(props.name, hex);
        sprite.position.set(basePos.x, basePos.y + pinHeight + 2.6, basePos.z);
        this.overlayGroup.add(sprite);
        labelCount++;
      }
    }
  }

  setHoverLngLat(lng, lat) {
    if (!this.hoverMarker) return;
    if (lng === null || lat === null || !this.bounds) {
      this.hoverMarker.visible = false;
      return;
    }
    const pos = this._lngLatToWorld(lng, lat, null);
    this.hoverMarker.position.set(pos.x, pos.y + 0.85, pos.z);
    this.hoverMarker.visible = true;
  }

  focusLngLat(lng, lat) {
    if (!this.bounds) return;
    const pos = this._lngLatToWorld(lng, lat, null);
    this.controls.target.copy(pos);
    this.setHoverLngLat(lng, lat);
  }

  setCameraPreset(preset) {
    const center = new THREE.Vector3(0, 6, 0);
    this.controls.target.copy(center);
    if (preset === 'top') {
      this.camera.position.set(0.01, 138, 12);
    } else if (preset === 'side') {
      this.camera.position.set(105, 28, 72);
    } else {
      // 'iso'
      this.camera.position.set(76, 66, 86);
    }
    this.controls.update();
  }

  exportSnapshotPng(filename = 'terrain-block.png', titleText = '') {
    this.renderer.render(this.scene, this.camera);
    const glCanvas = this.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = glCanvas.width;
    out.height = glCanvas.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(glCanvas, 0, 0);

    if (titleText) {
      const pad = Math.round(out.width * 0.025);
      ctx.fillStyle = 'rgba(11, 14, 19, 0.72)';
      ctx.fillRect(0, out.height - 54, out.width, 54);
      ctx.font = 'bold 22px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#f0f6fc';
      ctx.textBaseline = 'middle';
      ctx.fillText(titleText, pad, out.height - 27);
    }

    const url = out.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this._clearGroup(this.terrainGroup);
    this._clearGroup(this.overlayGroup);
    this.controls?.dispose();
    this.renderer?.dispose();
  }
}
