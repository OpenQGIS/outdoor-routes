/**
 * Client-side parser for user-dropped KML / KMZ / GPX / GeoJSON route files.
 * Mirrors the cleaning & metric logic in scripts/ingest_kml.py without needing a backend.
 */
import { inspectGeojson, inspectTrackSegments } from './kml-qc.js';

const IGNORED_DATA_KEYS = /(photo|image|img|pic|picture|icon|avatar|thumb|media)/i;
const IMG_URL_VALUE = /(\.(?:jpe?g|png|gif|webp|bmp)|^data:image\/)/i;

const KML_META_KEY_ALIASES = {
  category: 'category',
  分类: 'category',
  region: 'region',
  地区: 'region',
  sub_type: 'sub_type',
  subtype: 'sub_type',
  细分类型: 'sub_type',
  difficulty: 'difficulty',
  难度: 'difficulty',
  season: 'season',
  适行季节: 'season',
  季节: 'season',
  status: 'status',
  状态: 'status',
  year: 'year',
  年份: 'year',
  tags: 'tags',
  标签: 'tags',
  notes: 'notes',
  备注: 'notes'
};

const CATEGORY_ALIASES = {
  offroad: 'offroad',
  越野: 'offroad',
  越野穿越: 'offroad',
  cycling: 'cycling',
  骑行: 'cycling',
  自行车: 'cycling',
  hiking: 'hiking',
  徒步: 'hiking'
};

const BASIC_HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

function decodeHtmlEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity) => {
    const lower = entity.toLowerCase();
    if (lower in BASIC_HTML_ENTITIES) return BASIC_HTML_ENTITIES[lower];
    if (lower.startsWith('#x')) {
      const cp = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    if (lower.startsWith('#')) {
      const cp = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    return full;
  });
}

export function cleanDescription(rawText) {
  if (!rawText) return '';
  let text = decodeHtmlEntities(rawText);
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<img\b[^>]*>/gi, '');
  text = text.replace(/data:image\/[^\s"'<>]+/gi, '');
  text = text.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function localTag(elem) {
  if (!elem) return '';
  if (elem.localName) return elem.localName;
  const tag = elem.tagName || elem.nodeName || '';
  const idx = tag.indexOf(':');
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function childElements(elem) {
  const out = [];
  for (let n = elem?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n);
  }
  return out;
}

function allDescendants(elem) {
  const out = [];
  const stack = [...childElements(elem)].reverse();
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur);
    const children = childElements(cur);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  return out;
}

function directChildText(elem, tagName) {
  for (const child of childElements(elem)) {
    if (localTag(child) === tagName) {
      return (child.textContent || '').trim();
    }
  }
  return '';
}

function roundNum(val, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

export function parseKmlCoordinates(text) {
  if (!text) return [];
  const coords = [];
  const tokens = String(text).trim().split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    const parts = token.split(',');
    if (parts.length < 2) continue;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    const ele = parts.length >= 3 && parts[2] !== '' ? Number(parts[2]) : null;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) continue;
    if (Math.abs(lng) < 1e-9 && Math.abs(lat) < 1e-9) continue;

    const pos = [roundNum(lng, 6), roundNum(lat, 6)];
    if (ele !== null && Number.isFinite(ele)) {
      pos.push(roundNum(ele, 2));
    }
    const prev = coords[coords.length - 1];
    if (!prev || prev[0] !== pos[0] || prev[1] !== pos[1]) {
      coords.push(pos);
    }
  }
  return coords;
}

