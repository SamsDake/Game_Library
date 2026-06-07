#!/usr/bin/env node
// scripts/preload-data.js
//
// Downloads all feature data for a set of countries from Overpass ONCE, on your
// laptop, and writes compact GeoJSON files into public/preload/ so the app can
// load them instantly with no network calls during a game.
//
// Usage:
//   node scripts/preload-data.js                       # default: NL,BE,LU,FR,DE,GB
//   node scripts/preload-data.js --countries NL,BE     # custom set (ISO-3166-1 alpha-2)
//   node scripts/preload-data.js --features airport,station,hospital
//   node scripts/preload-data.js --admin 4,6,8         # which admin levels to grab
//
// It queries per-country using OSM area filters (precise, and avoids dragging in
// neighbours), merges across countries per feature, de-duplicates, and writes:
//   public/preload/<feature>.json            (points & lines)
//   public/preload/admin-<level>.json        (admin divisions)
//   public/preload/manifest.json             (what's available + when built)
//
// Re-run any time to refresh. Large/dense features (parks, coastline) can take
// a while and produce multi-MB files — that's expected and is the trade-off for
// instant in-game lookups.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import osmtogeojson from 'osmtogeojson';
import * as turf from '@turf/turf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'preload');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

// Overpass servers now reject requests with no/empty User-Agent (HTTP 406) and
// throttle anonymous clients (429). A descriptive UA with contact info is the
// etiquette the OSM ecosystem expects — set CONTACT to your email if you like.
const CONTACT = process.env.OSM_CONTACT || 'jetlag-deduction-board (self-hosted game tool)';
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': `JetLagDeductionBoard/1.0 (${CONTACT})`,
  'Accept': 'application/json',
};

// Mirror of FEATURES in src/lib/overpass.js (point/line only — border is local,
// sealevel is API-based, so neither is preloaded).
// Minimum peak elevation (metres) for the `mountain` feature. Peaks below this,
// or with no `ele` tag, are excluded from the preload. Raise/lower to trade
// coverage vs file size + closer/further performance. 1000m ≈ real mountains
// only (Alps, high Vosges/Black Forest), dropping Benelux and low hills.
const MIN_PEAK_ELE_M = 1000;

const FEATURES = {
  airport:    { geom: 'point', q: ['nwr["aeroway"="aerodrome"]["iata"]', 'nwr["aeroway"="aerodrome"]["aerodrome:type"="international"]'] },
  station:    { geom: 'point', q: ['nwr["railway"~"^(station|halt)$"]'] },
  // Only peaks with an elevation tag at/above MIN_PEAK_ELE_M metres (see the
  // constant defined above FEATURES). The `number(t["ele"]) >= N` filter excludes
  // untagged peaks automatically (number() of a missing tag is NaN, and
  // NaN >= N is false). This keeps the mountain set small (full OSM peak data is
  // ~67k points across NL/BE/LU/FR/DE, which overflowed the per-clue geometry
  // size and froze closer/further). At 1000m only real mountains remain (Alps,
  // high Vosges/Black Forest); Benelux and low hills are intentionally dropped.
  mountain:   { geom: 'point', q: [`node["natural"="peak"](if: number(t["ele"]) >= ${MIN_PEAK_ELE_M})`] },
  coastline:  { geom: 'line',  simplify: 0.005, q: ['way["natural"="coastline"]'] },
  museum:     { geom: 'point', q: ['nwr["tourism"="museum"]'] },
  library:    { geom: 'point', q: ['nwr["amenity"="library"]'] },
  cinema:     { geom: 'point', q: ['nwr["amenity"="cinema"]'] },
  hospital:   { geom: 'point', q: ['nwr["amenity"="hospital"]'] },
  zoo:        { geom: 'point', q: ['nwr["tourism"="zoo"]'] },
  aquarium:   { geom: 'point', q: ['nwr["tourism"="aquarium"]'] },
  theme_park: { geom: 'point', q: ['nwr["tourism"="theme_park"]'] },
  park:       { geom: 'point', q: ['nwr["leisure"="park"]'] },
  golf:       { geom: 'point', q: ['nwr["leisure"="golf_course"]'] },
  consulate:  { geom: 'point', q: ['nwr["diplomatic"~"consulate|embassy"]'] },
};

