// overpass.js
// OpenStreetMap data via Overpass, converted with osmtogeojson.
// Resilient fetch: tries several public mirrors, uses long server timeouts with
// a client-side abort/failover, and treats Overpass "timed out" remarks (which
// arrive as HTTP 200 with an empty body) as failures so we fail over instead of
// silently reporting "no features". This is why dense areas (continental rail,
// long coastlines) previously appeared to "detect nothing".

import * as turf from '@turf/turf';
import osmtogeojson from 'osmtogeojson';
import { idbGet, idbSet, idbClear } from './idbCache.js';
import { fetchFeaturePreloaded } from './preload.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

export const FEATURES = {
  airport: {
    label: 'Commercial airport', geom: 'point', modes: ['nearest', 'relative', 'target'],
    q: ['nwr["aeroway"="aerodrome"]["iata"]', 'nwr["aeroway"="aerodrome"]["aerodrome:type"="international"]'],
  },
  station:    { label: 'Rail station', geom: 'point', modes: ['nearest', 'relative', 'target'],
                q: 'nwr["railway"~"^(station|halt)$"]' },
  // Only peaks with ele >= 1000m (matches scripts/preload-data.js MIN_PEAK_ELE_M).
  // Untagged peaks are excluded (number() of a missing tag is NaN; NaN>=1000 is
  // false). Keeps the set small so closer/further stays fast and storable.
  mountain:   { label: 'Mountain (peak)', geom: 'point', modes: ['nearest', 'relative', 'target'],
                q: 'node["natural"="peak"](if: number(t["ele"]) >= 1000)' },
  coastline:  { label: 'Coastline', geom: 'line', modes: ['relative'], simplify: 0.005,
                q: 'way["natural"="coastline"]' },
  border:     { label: 'International border', geom: 'line', modes: ['relative'], local: true },
  sealevel:   { label: 'Sea level (elevation)', geom: 'point', modes: ['relative'], special: 'elevation' },
  museum:     { label: 'Museum', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["tourism"="museum"]' },
  library:    { label: 'Library', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["amenity"="library"]' },
  cinema:     { label: 'Movie theatre', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["amenity"="cinema"]' },
  hospital:   { label: 'Hospital', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["amenity"="hospital"]' },
  zoo:        { label: 'Zoo', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["tourism"="zoo"]' },
  aquarium:   { label: 'Aquarium', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["tourism"="aquarium"]' },
  theme_park: { label: 'Amusement park', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["tourism"="theme_park"]' },
  park:       { label: 'Park', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["leisure"="park"]' },
  golf:       { label: 'Golf course', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["leisure"="golf_course"]' },
  consulate:  { label: 'Foreign consulate', geom: 'point', modes: ['nearest', 'relative', 'target'], q: 'nwr["diplomatic"~"consulate|embassy"]' },
  admin:      { label: 'Administrative division', geom: 'area', modes: ['nearest'] },
};

export const ADMIN_LEVELS = [
  { level: 4, label: '1st division (state/region, AL4)' },
  { level: 6, label: '2nd division (county, AL6)' },
];

export const FEATURE_LABELS = Object.fromEntries(
  Object.entries(FEATURES).map(([k, v]) => [k, v.label])
);

async function postOnce(endpoint, query, clientTimeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), clientTimeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
    });
    if (res.status === 429 || res.status === 504) throw new Error('server busy');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    // A timeout/error remark means the data is missing or partial — fail over
    // rather than returning it (and never let it be cached).
    if (j.remark && /timed out|runtime error|out of memory/i.test(j.remark)) {
      throw new Error('query too big for this server');
    }
    return j;
  } finally { clearTimeout(timer); }
}

// Try each mirror in turn; only fail once all are exhausted. Returns the parsed
// JSON; throws on total failure (which prevents caching a failed pull).
async function run(query, clientTimeoutMs = 95000) {
  let lastErr;
  for (const ep of ENDPOINTS) {
    try { return await postOnce(ep, query, clientTimeoutMs); }
    catch (e) { lastErr = e; }
  }
  throw new Error('All Overpass servers failed or timed out (' + (lastErr?.message || 'unknown') + '). Try a smaller area or retry.');
}

function body(q, area) {
  return (Array.isArray(q) ? q : [q]).map((s) => `${s}${area};`).join('');
}

// ---- typed reducers ----
function toPoints(fc) {
  const pts = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    try { pts.push(turf.centroid(f, { properties: { name: f.properties?.name || 'Unnamed' } })); } catch { /* skip invalid feature */ }
  }
  return turf.featureCollection(pts);
}
function toLines(fc) {
  const lines = [];
  const push = (geom, props) => {
    if (!geom) return;
    if (geom.type === 'LineString') lines.push(turf.lineString(geom.coordinates, props));
    else if (geom.type === 'MultiLineString') geom.coordinates.forEach((c) => lines.push(turf.lineString(c, props)));
  };
  for (const f of fc.features) {
    const g = f.geometry; if (!g) continue;
    const props = { name: f.properties?.name || null };
    if (g.type === 'LineString' || g.type === 'MultiLineString') push(g, props);
    else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      // Defensive: if any line feature comes back closed-as-polygon, use boundary.
      try {
        const ln = turf.polygonToLine(turf.feature(g));
        if (ln.type === 'FeatureCollection') ln.features.forEach((x) => push(x.geometry, props));
        else push(ln.geometry, props);
      } catch { /* skip invalid polygon boundary */ }
    }
  }
  return turf.featureCollection(lines);
}
function toAreas(fc) {
  const areas = [];
  for (const f of fc.features) {
    const t = f.geometry?.type;
    if (t === 'Polygon' || t === 'MultiPolygon') {
      areas.push(turf.feature(f.geometry, { name: f.properties?.name || 'Unnamed', admin_level: f.properties?.admin_level }));
    }
  }
  return turf.featureCollection(areas);
}

// ---- element-count cap detection -----------------------------------------
// Overpass silently truncates at the `out <N>` limit. If the raw element count
// reaches the requested cap, the result is partial — we return it (better than
// nothing) but flag it incomplete so it is NOT cached and gets re-fetched.
function elementCount(raw) {
  return Array.isArray(raw?.elements) ? raw.elements.length : 0;
}

// Reduce vertex count on heavy line features (coastline) so the payload is
// cheap to render and measure. tolerance is in degrees (~0.01 ≈ 1 km); for a
// "closer/further to coastline" question this loss of detail is irrelevant.
function simplifyLines(fc, tolerance) {
  const out = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== 'LineString') { out.push(f); continue; }
    try {
      const s = turf.simplify(f, { tolerance, highQuality: false, mutate: false });
      out.push(s);
    } catch { out.push(f); }
  }
  return turf.featureCollection(out);
}

// ---- main fetch (uncached) — bbox = [w, s, e, n]; Overpass wants (s, w, n, e)
async function fetchFeatureUncached(key, bbox, { adminLevel = 6, max = 6000 } = {}) {
  const cfg = FEATURES[key];
  if (!cfg) throw new Error(`Unknown feature "${key}"`);
  if (cfg.local || cfg.special) throw new Error(`"${key}" is not fetched from Overpass`);
  const [w, s, e, n] = bbox;
  const area = `(${s},${w},${n},${e})`;

  if (cfg.geom === 'area') {
    const q = `[out:json][timeout:90];(relation["boundary"="administrative"]["admin_level"="${adminLevel}"]${area};);out geom;`;
    const raw = await run(q);
    return { geom: 'area', fc: toAreas(osmtogeojson(raw)), complete: true };
  }
  if (cfg.geom === 'line') {
    const cap = max * 6;
    // Coastline geometry is huge; give the server more time and simplify the
    // result client-side so the payload is manageable to render and measure.
    const serverTimeout = cfg.simplify ? 180 : 90;
    const q = `[out:json][timeout:${serverTimeout}];(${body(cfg.q, area)});out geom ${cap};`;
    const raw = await run(q);
    const complete = elementCount(raw) < cap; // hit the cap → truncated
    let fc = toLines(osmtogeojson(raw));
    if (cfg.simplify && fc.features.length) fc = simplifyLines(fc, cfg.simplify);
    return { geom: 'line', fc, complete };
  }
  const cap = max;
  const q = `[out:json][timeout:60];(${body(cfg.q, area)});out center ${cap};`;
  const raw = await run(q);
  const complete = elementCount(raw) < cap;
  return { geom: 'point', fc: toPoints(osmtogeojson(raw)), complete };
}

// ---- cache layer ----------------------------------------------------------
// Two-tier cache in front of the network:
//   1. in-memory Map  — instant, but cleared on refresh
//   2. IndexedDB      — survives refresh / restart (per browser+device)
// Lookup order: memory → IndexedDB → network.
//
// Completeness guard (unchanged from before): a result is persisted to EITHER
// tier ONLY if it is explicitly complete AND non-empty.
//   - A pull that fails on all mirrors throws → never cached.
//   - A pull truncated at the element cap, or empty, is returned to the caller
//     (partial data beats none) but NOT cached → the next identical question
//     re-queries and can fill in the missing data.
// `cached` in the return value is 'memory' | 'idb' | false so the UI can tell
// the seeker where the data came from.
const _cache = new Map();

function cacheKey(key, bbox, adminLevel) {
  const r = bbox.map((v) => v.toFixed(3)).join(',');
  return `${key}|${r}|${adminLevel ?? ''}`;
}

export async function fetchFeature(key, bbox, opts = {}) {
  // Tier 0: preloaded bundle (instant, offline, authoritative for the bundled
  // countries). If a preload file exists for this feature, use it and skip the
  // cache/network entirely. The caller clips to the current zone locally.
  try {
    const pre = await fetchFeaturePreloaded(key, opts.adminLevel, FEATURES[key]?.geom);
    if (pre && pre.fc?.features?.length > 0) return pre;
  } catch { /* fall through to cache/network */ }

  const ck = cacheKey(key, bbox, opts.adminLevel);

  // Tier 1: memory.
  const mem = _cache.get(ck);
  if (mem) return { ...mem, cached: 'memory' };

  // Tier 2: IndexedDB. Promote a hit into memory for the rest of the session.
  // Only trust persisted records that were themselves flagged complete.
  const persisted = await idbGet(ck);
  if (persisted && persisted.complete && persisted.fc?.features?.length > 0) {
    const rec = { fc: persisted.fc, geom: persisted.geom, complete: true };
    _cache.set(ck, rec);
    return { ...rec, cached: 'idb' };
  }

  // Tier 3: network.
  const result = await fetchFeatureUncached(key, bbox, opts);

  const trustworthy = result.complete && result.fc?.features?.length > 0;
  if (trustworthy) {
    _cache.set(ck, result);
    // Persist asynchronously; failure is non-fatal (in-memory still works).
    idbSet(ck, { fc: result.fc, geom: result.geom, complete: true });
  }

  return { ...result, cached: false };
}

// Manual cache controls. Both tiers are cleared so a refresh can't resurrect
// data the seeker meant to discard.
export function clearFeatureCache() {
  _cache.clear();
  return idbClear(''); // returns a promise; callers may ignore
}
export function invalidateFeature(key) {
  for (const k of _cache.keys()) if (k.startsWith(key + '|')) _cache.delete(k);
  return idbClear(key + '|');
}

// Re-export for an optional "what's cached" UI / debugging.
export { idbList } from './idbCache.js';

// ---- helpers for Category 5 (points only) ----
export function clipPointsToZone(pointsFC, zone) {
  if (!zone) return pointsFC;
  return turf.featureCollection(pointsFC.features.filter((p) => {
    try { return turf.booleanPointInPolygon(p, zone); } catch { return true; }
  }));
}
export function pointsWithinRadius(pointsFC, origin, radiusMeters) {
  const o = turf.point([origin.lng, origin.lat]);
  return turf.featureCollection(pointsFC.features.filter(
    (p) => turf.distance(o, p, { units: 'kilometers' }) <= radiusMeters / 1000
  ));
}