function parseGxTrackPoints(trackElem) {
  const children = childElements(trackElem);
  const whenElems = children.filter((c) => localTag(c) === 'when');
  const coordElems = children.filter((c) => localTag(c) === 'coord');
  const timestampMismatch = whenElems.length > 0 && whenElems.length !== coordElems.length;

  const paired = [];
  if (!whenElems.length) {
    for (const c of coordElems) paired.push([c, null]);
  } else if (whenElems.length === coordElems.length) {
    for (let i = 0; i < coordElems.length; i++) {
      const tStr = (whenElems[i].textContent || '').trim() || null;
      paired.push([coordElems[i], tStr]);
    }
  } else {
    let seenCoord = false;
    let interleaved = false;
    for (let idx = 0; idx < children.length; idx++) {
      const t = localTag(children[idx]);
      if (t === 'coord') {
        seenCoord = true;
      } else if (t === 'when' && seenCoord) {
        if (children.slice(idx + 1).some((nxt) => localTag(nxt) === 'coord')) {
          interleaved = true;
          break;
        }
      }
    }
    if (interleaved) {
      let pendingWhen = null;
      for (const c of children) {
        const t = localTag(c);
        if (t === 'when') {
          pendingWhen = (c.textContent || '').trim() || null;
        } else if (t === 'coord') {
          paired.push([c, pendingWhen]);
          pendingWhen = null;
        }
      }
    } else {
      for (let i = 0; i < coordElems.length; i++) {
        const w = i < whenElems.length ? whenElems[i] : null;
        const tStr = w ? ((w.textContent || '').trim() || null) : null;
        paired.push([coordElems[i], tStr]);
      }
    }
  }

  const coords = [];
  const times = [];
  for (const [child, tStr] of paired) {
    const raw = (child.textContent || '').trim();
    if (!raw) continue;
    const parts = raw.split(/\s+/);
    if (parts.length < 2) continue;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    const ele = parts.length >= 3 && parts[2] !== '' ? Number(parts[2]) : null;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) continue;
    if (Math.abs(lng) < 1e-9 && Math.abs(lat) < 1e-9) continue;

    const pos = [roundNum(lng, 6), roundNum(lat, 6)];
    if (ele !== null && Number.isFinite(ele)) {
      pos.push(roundNum(ele, 2));
    }
    const prev = coords[coords.length - 1];
    if (!prev || prev[0] !== pos[0] || prev[1] !== pos[1]) {
      coords.push(pos);
      times.push(tStr);
    } else if (tStr !== null) {
      times[times.length - 1] = tStr;
    }
  }
  return { coords, times, timestampMismatch };
}

function extractExtendedData(container) {
  const attrs = {};
  for (const elem of allDescendants(container)) {
    const tag = localTag(elem);
    if (tag !== 'Data' && tag !== 'SimpleData') continue;
    const key = (elem.getAttribute('name') || '').trim();
    if (!key || IGNORED_DATA_KEYS.test(key)) continue;

    let rawVal = '';
    if (tag === 'Data') {
      const valChild = childElements(elem).find((c) => localTag(c) === 'value')
        || allDescendants(elem).find((c) => localTag(c) === 'value');
      rawVal = valChild ? valChild.textContent : '';
    } else {
      rawVal = elem.textContent || '';
    }
    const cleaned = cleanDescription(rawVal);
    if (cleaned && !IMG_URL_VALUE.test(cleaned)) {
      attrs[key] = cleaned;
    }
  }
  return attrs;
}

function parseListMeta(rawVal) {
  const text = String(rawVal || '').trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).trim()).filter(Boolean);
      }
    } catch (_) {
      // Fallback to delimiter split
    }
  }
  return text.split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean);
}

function extractKmlDocumentMeta(rootElem) {
  const docElem = localTag(rootElem) === 'Document'
    ? rootElem
    : (childElements(rootElem).find((c) => localTag(c) === 'Document') || rootElem);

  const docName = cleanDescription(directChildText(docElem, 'name'));
  const docDesc = cleanDescription(directChildText(docElem, 'description'));

  const rawAttrs = {};
  for (const child of childElements(docElem)) {
    if (localTag(child) === 'ExtendedData') {
      Object.assign(rawAttrs, extractExtendedData(child));
    }
  }

  const meta = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    const trimmedKey = k.trim();
    const canonical = KML_META_KEY_ALIASES[trimmedKey.toLowerCase()] || KML_META_KEY_ALIASES[trimmedKey];
    if (!canonical || !v) continue;
    if (canonical === 'category') {
      const val = v.trim();
      const mapped = CATEGORY_ALIASES[val.toLowerCase()] || CATEGORY_ALIASES[val];
      if (mapped) meta.category = mapped;
    } else if (canonical === 'season' || canonical === 'tags') {
      const items = parseListMeta(v);
      if (items.length) meta[canonical] = items;
    } else {
      meta[canonical] = v.trim();
    }
  }

  return { docName, docDesc, meta };
}