// ISO alpha-2 → name (for logging). Overpass resolves the area by ISO code.
const COUNTRY_NAMES = {
  NL: 'Netherlands', BE: 'Belgium', LU: 'Luxembourg', FR: 'France', DE: 'Germany',
  GB: 'United Kingdom',
};

const COUNTRY_ALIASES = {
  UK: 'GB',
};

// ---- CLI parsing ----
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const COUNTRIES = arg('countries', 'NL,BE,LU,FR,DE,GB')
  .split(',')
  .map((s) => COUNTRY_ALIASES[s.trim().toUpperCase()] || s.trim().toUpperCase())
  .filter(Boolean);
const FEATURE_KEYS = arg('features', Object.keys(FEATURES).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const ADMIN_LEVELS = arg('admin', '4,6').split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
// --force re-fetches even countries that already have a saved part file.
const FORCE = process.argv.includes('--force');

// ---- HTTP with mirror failover, proper headers, and 429 backoff ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postWithBackoff(ep, query, timeoutMs) {
  // Retry a busy (429/504) server a few times with growing waits before giving
  // up on it and moving to the next mirror.
  const waits = [3000, 8000, 20000];
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: HEADERS,
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status === 504) {
        if (attempt < waits.length) {
          process.stdout.write(` [busy ${res.status}, waiting ${waits[attempt] / 1000}s]`);
          clearTimeout(timer);
          await sleep(waits[attempt]);
          continue;
        }
        throw new Error('server busy (' + res.status + ')');
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j.remark && /timed out|runtime error|out of memory/i.test(j.remark)) {
        throw new Error('query too big on this server');
      }
      return j;
    } finally { clearTimeout(timer); }
  }
}

async function run(query, { timeoutMs = 180000 } = {}) {
  let lastErr;
  let tooBig = false; // sticky: if ANY mirror said "too big", surface that
  for (const ep of ENDPOINTS) {
    try {
      return await postWithBackoff(ep, query, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (/too big/.test(e.message)) tooBig = true;
      process.stdout.write(` [mirror failed: ${e.message}]`);
    }
  }
  // Prefer the "too big" signal over a later transient network error, otherwise
  // the tile-split fallback (which keys on /too big/) never fires when a mirror
  // that came after the "too big" one fails with e.g. "fetch failed".
  if (tooBig) throw new Error('query too big on all servers');
  throw new Error('all mirrors failed: ' + (lastErr?.message || 'unknown'));
}

// ---- reducers (match src/lib/overpass.js exactly) ----
function toPoints(fc) {
  const pts = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    try { pts.push(turf.centroid(f, { properties: { name: f.properties?.name || 'Unnamed' } })); } catch {}
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
      try {
        const ln = turf.polygonToLine(turf.feature(g));
        if (ln.type === 'FeatureCollection') ln.features.forEach((x) => push(x.geometry, props));
        else push(ln.geometry, props);
      } catch {}
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
// Reduce vertex count on heavy line features (coastline) before saving.
function simplifyLines(fc, tolerance) {
  const out = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== 'LineString') { out.push(f); continue; }
    try { out.push(turf.simplify(f, { tolerance, highQuality: false, mutate: false })); }
    catch { out.push(f); }
  }
  return turf.featureCollection(out);
}

// Trim coordinate precision (~1.1m at 5dp) and drop consecutive duplicate points.
// Full OSM precision (7+ dp) bloats line files ~3x for no benefit in a
// closer/further question. Lines that collapse below 2 points are dropped.
function roundLineCoords(fc, dp = 5) {
  const r = (n) => Number(n.toFixed(dp));
  const out = [];
  for (const f of fc.features) {
    if (f.geometry?.type !== 'LineString') { out.push(f); continue; }
    const coords = [];
    for (const [x, y] of f.geometry.coordinates) {
      const p = [r(x), r(y)];
      const last = coords[coords.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) coords.push(p);
    }
    if (coords.length < 2) continue;
    out.push({ type: 'Feature', properties: f.properties || {}, geometry: { type: 'LineString', coordinates: coords } });
  }
  return turf.featureCollection(out);
}

