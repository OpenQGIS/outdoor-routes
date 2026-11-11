/**
 * Shared Leaflet basemap configurations, Bing QuadKey layer,
 * Esri Hillshade helper, and pure-frontend GCJ-02 -> WGS-84 tile correction.
 */

export function tileToQuadKey(x, y, z) {
  let quad = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quad += digit;
  }
  return quad;
}

export const BingTileLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    const subdomains = this.options.subdomains || ['0', '1', '2', '3'];
    const idx = Math.abs(coords.x + coords.y) % subdomains.length;
    const quad = tileToQuadKey(coords.x, coords.y, coords.z);
    return L.Util.template(this._url, { s: subdomains[idx], q: quad });
  }
});

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}

function pixelToWgs84(px, py, z) {
  const worldSize = 256 * Math.pow(2, z);
  const lng = (px / worldSize) * 360.0 - 180.0;
  const n = Math.PI - (2.0 * Math.PI * py) / worldSize;
  const lat = (180.0 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lat, lng];
}

function wgs84ToPixel(lat, lng, z) {
  const worldSize = 256 * Math.pow(2, z);
  const x = ((lng + 180.0) / 360.0) * worldSize;
  const sinLat = Math.sin((lat * Math.PI) / 180.0);
  const clamped = Math.max(-0.9999, Math.min(0.9999, sinLat));
  const y = (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * worldSize;
  return [x, y];
}

const _gcjImageCache = new Map();

function loadCachedTileImage(url) {
  if (_gcjImageCache.has(url)) return _gcjImageCache.get(url);
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  if (_gcjImageCache.size > 300) {
    const firstKey = _gcjImageCache.keys().next().value;
    _gcjImageCache.delete(firstKey);
  }
  _gcjImageCache.set(url, promise);
  return promise;
}

export const Gcj02Wgs84TileLayer = L.GridLayer.extend({
  initialize(urlTemplate, options = {}) {
    this._urlTemplate = urlTemplate;
    L.GridLayer.prototype.initialize.call(this, { tileSize: 256, ...options });
  },
  onAdd(mapInst) {
    L.GridLayer.prototype.onAdd.call(this, mapInst);
    this.on('tileunload', this._onTileUnload, this);
  },
  onRemove(mapInst) {
    this.off('tileunload', this._onTileUnload, this);
    L.GridLayer.prototype.onRemove.call(this, mapInst);
  },
  _onTileUnload(ev) {
    if (ev.tile) ev.tile._cancelled = true;
  },
  _buildUrl(x, y, z) {
    const subdomains = this.options.subdomains || ['1', '2', '3', '4'];
    const s = subdomains[Math.abs(x + y) % subdomains.length];
    return L.Util.template(this._urlTemplate, { s, x, y, z });
  },
  createTile(coords, done) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    canvas._cancelled = false;

    const z = coords.z;
    const maxTiles = Math.pow(2, z);
    const wx0 = coords.x * 256;
    const wy0 = coords.y * 256;
    const [centerLat, centerLng] = pixelToWgs84(wx0 + 128, wy0 + 128, z);

    let dx = 0;
    let dy = 0;
    if (!outOfChina(centerLat, centerLng)) {
      const [gcjLat, gcjLng] = wgs84ToGcj02(centerLat, centerLng);
      const [gxCenter, gyCenter] = wgs84ToPixel(gcjLat, gcjLng, z);
      dx = gxCenter - (wx0 + 128);
      dy = gyCenter - (wy0 + 128);
    }

    const srcLeft = wx0 + dx;
    const srcTop = wy0 + dy;
    const txMin = Math.floor(srcLeft / 256);
    const txMax = Math.floor((srcLeft + 255.999) / 256);
    const tyMin = Math.floor(srcTop / 256);
    const tyMax = Math.floor((srcTop + 255.999) / 256);

    const tasks = [];
    for (let ty = tyMin; ty <= tyMax; ty++) {
      if (ty < 0 || ty >= maxTiles) continue;
      for (let tx = txMin; tx <= txMax; tx++) {
        const wrappedTx = ((tx % maxTiles) + maxTiles) % maxTiles;
        const url = this._buildUrl(wrappedTx, ty, z);
        tasks.push({ tx, ty, promise: loadCachedTileImage(url) });
      }
    }

    Promise.all(tasks.map((t) => t.promise)).then((imgs) => {
      if (canvas._cancelled) {
        done(null, canvas);
        return;
      }
      const ctx = canvas.getContext('2d');
      imgs.forEach((img, idx) => {
        if (!img || !img.naturalWidth) return;
        const { tx, ty } = tasks[idx];
        const tileLeft = tx * 256;
        const tileTop = ty * 256;
        const ix0 = Math.max(srcLeft, tileLeft);
        const iy0 = Math.max(srcTop, tileTop);
        const ix1 = Math.min(srcLeft + 256, tileLeft + 256);
        const iy1 = Math.min(srcTop + 256, tileTop + 256);
        const iw = ix1 - ix0;
        const ih = iy1 - iy0;
        if (iw <= 0 || ih <= 0) return;

        const scaleX = img.naturalWidth / 256;
        const scaleY = img.naturalHeight / 256;
        ctx.drawImage(
          img,
          (ix0 - tileLeft) * scaleX,
          (iy0 - tileTop) * scaleY,
          iw * scaleX,
          ih * scaleY,
          ix0 - srcLeft,
          iy0 - srcTop,
          iw,
          ih
        );
      });
      done(null, canvas);
    });

    return canvas;
  }
});

export const BASEMAPS = {
  'openmap-vector': {
    type: 'vector',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: '&copy; OpenFreeMap / OpenStreetMap'
  },
  'openmap-bright': {
    type: 'vector',
    style: 'https://tiles.openfreemap.org/styles/bright',
    attribution: '&copy; OpenFreeMap / OpenStreetMap'
  },
  'esri-sat': {
    type: 'raster',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19, attribution: '&copy; Esri World Imagery' }
  },
  'bing-sat': {
    type: 'bing',
    url: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=14275',
    options: { subdomains: ['0', '1', '2', '3'], maxZoom: 19, attribution: '&copy; Bing Maps' }
  },
  'gaode-sat': {
    type: 'raster',
    gcj02: true,
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    options: { subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '&copy; 高德影像' }
  },
  opentopomap: {
    type: 'raster',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 17, attribution: '&copy; OpenTopoMap (CC-BY-SA)' }
  },
  osm: {
    type: 'raster',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }
  },
  'gaode-vec': {
    type: 'raster',
    gcj02: true,
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    options: { subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '&copy; 高德地图' }
  }
};

export function createBasemapLayer(key, useGcjFix = true) {
  const cfg = BASEMAPS[key] || BASEMAPS.osm;
  if (cfg.type === 'vector') {
    if (typeof L.maplibreGL === 'function') {
      return {
        cfg,
        layer: L.maplibreGL({
          style: cfg.style,
          pane: 'tilePane',
          attribution: cfg.attribution
        })
      };
    }
    const fallback = BASEMAPS.osm;
    return { cfg: fallback, layer: L.tileLayer(fallback.url, fallback.options), fallbackUsed: true };
  }
  if (cfg.type === 'bing') {
    return { cfg, layer: new BingTileLayer(cfg.url, cfg.options) };
  }
  if (cfg.gcj02 && useGcjFix) {
    return { cfg, layer: new Gcj02Wgs84TileLayer(cfg.url, cfg.options) };
  }
  return { cfg, layer: L.tileLayer(cfg.url, cfg.options) };
}