export function inferPoiKind(name, description, poiKinds = {}) {
  const haystack = `${name || ''}\n${description || ''}`.toLowerCase();
  for (const [kind, cfg] of Object.entries(poiKinds)) {
    if (kind === 'waypoint') continue;
    const keywords = cfg?.keywords || [];
    for (const kw of keywords) {
      if (kw && haystack.includes(String(kw).toLowerCase())) {
        return kind;
      }
    }
  }
  return 'waypoint';
}

const AUTO_PHOTO_META_LINE = /^(?:经度|纬度|海拔|时间|lon|lat|ele|time)\s*[:：]/i;
const PHOTO_TELEMETRY_KEYS = new Set([
  'type',
  'serverid',
  'postype',
  'longitude',
  'longtitude',
  'latitude',
  'altitude',
  'speed',
  'accuracy',
  'time',
  'timestamp',
  'fileid',
  'filesize',
  'filetype'
]);

function isPurePhotoPlacemark(name, styleUrl, rawDesc, cleanDesc, extra) {
  if (name) return false;
  const meaningfulExtra = Object.keys(extra || {}).filter((k) => !PHOTO_TELEMETRY_KEYS.has(k.trim().toLowerCase()));
  if (meaningfulExtra.length > 0) return false;
  const styleL = String(styleUrl || '').toLowerCase();
  const hasPhotoStyle = styleL.includes('picture') || styleL.includes('photo');
  const hasRawImg = /<img\b|data:image\//i.test(String(rawDesc || ''));
  if (!hasPhotoStyle && !hasRawImg) return false;
  const meaningfulLines = String(cleanDesc || '')
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter((ln) => ln && !AUTO_PHOTO_META_LINE.test(ln));
  return meaningfulLines.length === 0;
}

