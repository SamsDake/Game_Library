// countries.js
// Loads Natural Earth 1:50m admin-0 country borders (~3 MB) at runtime as the
// default world-wide country list. For the bundled countries we additionally
// overlay higher-resolution OSM outlines from public/preload/country.json so the
// country borders match the resolution of the preloaded admin-level boundaries
// (same OSM source, same simplification). Natural Earth remains the fallback for
// every other (non-bundled) country.
//
// For city-scale precision worldwide you can swap to ne_10m_admin_0_countries
// (~13 MB) — crisper everywhere but heavier downloads and clipping.

const SOURCE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

// Vite serves /public at the web root; BASE_URL handles a non-root deploy.
const base = (import.meta.env?.BASE_URL || '/').replace(/\/$/, '');

let cache = null;

// Natural Earth's ISO_A2 (and ISO_A3) are '-99' for some entries; fall back to
// other code fields so we can still key bundled outlines onto them.
function neAlpha2(p) {
  const a2 = p.ISO_A2 && p.ISO_A2 !== '-99' ? p.ISO_A2 : (p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : null);
  return a2 ? a2.toUpperCase() : null;
}

// Load preloaded OSM country outlines keyed by ISO alpha-2. Returns a Map or an
// empty Map if the bundle is absent (then everything stays Natural Earth).
async function loadPreloadedOutlines() {
  const map = new Map();
  try {
    // Cache-bust by manifest build time so a rebuilt bundle isn't served stale.
    let ver = '';
    try {
      const m = await fetch(`${base}/preload/manifest.json`, { cache: 'no-cache' });
      if (m.ok) { const j = await m.json(); if (j.builtAt) ver = `?v=${encodeURIComponent(j.builtAt)}`; }
    } catch { /* no manifest — fine */ }
    const res = await fetch(`${base}/preload/country.json${ver}`, { cache: 'force-cache' });
    if (!res.ok) return map;
    const fc = await res.json();
    for (const f of fc.features || []) {
      const iso = (f.properties?.iso || '').toUpperCase();
      if (iso) map.set(iso, f);
    }
  } catch { /* no preloaded outlines — fall back to Natural Earth */ }
  return map;
}

export async function loadCountries() {
  if (cache) return cache;
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Failed to load country data (${res.status})`);
  const fc = await res.json();
  const outlines = await loadPreloadedOutlines();

  cache = fc.features
    .map((f) => {
      const p = f.properties || {};
      const iso = p.ISO_A3 && p.ISO_A3 !== '-99' ? p.ISO_A3 : (p.ADM0_A3 || p.NAME);
      // Replace the coarse Natural Earth geometry with the higher-resolution OSM
      // outline for bundled countries, matched by ISO alpha-2. The id stays the
      // NE id so selection/persistence is unchanged.
      const a2 = neAlpha2(p);
      const hi = a2 ? outlines.get(a2) : null;
      const feature = hi ? { type: 'Feature', properties: f.properties, geometry: hi.geometry } : f;
      return { id: iso, name: p.NAME || p.ADMIN || iso, feature };
    })
    .filter((c) => c.id && c.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}
