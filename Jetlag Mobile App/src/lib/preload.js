// preload.js
// Loads bundled feature data produced by scripts/preload-data.js from
// public/preload/. When a feature has a preloaded file, the app uses it
// directly — instant, no Overpass call, works offline. Files are fetched from
// the app's own origin (the Vite/preview server), so this is a local load.
//
// Returned shape matches fetchFeature(): { geom, fc, complete, cached }.
// Preloaded data is considered authoritative for the bundled countries, so
// complete = true. Results are clipped to the current zone by the caller.

let _manifest = null;
let _manifestTried = false;
const _fileCache = new Map(); // feature/admin key -> FeatureCollection (in-memory)

// Vite serves /public at the web root; BASE_URL handles a non-root deploy.
const base = (import.meta.env?.BASE_URL || '/').replace(/\/$/, '');
const url = (file) => `${base}/preload/${file}`;

export async function getManifest() {
  if (_manifestTried) return _manifest;
  _manifestTried = true;
  try {
    const res = await fetch(url('manifest.json'), { cache: 'no-cache' });
    if (res.ok) _manifest = await res.json();
  } catch { _manifest = null; }
  return _manifest;
}

// True if a usable preloaded file exists for this feature (or admin level).
export async function hasPreload(featureKey, adminLevel) {
  const m = await getManifest();
  if (!m) return false;
  if (featureKey === 'admin') return !!(adminLevel != null && m.admin && m.admin[adminLevel]);
  return !!(m.features && m.features[featureKey]);
}

async function loadFile(file, key) {
  if (_fileCache.has(key)) return _fileCache.get(key);
  // Cache-bust by the manifest's build timestamp. The preload file URLs are
  // otherwise stable, so `force-cache` would serve a STALE copy forever after
  // the bundle is rebuilt (e.g. adding France parks/mountains): a plain refresh
  // never re-fetches. Appending ?v=<builtAt> changes the URL only when the
  // bundle changes — so a rebuild forces a fresh fetch, while an unchanged
  // bundle still hits the HTTP cache (offline keeps working).
  const m = await getManifest();
  const ver = m?.builtAt ? `?v=${encodeURIComponent(m.builtAt)}` : '';
  const res = await fetch(url(file) + ver, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`preload file missing: ${file}`);
  const fc = await res.json();
  _fileCache.set(key, fc);
  return fc;
}

// Returns the fetchFeature-shaped result from preloaded data, or null if none.
// IMPORTANT: the file's existence is authoritative, not the manifest. We try to
// load the file directly and only treat it as "no preload" if the fetch fails
// (404) or the file has no features. This means a coastline.json that exists but
// is missing from manifest.json is still used — previously a manifest mismatch
// silently fell through to the (slow, timeout-prone) live query.
// `geomHint` comes from the caller's FEATURES config so we don't depend on the
// manifest to know whether it's a point/line/area layer.
export async function fetchFeaturePreloaded(featureKey, adminLevel, geomHint) {
  if (featureKey === 'admin') {
    if (adminLevel == null) return null;
    try {
      const fc = await loadFile(`admin-${adminLevel}.json`, `admin-${adminLevel}`);
      if (!fc?.features?.length) {
        console.warn(`[preload] admin-${adminLevel}.json loaded but has no features`);
        return null;
      }
      console.info(`[preload] using admin-${adminLevel}.json (${fc.features.length} divisions) — no live query`);
      return { geom: 'area', fc, complete: true, cached: 'preload' };
    } catch (e) {
      console.warn(`[preload] admin-${adminLevel}.json not found (${e.message}) — falling back to live query`);
      return null;
    }
  }

  // Prefer the geom from the manifest if present, else the caller's hint.
  let geom = geomHint;
  const m = await getManifest();
  if (m?.features?.[featureKey]?.geom) geom = m.features[featureKey].geom;
  if (!geom) return null; // can't interpret the file without knowing its type

  try {
    const fc = await loadFile(`${featureKey}.json`, featureKey);
    if (!fc?.features?.length) {
      console.warn(`[preload] ${featureKey}.json loaded but has no features`);
      return null;
    }
    console.info(`[preload] using ${featureKey}.json (${fc.features.length} features) — no live query`);
    return { geom, fc, complete: true, cached: 'preload' };
  } catch (e) {
    console.warn(`[preload] ${featureKey}.json not found (${e.message}) — falling back to live query`);
    return null; // file genuinely absent → fall through to cache/network
  }
}