function extractKmlFeatures(rootElem, routeId, category, poiKinds) {
  const routes = [];
  const pois = [];
  const qcSegments = [];
  const polygonRings = [];
  let segIdx = 0;

  const elements = [rootElem, ...allDescendants(rootElem)];
  for (const elem of elements) {
    if (localTag(elem) !== 'Placemark') continue;

    const name = cleanDescription(directChildText(elem, 'name'));
    const rawDesc = directChildText(elem, 'description');
    const description = cleanDescription(rawDesc);
    const styleUrl = directChildText(elem, 'styleUrl').trim();
    const extra = extractExtendedData(elem);

    for (const geom of allDescendants(elem)) {
      const gtag = localTag(geom);
      if (gtag === 'Point') {
        if (isPurePhotoPlacemark(name, styleUrl, rawDesc, description, extra)) continue;
        const coordElem = childElements(geom).find((c) => localTag(c) === 'coordinates')
          || allDescendants(geom).find((c) => localTag(c) === 'coordinates');
        const pts = parseKmlCoordinates(coordElem ? coordElem.textContent : '');
        if (!pts.length) continue;
        const pos = pts[0];
        const poiName = name || '未命名路点';
        const props = {
          feature_type: 'poi',
          route_id: routeId,
          category,
          name: poiName,
          poi_kind: inferPoiKind(poiName, description, poiKinds)
        };
        if (description) props.description = description;
        if (pos.length >= 3) props.ele = pos[2];
        if (Object.keys(extra).length) props.attributes = extra;
        pois.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: pos },
          properties: props
        });
      } else if (gtag === 'LineString') {
        const coordElem = childElements(geom).find((c) => localTag(c) === 'coordinates')
          || allDescendants(geom).find((c) => localTag(c) === 'coordinates');
        const line = parseKmlCoordinates(coordElem ? coordElem.textContent : '');
        if (line.length >= 2) {
          segIdx += 1;
          const segName = name || `轨迹段 ${segIdx}`;
          const props = {
            feature_type: 'route',
            route_id: routeId,
            category,
            segment_index: segIdx,
            name: segName
          };
          if (description) props.description = description;
          routes.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: line },
            properties: props
          });
          qcSegments.push({ segment_index: segIdx, name: segName, points: line, times: [] });
        }
      } else if (gtag === 'Track') {
        const { coords: line, times, timestampMismatch } = parseGxTrackPoints(geom);
        if (line.length >= 2) {
          segIdx += 1;
          const segName = name || `轨迹段 ${segIdx}`;
          const props = {
            feature_type: 'route',
            route_id: routeId,
            category,
            segment_index: segIdx,
            name: segName
          };
          if (description) props.description = description;
          routes.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: line },
            properties: props
          });
          qcSegments.push({
            segment_index: segIdx,
            name: segName,
            points: line,
            times,
            timestamp_mismatch: timestampMismatch
          });
        }
      } else if (gtag === 'Polygon') {
        const coordElem = allDescendants(geom).find((c) => localTag(c) === 'coordinates');
        const ring = parseKmlCoordinates(coordElem ? coordElem.textContent : '');
        if (ring.length >= 2) {
          polygonRings.push({ name, description, ring });
        }
      }
    }
  }

  // Fallback: if a KML only contains Polygon boundaries and no tracks/POIs, render boundary lines.
  if (!routes.length && !pois.length && polygonRings.length) {
    for (const item of polygonRings) {
      segIdx += 1;
      const segName = item.name || `边界 ${segIdx}`;
      const props = {
        feature_type: 'route',
        route_id: routeId,
        category,
        segment_index: segIdx,
        name: segName
      };
      if (item.description) props.description = item.description;
      routes.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: item.ring },
        properties: props
      });
      qcSegments.push({ segment_index: segIdx, name: segName, points: item.ring, times: [] });
    }
  }

  return { routes, pois, qcSegments };
}

function extractGpxPointWithTime(ptElem) {
  const lat = Number(ptElem.getAttribute('lat'));
  const lng = Number(ptElem.getAttribute('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;

  const pos = [roundNum(lng, 6), roundNum(lat, 6)];
  const eleText = directChildText(ptElem, 'ele');
  if (eleText) {
    const ele = Number(eleText);
    if (Number.isFinite(ele)) pos.push(roundNum(ele, 2));
  }
  const timeText = directChildText(ptElem, 'time') || null;
  return { pos, timeText };
}

function extractGpxPoint(ptElem) {
  const parsed = extractGpxPointWithTime(ptElem);
  return parsed ? parsed.pos : null;
}

function extractGpxFeatures(rootElem, routeId, category, poiKinds) {
  const routes = [];
  const pois = [];
  const qcSegments = [];
  let segIdx = 0;

  for (const elem of childElements(rootElem)) {
    const tag = localTag(elem);
    if (tag === 'wpt') {
      const pos = extractGpxPoint(elem);
      if (!pos) continue;
      const name = directChildText(elem, 'name');
      const desc = cleanDescription(directChildText(elem, 'desc') || directChildText(elem, 'cmt'));
      const poiName = name || '未命名路点';
      const props = {
        feature_type: 'poi',
        route_id: routeId,
        category,
        name: poiName,
        poi_kind: inferPoiKind(poiName, desc, poiKinds)
      };
      if (desc) props.description = desc;
      if (pos.length >= 3) props.ele = pos[2];
      pois.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: props
      });
    } else if (tag === 'trk' || tag === 'rte') {
      const baseName = directChildText(elem, 'name');
      const baseDesc = cleanDescription(directChildText(elem, 'desc') || directChildText(elem, 'cmt'));
      const segments = tag === 'trk'
        ? childElements(elem).filter((c) => localTag(c) === 'trkseg')
        : [elem];
      const ptTag = tag === 'trk' ? 'trkpt' : 'rtept';

      for (const seg of segments) {
        const line = [];
        const times = [];
        for (const child of childElements(seg)) {
          if (localTag(child) !== ptTag) continue;
          const parsed = extractGpxPointWithTime(child);
          if (!parsed) continue;
          const { pos, timeText } = parsed;
          const prev = line[line.length - 1];
          if (!prev || prev[0] !== pos[0] || prev[1] !== pos[1]) {
            line.push(pos);
            times.push(timeText);
          } else if (timeText !== null) {
            times[times.length - 1] = timeText;
          }
        }
        if (line.length >= 2) {
          segIdx += 1;
          const segName = baseName || `轨迹段 ${segIdx}`;
          const props = {
            feature_type: 'route',
            route_id: routeId,
            category,
            segment_index: segIdx,
            name: segName
          };
          if (baseDesc) props.description = baseDesc;
          routes.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: line },
            properties: props
          });
          qcSegments.push({ segment_index: segIdx, name: segName, points: line, times });
        }
      }
    }
  }

  return { routes, pois, qcSegments };
}