// Build a query that searches inside a country's area (by ISO code) rather than
// a bbox — precise, and won't drag in neighbours.
function areaQuery(isoA2, filters, outClause) {
  const sels = filters.map((s) => `${s}(area.c);`).join('');
  return `[out:json][timeout:170];area["ISO3166-1"="${isoA2}"][admin_level=2]->.c;(${sels});${outClause}`;
}

function dedupe(features) {
  // Drop exact-duplicate geometries (same rounded coords) that can appear when a
  // feature straddles a border and is returned for two countries.
  const seen = new Set();
  const out = [];
  for (const f of features) {
    const c = f.geometry?.coordinates;
    const key = f.geometry?.type + ':' + JSON.stringify(c).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ---- per-country part files (resume + incremental) ------------------------
// Each country's result for a feature is saved separately under parts/ as soon
// as it succeeds. A later run skips countries that already have a part file, so
// a retry only re-fetches what's missing. The final <feature>.json is rebuilt
// by merging all parts each run.
const PARTS_DIR = path.join(OUT_DIR, 'parts');

function partPath(key, iso) { return path.join(PARTS_DIR, `${key}__${iso}.json`); }

function partExists(key, iso) {
  try { return fs.existsSync(partPath(key, iso)) && fs.statSync(partPath(key, iso)).size > 0; }
  catch { return false; }
}

function writePart(key, iso, fc) {
  fs.mkdirSync(PARTS_DIR, { recursive: true });
  fs.writeFileSync(partPath(key, iso), JSON.stringify(fc));
}

function readPart(key, iso) {
  try { return JSON.parse(fs.readFileSync(partPath(key, iso), 'utf8')); }
  catch { return null; }
}

// Merge EVERY part file on disk for a feature key, regardless of which
// --countries were passed this run. This means adding a country later
// (e.g. `--countries IT`) tops up the merged file instead of shrinking it to
// only the current run's countries. Returns { features, isos }.
function mergeAllParts(key) {
  let names = [];
  try { names = fs.existsSync(PARTS_DIR) ? fs.readdirSync(PARTS_DIR) : []; }
  catch { names = []; }
  const prefix = key + '__';
  const features = [];
  const isos = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const iso = name.slice(prefix.length, -'.json'.length);
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, name), 'utf8'));
      if (p?.features) { features.push(...p.features); isos.push(iso); }
    } catch { /* skip unreadable part */ }
  }
  return { features, isos };
}

// Bounding boxes per country (rough, generous; only used to split a too-big
// query into tiles). [w, s, e, n].
const COUNTRY_BBOX = {
  NL: [3.3, 50.7, 7.3, 53.6], BE: [2.5, 49.4, 6.5, 51.6], LU: [5.7, 49.4, 6.6, 50.2],
  FR: [-5.2, 41.3, 9.6, 51.1], DE: [5.8, 47.2, 15.1, 55.1],
  GB: [-8.7, 49.8, 1.9, 60.9],
};

// Run a feature query against an explicit bbox (used by the tile-split fallback
// when an area query is too big for the servers). When `iso` is given, the query
// is intersected with that country's area so a country bbox that overlaps
// neighbours (e.g. France's bbox covers parts of Spain/Italy/Germany) still
// returns only that country's features.
async function fetchFeatureBbox(cfg, bbox, iso) {
  const [w, s, e, n] = bbox;
  const bb = `(${s},${w},${n},${e})`;
  const outClause = cfg.geom === 'line' ? 'out geom;' : 'out center;';
  let q;
  if (iso) {
    // area filter + bbox: precise to the country AND limited to the tile.
    const sels = cfg.q.map((sq) => `${sq}(area.c)${bb};`).join('');
    q = `[out:json][timeout:170];area["ISO3166-1"="${iso}"][admin_level=2]->.c;(${sels});${outClause}`;
  } else {
    const sels = cfg.q.map((sq) => `${sq}${bb};`).join('');
    q = `[out:json][timeout:170];(${sels});${outClause}`;
  }
  const raw = await run(q);
  const gj = osmtogeojson(raw);
  if (cfg.geom === 'line') {
    let fc = toLines(gj);
    if (cfg.simplify) fc = simplifyLines(fc, cfg.simplify);
    return fc;
  }
  return toPoints(gj);
}