function haversineKm(p1, p2) {
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

function downsampleProfile(values, maxPoints = 32) {
  if (!values.length) return [];
  const n = values.length;
  if (n <= maxPoints) return values.map((v) => Math.round(v));
  const out = [];
  const step = (n - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(n - 1, Math.round(i * step));
    out.push(Math.round(values[idx]));
  }
  return out;
}

export function computeMetrics(routeFeatures, poiFeatures) {
  let totalKm = 0;
  let gainM = 0;
  let lossM = 0;
  const routeEles = [];
  let maxEle = -Infinity;
  let minEle = Infinity;
  let hasEle = false;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let hasCoords = false;

  const trackCoord = (pos) => {
    hasCoords = true;
    if (pos[0] < minLng) minLng = pos[0];
    if (pos[0] > maxLng) maxLng = pos[0];
    if (pos[1] < minLat) minLat = pos[1];
    if (pos[1] > maxLat) maxLat = pos[1];
    if (pos.length >= 3 && Number.isFinite(pos[2])) {
      hasEle = true;
      if (pos[2] > maxEle) maxEle = pos[2];
      if (pos[2] < minEle) minEle = pos[2];
    }
  };

  for (const feat of routeFeatures) {
    const coords = feat.geometry?.coordinates || [];
    let lastEle = null;
    for (let i = 0; i < coords.length; i++) {
      const pos = coords[i];
      trackCoord(pos);
      if (i > 0) totalKm += haversineKm(coords[i - 1], pos);
      if (pos.length >= 3 && Number.isFinite(pos[2])) {
        const ele = pos[2];
        routeEles.push(ele);
        if (lastEle === null) {
          lastEle = ele;
        } else if (ele - lastEle >= 3.0) {
          gainM += ele - lastEle;
          lastEle = ele;
        } else if (lastEle - ele >= 3.0) {
          lossM += lastEle - ele;
          lastEle = ele;
        }
      }
    }
  }

  for (const feat of poiFeatures) {
    const pos = feat.geometry?.coordinates;
    if (Array.isArray(pos) && pos.length >= 2) trackCoord(pos);
  }

  return {
    distance_km: roundNum(totalKm, 2),
    elevation_gain_m: hasEle ? Math.round(gainM) : null,
    elevation_loss_m: hasEle ? Math.round(lossM) : null,
    max_ele_m: hasEle ? Math.round(maxEle) : null,
    min_ele_m: hasEle ? Math.round(minEle) : null,
    ele_profile_preview: downsampleProfile(routeEles, 32),
    bbox: hasCoords
      ? [roundNum(minLng, 6), roundNum(minLat, 6), roundNum(maxLng, 6), roundNum(maxLat, 6)]
      : null,
    segments_count: routeFeatures.length,
    waypoints_count: poiFeatures.length
  };
}

export function decodeXmlBytes(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 256));
  const encMatch = head.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i);
  const declared = encMatch ? encMatch[1].trim().toLowerCase() : '';

  let text = '';
  if (declared && (declared === 'gbk' || declared === 'gb2312' || declared === 'gb18030')) {
    text = new TextDecoder('gb18030').decode(bytes);
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      text = new TextDecoder('gb18030').decode(bytes);
    }
  }

  // Strip BOM and invalid XML control characters
  return text
    .replace(/^\uFEFF/, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function escapeBareAmpersandsOutsideCdata(xmlText) {
  return xmlText.replace(/(<!\[CDATA\[[\s\S]*?\]\]>)|(&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);))/gi, (m, cdata, amp) => {
    if (cdata) return cdata;
    if (amp) return '&amp;';
    return m;
  });
}

function ensureKmlNamespaces(xmlText) {
  return xmlText.replace(/<kml\b([^>]*)>/i, (full, attrs) => {
    let nextAttrs = attrs;
    if (!/\bxmlns:gx\s*=/.test(nextAttrs)) {
      nextAttrs += ' xmlns:gx="http://www.google.com/kml/ext/2.2"';
    }
    if (!/\bxmlns:atom\s*=/.test(nextAttrs)) {
      nextAttrs += ' xmlns:atom="http://www.w3.org/2005/Atom"';
    }
    return `<kml${nextAttrs}>`;
  });
}

export function parseXmlString(xmlText, domParser = new DOMParser()) {
  const parse = (src) => {
    const doc = domParser.parseFromString(src, 'text/xml');
    const errNode = doc.getElementsByTagName('parsererror')[0];
    return { doc, hasError: Boolean(errNode) };
  };

  let attempt = parse(xmlText);
  if (!attempt.hasError) return attempt.doc.documentElement;

  const withNs = ensureKmlNamespaces(xmlText);
  attempt = parse(withNs);
  if (!attempt.hasError) return attempt.doc.documentElement;

  const repaired = escapeBareAmpersandsOutsideCdata(withNs);
  attempt = parse(repaired);
  if (!attempt.hasError) return attempt.doc.documentElement;

  throw new Error('XML 解析失败，请检查 KML/GPX 文件是否完整有效');
}

async function extractKmlBytesFromKmz(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate End of Central Directory (0x06054b50)
  const minOffset = Math.max(0, bytes.length - 65557);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('无效的 KMZ 压缩包（未找到 ZIP 目录尾）');
  }

  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const utf8 = new TextDecoder('utf-8');

  const kmlEntries = [];
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (cursor + 46 <= cdEnd && cursor + 46 <= bytes.length) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const fileName = utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    if (fileName.toLowerCase().endsWith('.kml') && !fileName.startsWith('__MACOSX')) {
      kmlEntries.push({ fileName, compressionMethod, compressedSize, localHeaderOffset });
    }
  }

  if (!kmlEntries.length) {
    throw new Error('KMZ 文件中未找到 .kml 内容');
  }

  kmlEntries.sort((a, b) => {
    const aBase = a.fileName.split('/').pop().toLowerCase() === 'doc.kml' ? 0 : 1;
    const bBase = b.fileName.split('/').pop().toLowerCase() === 'doc.kml' ? 0 : 1;
    if (aBase !== bBase) return aBase - bBase;
    return a.fileName.localeCompare(b.fileName);
  });

  const target = kmlEntries[0];
  const lfh = target.localHeaderOffset;
  if (lfh + 30 > bytes.length || view.getUint32(lfh, true) !== 0x04034b50) {
    throw new Error('KMZ 文件条目头损坏');
  }
  const lfhNameLen = view.getUint16(lfh + 26, true);
  const lfhExtraLen = view.getUint16(lfh + 28, true);
  const dataStart = lfh + 30 + lfhNameLen + lfhExtraLen;
  const compressedSlice = bytes.subarray(dataStart, dataStart + target.compressedSize);

  if (target.compressionMethod === 0) {
    return compressedSlice;
  }
  if (target.compressionMethod === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持原生解压 KMZ，请先解压为 .kml 后再拖入');
    }
    const stream = new Blob([compressedSlice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const decompressed = await new Response(stream).arrayBuffer();
    return new Uint8Array(decompressed);
  }
  throw new Error(`不支持的 KMZ 压缩方式 (${target.compressionMethod})`);
}