// Fetch one bbox, and if it comes back "too big", split THAT bbox into a 2x2
// grid and recurse on each quadrant — so only the dense area is subdivided
// further, not the whole country. `depth` bounds recursion (2^depth tiles per
// side at the deepest); depth 6 ≈ down to ~10-20 km tiles, enough for France
// parks. Returns a flat array of features (deduped by the caller).
async function fetchBboxDeep(cfg, bbox, depth, iso, label = '') {
  try {
    const fc = await fetchFeatureBbox(cfg, bbox, iso);
    process.stdout.write(` ${label}${fc.features.length}`);
    return fc.features;
  } catch (e) {
    if (!/too big/.test(e.message) || depth <= 0) {
      process.stdout.write(` ${label}FAILED (${e.message})`);
      throw e;
    }
  }
  // Too big and we still have depth budget: split this bbox into 4 quadrants.
  process.stdout.write(`\n      ${label}too big → split`);
  const [w, s, e, n] = bbox;
  const mx = (w + e) / 2, my = (s + n) / 2;
  const quads = [
    [w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n],
  ];
  const out = [];
  for (let q = 0; q < quads.length; q++) {
    await sleep(1500);
    out.push(...await fetchBboxDeep(cfg, quads[q], depth - 1, iso, `${label}${q + 1}.`));
  }
  return out;
}

// Split a country bbox into an NxN grid and recurse into any tile that is still
// too big. Used only when the whole-country query fails as "too big".
async function fetchByTiles(cfg, iso, grid = 2, maxDepth = 6) {
  const bb = COUNTRY_BBOX[iso];
  if (!bb) throw new Error('no bbox known for tile-split');
  const [w, s, e, n] = bb;
  const dx = (e - w) / grid, dy = (n - s) / grid;
  const all = [];
  let tile = 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      tile++;
      const tb = [w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy];
      process.stdout.write(`\n      tile ${tile}/${grid * grid}…`);
      // Each tile self-subdivides on "too big" instead of re-tiling the country.
      all.push(...await fetchBboxDeep(cfg, tb, maxDepth, iso));
      await sleep(2000);
    }
  }
  // Adjacent tiles can both return a feature that straddles their shared edge.
  return turf.featureCollection(dedupe(all));
}

// Admin divisions inside an explicit bbox. Uses "out geom" so we get full
// polygon geometry. Dedupe by name happens at merge time.
async function fetchAdminBbox(level, bbox) {
  const [w, s, e, n] = bbox;
  const area = `(${s},${w},${n},${e})`;
  const q = `[out:json][timeout:170];(relation["boundary"="administrative"]["admin_level"="${level}"]${area};);out geom;`;
  const raw = await run(q);
  return toAreas(osmtogeojson(raw));
}

// Drop duplicate admin polygons that straddle tile boundaries (same name +
// admin_level appearing in two tiles). Keeps the first occurrence.
function dedupeAreas(features) {
  const seen = new Set();
  const out = [];
  for (const f of features) {
    const k = (f.properties?.name || '?') + '|' + (f.properties?.admin_level ?? '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// Split a country bbox into tiles for admin queries (same idea as fetchByTiles
// but for boundary relations). Recurses if a tile is still too big.
async function fetchAdminByTiles(level, iso, grid = 2) {
  const bb = COUNTRY_BBOX[iso];
  if (!bb) throw new Error('no bbox known for tile-split');
  const [w, s, e, n] = bb;
  const dx = (e - w) / grid, dy = (n - s) / grid;
  const all = [];
  let tile = 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      tile++;
      const tb = [w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy];
      process.stdout.write(`\n      tile ${tile}/${grid * grid}…`);
      try {
        const fc = await fetchAdminBbox(level, tb);
        all.push(...fc.features);
        process.stdout.write(` ${fc.features.length}`);
      } catch (e) {
        process.stdout.write(` FAILED (${e.message})`);
        if (/too big/.test(e.message) && grid < 8) {
          process.stdout.write(` → subdividing`);
          const sub = await fetchAdminByTiles(level, iso, grid * 2);
          all.push(...sub.features);
        } else {
          throw e;
        }
      }
      await sleep(2000);
    }
  }
  return turf.featureCollection(dedupeAreas(all));
}

async function fetchFeatureForCountries(key) {
  const cfg = FEATURES[key];
  const failures = [];
  for (const iso of COUNTRIES) {
    if (!FORCE && partExists(key, iso)) {
      const existing = readPart(key, iso);
      console.log(`   ${COUNTRY_NAMES[iso] || iso}… cached part (${existing?.features?.length ?? '?'}) — skipping`);
      continue;
    }
    process.stdout.write(`   ${COUNTRY_NAMES[iso] || iso}…`);
    const outClause = cfg.geom === 'line' ? 'out geom;' : 'out center;';
    const q = areaQuery(iso, cfg.q, outClause);
    try {
      let reduced;
      try {
        const raw = await run(q);
        reduced = cfg.geom === 'line' ? toLines(osmtogeojson(raw)) : toPoints(osmtogeojson(raw));
      } catch (e) {
        // Auto-fallback: if the whole-country query is too big, split into tiles.
        if (/too big/.test(e.message)) {
          process.stdout.write(` too big → splitting into tiles`);
          reduced = await fetchByTiles(cfg, iso);
        } else { throw e; }
      }
      // Simplify heavy lines (coastline) regardless of which path produced them.
      if (cfg.geom === 'line' && cfg.simplify) reduced = simplifyLines(reduced, cfg.simplify);
      writePart(key, iso, reduced);             // save immediately (resumable)
      process.stdout.write(` ${reduced.features.length} ✓ saved\n`);
    } catch (e) {
      failures.push(`${key}/${iso}: ${e.message}`);
      process.stdout.write(` FAILED (${e.message})\n`);
    }
    await sleep(2500);
  }
  // Merge every part on disk (all countries ever saved, not just this run's).
  const { features, isos } = mergeAllParts(key);
  if (isos.length) console.log(`   merged parts: ${isos.sort().join(', ')}`);
  let merged = turf.featureCollection(dedupe(features));
  // Re-apply simplify + precision trim at merge so the final file stays small
  // even when the cached parts were written full-resolution by an older run.
  if (cfg.geom === 'line' && cfg.simplify) {
    merged = roundLineCoords(simplifyLines(merged, cfg.simplify), 5);
  }
  return { fc: merged, failures };
}

// Round polygon coordinates to dp decimals (~11m at 4dp), dropping consecutive
// duplicate vertices and degenerate rings. Full OSM float precision (14+ digits)
// is the dominant size cost and is irrelevant to a point-in-polygon containment
// test. This is what keeps admin-4/6 small enough for a phone to parse.
function roundAreaCoords(fc, dp = 4) {
  const r = (n) => Number(n.toFixed(dp));
  const ring = (coords) => {
    const o = [];
    for (const [x, y] of coords) {
      const p = [r(x), r(y)];
      const last = o[o.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) o.push(p);
    }
    return o;
  };
  const out = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (g?.type === 'Polygon') {
      const coords = g.coordinates.map(ring).filter((rg) => rg.length >= 4);
      if (coords.length) out.push({ type: 'Feature', properties: f.properties, geometry: { type: 'Polygon', coordinates: coords } });
    } else if (g?.type === 'MultiPolygon') {
      const coords = g.coordinates.map((poly) => poly.map(ring).filter((rg) => rg.length >= 4)).filter((p) => p.length);
      if (coords.length) out.push({ type: 'Feature', properties: f.properties, geometry: { type: 'MultiPolygon', coordinates: coords } });
    } else { out.push(f); }
  }
  return turf.featureCollection(out);
}

// Simplify admin polygons then round coordinates so dense levels produce a file
// the phone can actually load. Tolerance ~500m + 4dp rounding is invisible for a
// "same division?" containment test but cuts size ~99% (admin-6: 107MB -> 1.2MB).
function simplifyAreas(fc, tolerance = 0.005) {
  const simplified = [];
  for (const f of fc.features) {
    const t = f.geometry?.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') { simplified.push(f); continue; }
    try { simplified.push(turf.simplify(f, { tolerance, highQuality: false, mutate: false })); }
    catch { simplified.push(f); }
  }
  return roundAreaCoords(turf.featureCollection(simplified), 4);
}