function guessCategory(text) {
  const lower = String(text || '').toLowerCase();
  if (/越野|穿越|无人区|坦克|牧马人|素车|炮弹坑|涉水|4x4|offroad/.test(lower)) return 'offroad';
  if (/骑行|公路车|山地车|砾石|绿道|cycling|bike|gravel/.test(lower)) return 'cycling';
  return 'hiking';
}

function normalizeGeojsonFeatures(rawData, routeId, defaultCategory, poiKinds) {
  const inputFeatures = rawData?.type === 'FeatureCollection'
    ? (rawData.features || [])
    : (rawData?.type === 'Feature' ? [rawData] : []);

  const routes = [];
  const pois = [];
  let segIdx = 0;

  for (const feat of inputFeatures) {
    const geom = feat?.geometry;
    if (!geom) continue;
    const props = feat.properties || {};

    if (geom.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
      const poiName = cleanDescription(props.name) || '未命名路点';
      const desc = cleanDescription(props.description || props.desc);
      const pos = geom.coordinates.slice(0, 3).map((n, idx) => roundNum(Number(n), idx < 2 ? 6 : 2));
      if (pos.slice(0, 2).some((n) => !Number.isFinite(n))) continue;
      pois.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: {
          feature_type: 'poi',
          route_id: routeId,
          category: defaultCategory,
          name: poiName,
          poi_kind: props.poi_kind || inferPoiKind(poiName, desc, poiKinds),
          ...(desc ? { description: desc } : {}),
          ...(pos.length >= 3 ? { ele: pos[2] } : {})
        }
      });
    } else if (geom.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
      segIdx += 1;
      routes.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: geom.coordinates },
        properties: {
          feature_type: 'route',
          route_id: routeId,
          category: defaultCategory,
          segment_index: segIdx,
          name: cleanDescription(props.name) || `轨迹段 ${segIdx}`
        }
      });
    } else if (geom.type === 'MultiLineString' && Array.isArray(geom.coordinates)) {
      for (const line of geom.coordinates) {
        if (!Array.isArray(line) || line.length < 2) continue;
        segIdx += 1;
        routes.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: line },
          properties: {
            feature_type: 'route',
            route_id: routeId,
            category: defaultCategory,
            segment_index: segIdx,
            name: cleanDescription(props.name) || `轨迹段 ${segIdx}`
          }
        });
      }
    }
  }

  return { routes, pois, docMeta: rawData?.properties || {} };
}