async function fetchAdmin(level) {
  const key = `admin-${level}`;
  const failures = [];
  for (const iso of COUNTRIES) {
    if (!FORCE && partExists(key, iso)) {
      const existing = readPart(key, iso);
      console.log(`   ${COUNTRY_NAMES[iso] || iso}… cached part (${existing?.features?.length ?? '?'}) — skipping`);
      continue;
    }
    process.stdout.write(`   ${COUNTRY_NAMES[iso] || iso}…`);
    const q = `[out:json][timeout:170];area["ISO3166-1"="${iso}"][admin_level=2]->.c;(relation["boundary"="administrative"]["admin_level"="${level}"](area.c););out geom;`;
    try {
      let reduced;
      try {
        reduced = toAreas(osmtogeojson(await run(q)));
      } catch (e) {
        // France admin-8 (and other large/dense levels) can be too big for a
        // whole-country query — fall back to tile-splitting like features do.
        if (/too big/.test(e.message)) {
          process.stdout.write(` too big → splitting into tiles`);
          reduced = await fetchAdminByTiles(level, iso);
        } else { throw e; }
      }
      // Simplify polygons to keep dense levels (France admin-8) loadable.
      reduced = simplifyAreas(reduced);
      writePart(key, iso, reduced);
      process.stdout.write(` ${reduced.features.length} ✓ saved\n`);
    } catch (e) {
      failures.push(`${key}/${iso}: ${e.message}`);
      process.stdout.write(` FAILED (${e.message})\n`);
    }
    await sleep(2500);
  }
  const { features, isos } = mergeAllParts(key);
  if (isos.length) console.log(`   merged parts: ${isos.sort().join(', ')}`);
  // Re-simplify at merge so the final file stays small even when the cached parts
  // were written full-resolution by an older run (without coord rounding).
  return { fc: simplifyAreas(turf.featureCollection(features)), failures };
}

// Country outlines (admin_level=2) for the bundled countries, from the SAME OSM
// source and SAME simplification as admin-4/6, so the app's country borders are
// the same resolution as the admin division boundaries (Natural Earth, used as
// the app's default, is a coarser separate dataset). Each feature is stamped
// with its ISO alpha-2 so the app can match it to a country.
async function fetchCountryOutlines() {
  const key = 'country';
  const failures = [];
  for (const iso of COUNTRIES) {
    if (!FORCE && partExists(key, iso)) {
      const existing = readPart(key, iso);
      console.log(`   ${COUNTRY_NAMES[iso] || iso}… cached part (${existing?.features?.length ?? '?'}) — skipping`);
      continue;
    }
    process.stdout.write(`   ${COUNTRY_NAMES[iso] || iso}…`);
    const q = `[out:json][timeout:170];relation["boundary"="administrative"]["admin_level"="2"]["ISO3166-1"="${iso}"];out geom;`;
    try {
      let reduced = simplifyAreas(toAreas(osmtogeojson(await run(q))));
      reduced.features.forEach((f) => { f.properties = { ...f.properties, iso }; });
      writePart(key, iso, reduced);
      process.stdout.write(` ${reduced.features.length} ✓ saved\n`);
    } catch (e) {
      failures.push(`${key}/${iso}: ${e.message}`);
      process.stdout.write(` FAILED (${e.message})\n`);
    }
    await sleep(2500);
  }
  const { features, isos } = mergeAllParts(key);
  if (isos.length) console.log(`   merged parts: ${isos.sort().join(', ')}`);
  // Re-simplify at merge so the final file stays small even when the cached
  // parts were written full-resolution by an older run (without coord rounding).
  return { fc: simplifyAreas(turf.featureCollection(features)), failures };
}