export function parseXmlRouteText(xmlText, fileName, schema = {}, domParser = new DOMParser()) {
  const poiKinds = schema?.poi_kinds || {};
  const stem = fileName.replace(/\.(kml|kmz|gpx)$/i, '');
  const routeId = `local__${stem}`;

  const rootElem = parseXmlString(xmlText, domParser);
  const isGpx = localTag(rootElem).toLowerCase() === 'gpx';

  let docName = '';
  let docDesc = '';
  let docMeta = {};
  let extracted;

  if (isGpx) {
    const gpxMeta = childElements(rootElem).find((c) => localTag(c) === 'metadata');
    if (gpxMeta) {
      docName = cleanDescription(directChildText(gpxMeta, 'name'));
      docDesc = cleanDescription(directChildText(gpxMeta, 'desc'));
    }
    extracted = extractGpxFeatures(rootElem, routeId, 'hiking', poiKinds);
  } else {
    const parsedMeta = extractKmlDocumentMeta(rootElem);
    docName = parsedMeta.docName;
    docDesc = parsedMeta.docDesc;
    docMeta = parsedMeta.meta;
    extracted = extractKmlFeatures(rootElem, routeId, docMeta.category || 'hiking', poiKinds);
  }

  const { routes, pois, qcSegments = [] } = extracted;
  if (!routes.length && !pois.length) {
    throw new Error(`文件「${fileName}」中未找到有效的轨迹或路点坐标`);
  }

  const poiHintText = pois.map((p) => `${p.properties.name} ${p.properties.description || ''}`).join(' ');
  const category = docMeta.category || guessCategory(`${fileName} ${docName} ${docDesc} ${poiHintText}`);

  for (const feat of [...routes, ...pois]) {
    feat.properties.category = category;
  }

  const metrics = computeMetrics(routes, pois);
  const qcReport = inspectTrackSegments(qcSegments, category);
  const displayName = (docName && !/^doc(\.kml)?$/i.test(docName)) ? docName : stem;
  const notes = docMeta.notes || (docDesc && docDesc !== displayName ? docDesc : '');

  const geojson = {
    type: 'FeatureCollection',
    properties: {
      route_id: routeId,
      category,
      name: displayName,
      ...docMeta,
      ...(notes ? { notes } : {}),
      qc: qcReport
    },
    features: [...routes, ...pois]
  };

  const entry = {
    id: `[本地] ${fileName}`,
    fileName,
    name: displayName,
    category,
    region: docMeta.region || '',
    sub_type: docMeta.sub_type || '',
    difficulty: docMeta.difficulty || '',
    season: docMeta.season || [],
    status: docMeta.status || 'collected',
    notes,
    ...metrics,
    qc_status: qcReport.status,
    qc_issues_count: qcReport.issues_count,
    _qcSegments: qcSegments
  };

  return { entry, geojson };
}

export async function parseLocalRouteFile(file, schema = {}, domParser = new DOMParser()) {
  const fileName = file.name || 'route.kml';
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
    const text = await file.text();
    const raw = JSON.parse(text);
    const stem = fileName.replace(/\.(geojson|json)$/i, '');
    const routeId = `local__${stem}`;
    const { routes, pois, docMeta } = normalizeGeojsonFeatures(raw, routeId, 'hiking', schema?.poi_kinds || {});
    if (!routes.length && !pois.length) {
      throw new Error(`文件「${fileName}」中未找到有效的 LineString 或 Point 要素`);
    }
    const category = docMeta.category || guessCategory(`${fileName} ${docMeta.name || ''}`);
    for (const feat of [...routes, ...pois]) {
      feat.properties.category = category;
    }
    const metrics = computeMetrics(routes, pois);
    const geojson = {
      type: 'FeatureCollection',
      properties: { ...docMeta, route_id: routeId, category, name: docMeta.name || stem },
      features: [...routes, ...pois]
    };
    const qcReport = docMeta.qc || inspectGeojson(geojson, category);
    geojson.properties.qc = qcReport;
    const displayName = docMeta.name || stem;
    return {
      entry: {
        id: `[本地] ${fileName}`,
        fileName,
        name: displayName,
        category,
        region: docMeta.region || '',
        sub_type: docMeta.sub_type || '',
        difficulty: docMeta.difficulty || '',
        season: docMeta.season || [],
        status: docMeta.status || 'collected',
        notes: docMeta.notes || '',
        ...metrics,
        qc_status: qcReport.status,
        qc_issues_count: qcReport.issues_count
      },
      geojson
    };
  }

  let xmlBytes;
  if (lower.endsWith('.kmz')) {
    const buf = await file.arrayBuffer();
    xmlBytes = await extractKmlBytesFromKmz(buf);
  } else if (lower.endsWith('.kml') || lower.endsWith('.gpx')) {
    xmlBytes = await file.arrayBuffer();
  } else {
    throw new Error(`不支持的文件格式「${fileName}」，请拖入 .kml / .kmz / .gpx / .geojson 文件`);
  }

  const xmlText = decodeXmlBytes(xmlBytes);
  return parseXmlRouteText(xmlText, fileName, schema, domParser);
}