function writeJson(file, obj) {
  const p = path.join(OUT_DIR, file);
  fs.writeFileSync(p, JSON.stringify(obj));
  const kb = (fs.statSync(p).size / 1024).toFixed(0);
  console.log(`   → wrote ${file} (${kb} KB)`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\nPreloading for: ${COUNTRIES.join(', ')}`);
  console.log(`Features: ${FEATURE_KEYS.join(', ')}`);
  console.log(`Admin levels: ${ADMIN_LEVELS.join(', ')}`);
  console.log(`Contact UA: ${CONTACT}  (set OSM_CONTACT=you@email to customise)`);
  console.log(FORCE
    ? `Mode: --force (re-fetching everything, ignoring saved parts)\n`
    : `Mode: resume (skipping countries already saved in public/preload/parts/)\n`);

  const manifest = {
    builtAt: new Date().toISOString(),
    countries: COUNTRIES,
    features: {},
    admin: {},
  };
  // Preserve entries from a previous manifest for features/admin levels not in
  // THIS run, so running a subset (e.g. `--features golf`) tops up the manifest
  // instead of dropping everything else that's already on disk.
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8'));
    for (const [k, v] of Object.entries(prev.features || {})) {
      if (fs.existsSync(path.join(OUT_DIR, `${k}.json`))) manifest.features[k] = v;
    }
    for (const [lvl, v] of Object.entries(prev.admin || {})) {
      if (fs.existsSync(path.join(OUT_DIR, `admin-${lvl}.json`))) manifest.admin[lvl] = v;
    }
  } catch { /* no previous manifest — fine */ }
  const allFailures = [];

  for (const key of FEATURE_KEYS) {
    if (!FEATURES[key]) { console.log(`! skipping unknown feature "${key}"`); continue; }
    console.log(`• ${key} (${FEATURES[key].geom})`);
    const { fc, failures } = await fetchFeatureForCountries(key);
    allFailures.push(...failures);
    // Only write + register a feature that actually returned data, so the app
    // doesn't treat an empty/failed file as "complete preloaded data".
    if (fc.features.length > 0) {
      writeJson(`${key}.json`, fc);
      manifest.features[key] = { geom: FEATURES[key].geom, count: fc.features.length };
    } else {
      console.log(`   (no data — not written; app will fall back to live queries for ${key})`);
    }
  }

  for (const level of ADMIN_LEVELS) {
    console.log(`• admin level ${level}`);
    const { fc, failures } = await fetchAdmin(level);
    allFailures.push(...failures);
    if (fc.features.length > 0) {
      writeJson(`admin-${level}.json`, fc);
      manifest.admin[level] = { count: fc.features.length };
    } else {
      console.log(`   (no data — not written; app will fall back to live queries for admin-${level})`);
    }
  }

  // Country outlines (admin_level=2) — same OSM source + simplification as admin,
  // so the app's borders match the admin-level resolution. Fetched whenever admin
  // levels are requested (they share the same use case and processing).
  if (ADMIN_LEVELS.length) {
    console.log(`• country outlines (admin level 2)`);
    const { fc, failures } = await fetchCountryOutlines();
    allFailures.push(...failures);
    if (fc.features.length > 0) {
      writeJson(`country.json`, fc);
      manifest.countryOutlines = { count: fc.features.length };
    } else {
      console.log(`   (no data — not written; app will use Natural Earth outlines)`);
    }
  } else if (fs.existsSync(path.join(OUT_DIR, 'country.json'))) {
    // Preserve a previously-built country.json when this run skipped admin.
    try { manifest.countryOutlines = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8')).countryOutlines; } catch {}
  }

  writeJson('manifest.json', manifest);

  // Manifest countries = the union actually present across all part files on
  // disk (not just this run's --countries), so it stays accurate when you add
  // countries incrementally over several runs.
  const allIsos = new Set();
  for (const key of Object.keys(manifest.features)) {
    for (const iso of mergeAllParts(key).isos) allIsos.add(iso);
  }
  for (const level of Object.keys(manifest.admin)) {
    for (const iso of mergeAllParts(`admin-${level}`).isos) allIsos.add(iso);
  }
  if (allIsos.size) manifest.countries = [...allIsos].sort();
  // Rewrite with the corrected country union.
  writeJson('manifest.json', manifest);

  console.log(`\n✓ Done. Files are in public/preload/. They ship with the app and load instantly.`);
  console.log(`  Countries in bundle: ${manifest.countries.join(', ')}`);
  if (allFailures.length) {
    console.log(`\n⚠ ${allFailures.length} query(ies) failed and were skipped:`);
    for (const f of allFailures) console.log(`   - ${f}`);
    console.log(`\nJust re-run \`npm run preload\` to retry ONLY the failed ones —`);
    console.log(`countries already saved are skipped, so the retry is fast.`);
  }
  console.log('');
}

main().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
