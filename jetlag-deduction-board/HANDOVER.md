# Jet Lag: Hide & Seek — Deduction Board
## Full Handover Document
### Reflects the app as delivered June 2026, including all development work.

---

## 1. What This App Is

A client-side GIS deduction board for **Jet Lag: The Game — Hide and Seek**. Seekers use it to log answers from the hider and progressively narrow the hiding zone on a live map. Every question the hider answers is applied as a geometric operation — intersect or subtract — on a GeoJSON polygon representing the remaining valid hiding area.

The app runs entirely in the browser. There is no backend database, no user accounts, and no real-time sync between players. Each seeker's browser has its own independent board. The Vite/Node process (or nginx on the VPS) is purely a static file server.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + Vite 5 |
| Styling | Tailwind CSS 3 |
| Map | Leaflet 1.9 via react-leaflet 4 |
| GIS / geometry | @turf/turf v6 |
| OSM data | Overpass API via osmtogeojson |
| State | Zustand 4 |
| Persistence | localStorage (game state) + IndexedDB (OSM cache) |

**Important: Turf is pinned to v6.** In v7, `turf.intersect`, `turf.union`, and `turf.difference` changed their API to take a `FeatureCollection` instead of two arguments. Upgrading without updating `geometry.js` will silently break all clue operations.

---

## 3. Project Structure

```
jetlag-deduction-board/
├── index.html                  # Entry point (Eruda debug console removed)
├── package.json
├── vite.config.js
├── tailwind.config.js
├── .gitignore                  # Excludes node_modules, dist, .DS_Store, public/preload/parts/
├── .claude/
│   └── launch.json             # Claude Code preview server config (port 5173)
├── scripts/
│   └── preload-data.js         # One-time data downloader (run on laptop, not on phone)
├── public/
│   └── preload/                # Preloaded OSM JSON files served as static assets
│       ├── manifest.json       # Build index — used for cache-busting (?v=builtAt)
│       ├── country.json        # OSM admin_level=2 outlines for 5 bundled countries
│       ├── coastline.json      # ~1.6 MB (simplified 500m, 5dp precision)
│       ├── admin-4.json        # ~526 KB (state/region level)
│       ├── admin-6.json        # ~1.25 MB (county level)
│       ├── airport.json
│       ├── hospital.json
│       ├── mountain.json       # Only peaks ≥ 1000m elevation (was 67k → 11,883)
│       ├── park.json           # ~11 MB (96k parks NL+BE+LU+FR+DE)
│       ├── [other features].json
│       └── parts/              # Per-country raw downloads (NOT served; gitignored)
│           ├── airport__NL.json
│           ├── airport__FR.json
│           └── ...
└── src/
    ├── main.jsx                # React entry — imports Leaflet CSS
    ├── index.css               # Global styles + mobile map height fix
    ├── App.jsx                 # Root layout, sidebar/map toggle, country loader
    ├── components/
    │   ├── MapView.jsx         # Leaflet map, overlays, seeker pin, SizeFixer
    │   ├── QuestionPanel.jsx   # All 5 question categories + seeker controls
    │   ├── ClueTimeline.jsx    # Clue history with undo/delete
    │   └── CountrySelect.jsx   # Searchable country checklist
    └── lib/
        ├── geometry.js         # All Turf math — the core GIS engine
        ├── overpass.js         # OSM fetching, 3-tier cache, feature definitions
        ├── preload.js          # Reads bundled preload files
        ├── idbCache.js         # IndexedDB wrapper for persistent OSM cache
        ├── store.js            # Zustand store — game state, undo stack, persistence
        ├── countries.js        # Loads NE 50m country borders + overlays OSM outlines
        └── elevation.js        # Sea level feature via Open-Meteo API
```

---

## 4. Repositories and Deployment

**GitHub:** https://github.com/SamsDake/jetlag-deduction-board

**IONOS VPS deployment** (Ubuntu 22/24 + nginx):
```
/var/www/jetlag-deduction-board/     ← git repo
/var/www/jetlag-deduction-board/dist/ ← built output served by nginx
```

nginx config at `/etc/nginx/sites-available/jetlag`:
- Serves `dist/` as a static SPA (`try_files $uri /index.html`)
- Caches `/preload/` assets for 1 year (safe because ?v=builtAt busts on rebuild)
- Port 80 (HTTP only — no domain yet, so GPS is unavailable on mobile)

**To update after code changes:**
```bash
cd /var/www/jetlag-deduction-board
git pull
npm run build
# nginx reloads are not needed — it serves dist/ directly
```

**To enable GPS later:** point a domain at the VPS IP and add a Let's Encrypt certificate (`certbot --nginx`). Once HTTPS, `navigator.geolocation` works.

---

## 5. The Core Architectural Principle

Every question — country selection, manual shrink, and all five deduction categories — reduces to **one primitive**:

> Produce a **constraint polygon**, then either `intersect` it with the zone (keep inside) or `difference` it (cut out).

The current zone is never stored as a mutated object. It is always **derived** by folding the clue list over the base country union:

```
currentZone = unionAll(selectedCountries) → fold every clue's (polygon, mode) over it
```

This is why undo and selective delete are simple: drop a clue from the list and recompute. Each clue stores its **already-resolved geometry**, so no re-querying is needed.

---

## 6. How Each Question Category Works

### Category 1 — Nearest Feature Comparison
*"Is your nearest [feature] the same as mine?"*

- Fetches all instances of the feature in the play area.
- Finds the **Voronoi catchment cell** of the seeker's nearest instance.
- **YES → intersect** the zone with that cell. **NO → difference** (cut it out).
- For line features (coastline): samples points along each line, groups by name, dissolves the cells of the seeker's nearest line group.
- For area features (admin divisions): finds the division **polygon containing the seeker**.
- **Admin level UX:** if no division covers the seeker at the chosen level, the app probes the other level(s) and suggests where the seeker *is* covered (e.g. "Try 2nd division — the seeker is in 'Canton Luxembourg' there"). Some capitals and city-states genuinely have no admin-6 polygon (Berlin, Brussels); this is a data limitation, not a bug.

### Category 2 — Relative Distance
*"Compared to me, are you closer or further from [feature]?"*

- Measures the seeker's distance to the nearest instance (Ds).
- Buffers **every** instance by Ds and unions them.
- **Closer → intersect** (keep inside the buffers). **Further → difference** (subtract).
- **Critical rule:** NEVER add a proximity cap (keep nearest N instances) — that was a prior bug that confined results to a radius near the seeker, leaving far instances uncompared. NEVER inflate the buffer radius beyond Ds — that creates a visible fake minimum circle for dense features. Both mistakes have been made and reverted; the comments in `geometry.js:multiBuffer` document the history.
- For line features, buffers each individual segment then unions (not stitched long lines — those are super-linearly slow in JSTS).
- **Known limitation:** Parks (~96k instances) may be slow (10–30s) or hit polygon-clipping limits at very close range. All other features run in acceptable time.

### Category 3 — Hotter / Colder
*"I've moved. Am I hotter or colder?"*

- Builds a **perpendicular bisector half-plane** exactly through the midpoint of the two positions, perpendicular to the direction of travel.
- Built in a local planar frame (lon scaled by cos(lat)) so the cut passes through the exact midpoint.
- **Hotter → intersect** with the new-position half. **Colder → intersect** with the old-position half.
- Calling this clue also moves the seeker pin to the new position.

### Category 4 — Radius Proximity
*"Are you within X distance of me?"*

- Draws a geodesic circle of radius X around the seeker.
- **YES → intersect**. **NO → difference**.
- Also used for the manual "shrink point" feature.

### Category 5 — Closest of Nearby
*"Of all [features] within X distance of me, which are you closest to?"*

- Queries all instances of the feature within radius X of the seeker.
- Presents them as a pick list.
- On selection, computes a **Voronoi cell** for the chosen instance among the retrieved set.
- **Intersects** the zone with that cell.

---

## 7. Data Layer: The 3-Tier Cache

When a feature question is asked, the app looks for data in this order:

```
Tier 0: Preloaded bundle  (public/preload/<feature>.json — instant, offline)
Tier 1: In-memory Map     (cleared on page refresh)
Tier 2: IndexedDB         (persists across refreshes)
Tier 3: Live Overpass API (network query, slow)
```

**Cache key** for Tier 1/2: `feature|bbox|adminLevel` — keyed to the **base zone** (selected countries), not the shrinking current zone. This is critical: if keyed to the current zone, the key changes after every clue and the cache never hits.

**Cache-busting:** preload files are fetched with `?v=<manifest.builtAt>`. The manifest itself is always fetched `no-cache`. This means a bundle rebuild forces a fresh fetch of data files without requiring a hard refresh from users.

---

## 8. Country Outlines

Country outlines come from **two sources**:

1. **Natural Earth 1:50m** (fetched at runtime from GitHub CDN) — the worldwide fallback for any country not in the bundled 5.
2. **OSM admin_level=2** (`public/preload/country.json`) — fetched for the 5 bundled countries (NL/BE/LU/FR/DE) using the same OSM source and identical simplification as the admin-4/6 boundary files. This makes country borders match admin-level resolution exactly.

`countries.js` overlays the OSM outline onto each bundled country (matched by ISO alpha-2). The Natural Earth id is preserved so selection/persistence is unchanged.

---

## 9. Preloaded Feature Data

| Feature | File size | Count | Notes |
|---|---|---|---|
| airport | 42 KB | 318 | |
| aquarium | 14 KB | 115 | |
| cinema | 480 KB | 3,977 | |
| coastline | 1.6 MB | 10,921 | Simplified 500m; line feature |
| consulate | 231 KB | 1,658 | |
| country | 129 KB | 5 | OSM admin_level=2 outlines |
| golf | 294 KB | 2,332 | |
| hospital | 731 KB | 5,480 | |
| library | 2.2 MB | 17,055 | |
| mountain | 1.4 MB | 11,883 | **Filtered: ele ≥ 1000m only** |
| museum | 2.2 MB | 17,052 | |
| park | 11 MB | 96,433 | Dense; closer/further can be slow |
| station | 1.7 MB | 14,155 | |
| theme_park | 137 KB | 1,103 | |
| zoo | 304 KB | 2,469 | |
| admin-4 | 526 KB | 58 | State/region level |
| admin-6 | 1.25 MB | 532 | County level |

All 14 features × 5 countries (NL/BE/LU/FR/DE) are present. Total served: ~24 MB.

**`parts/` folder (229 MB):** per-country raw intermediates used for resumable downloads. **Never served to the browser. Gitignored.** Kept locally so `npm run preload` can resume without re-downloading.

---

## 10. Mountain Filter

Mountains are filtered to **≥ 1000m elevation** via an Overpass `(if: number(t["ele"]) >= 1000)` filter. This is set by `MIN_PEAK_ELE_M = 1000` in `scripts/preload-data.js` and mirrored in the `mountain.q` in `src/lib/overpass.js`.

**Why:** unfiltered OSM peak data across 5 countries is ~67k points. At close range (pin on a mountain, Ds ≈ 70m), buffering 67k circles took ~70s and produced ~13MB of clue geometry that overflowed the browser's localStorage quota (~5MB), silently breaking the save system.

**Effect:** NL/BE/LU have no mountains ≥ 1000m and correctly return empty. The Alps, Vosges, Black Forest, Massif Central, and German mid-ranges are all captured.

**To change the threshold:** update `MIN_PEAK_ELE_M` in `preload-data.js`, update the matching value in `overpass.js`, delete the old mountain part files, and re-run the preload.

---

## 11. Admin Division Coverage Gaps

Some locations genuinely have no OSM polygon at a given admin level. This is a data reality, not a bug:

| Gap | Reason |
|---|---|
| admin-4 in Luxembourg | LU's first administrative level is cantons (admin-6); no admin-4 exists |
| admin-6 in major German city-states | Berlin, Bremen, Hamburg are themselves admin-4 states with no Kreise (admin-6) beneath |
| admin-6 in Brussels-Capital | The Brussels-Capital region is admin-4; its communes are admin-8 |
| admin-6 in Netherlands | Only 37 sparse AL6 polygons exist for NL; coverage is incomplete |

The app handles this gracefully: `suggestAdminLevel()` in `QuestionPanel.jsx` probes the other level and tells the user where they *can* ask. For example, with a Luxembourg City seeker and admin-4 selected: *"Seeker is not inside any division at this level. Try '2nd division (county, AL6)' — the seeker is in 'Canton Luxembourg' there."*

---

## 12. Preload Script

```bash
npm run preload                              # all features, all 5 countries, admin 4+6
npm run preload -- --countries NL,BE        # specific countries
npm run preload -- --features airport,park  # specific features
npm run preload -- --admin 4,6              # admin levels (also builds country.json)
npm run preload -- --admin none             # skip admin entirely
npm run preload -- --force                  # ignore saved parts, re-fetch everything
```

**Resume:** per-country parts saved immediately on success. A re-run **skips any country that already has a saved part**. The final merged file is rebuilt from all parts on disk — so adding a country tops up the bundle without re-downloading existing data.

**Tile-splitting:** when a whole-country query is too big for Overpass, the script automatically splits the country into 2×2 quadrants and recurses into any tile that is still too big (depth 6, down to ~10–20km tiles). This is what made France/Germany parks succeed after the whole-country queries failed. The tile query uses `area["ISO3166-1"="XX"]` + bbox so it doesn't drag in neighbours.

**"Too big" detection fix:** the sticky `tooBig` flag in `run()` ensures that if *any* mirror reports "query too big" (even if later mirrors fail with transient network errors), the "too big" signal is preserved. Before this fix, network failures on later mirrors could mask the "too big" result and prevent tile-splitting from triggering.

**Simplification at merge:** `simplifyAreas()` (admin polygons) and `roundLineCoords()`/`simplifyLines()` (line features) are applied at the merge step, not just on fresh fetches. This means even if the cached `parts/` files are full-resolution (from an older run), the merged output files will always be properly simplified. Admin files that bloated back to 46/109 MB during a resume run were caused by a missing re-simplify at merge; this is now fixed.

**Country outlines:** built automatically whenever `--admin` levels are requested, via `fetchCountryOutlines()`. Saved as `country.json` (129 KB) with each feature stamped with `properties.iso`.

---

## 13. Running the App

### Requirements
- Node.js ≥ 18

### Install and start
```bash
cd jetlag-deduction-board
npm install        # first time only
npm run dev        # localhost:5173
npm run dev -- --host  # accessible from other devices on the same network
```

### Running on IONOS VPS (current deployment)
```bash
# On the VPS, after git pull:
npm run build
# nginx serves dist/ automatically — no restart needed
```

### Known limitation: HTTP vs HTTPS
Over plain HTTP (LAN IP or non-HTTPS VPS), browsers block:
- **GPS / `navigator.geolocation`** — use "Place pin" by tapping the map instead
- **`crypto.randomUUID()`** — the app uses a `makeId()` fallback that works over HTTP

Everything else works fine over HTTP. Deploy with HTTPS (Let's Encrypt + a domain) to unlock GPS.

---

## 14. State Management

All game state lives in Zustand (`src/lib/store.js`).

| State | What it is | Where it persists |
|---|---|---|
| `selectedIds` | Array of ISO country codes in play | localStorage |
| `seeker` | `{lat, lng}` of the seeker's current pin | localStorage |
| `clues` | Array of clue objects (see below) | localStorage |
| `baseZone` | Derived: union of selected country polygons | recomputed on load |
| `currentZone` | Derived: baseZone after all clues applied | recomputed on load |
| `countries` | Full country list loaded from CDN | not persisted |

**A clue object:**
```js
{
  id: string,           // UUID (makeId() — works over HTTP, not just HTTPS)
  mode: 'intersect' | 'difference',
  geometry: GeoJSON Feature,  // already-resolved polygon — never re-queried
  kind: string,         // 'nearest' | 'relative' | 'hotcold' | 'radius' | 'shrink' | 'target'
  label: string,        // human-readable description for the timeline
  meta: object,         // extra info (feature name, distance, etc.)
}
```

**localStorage key:** `jetlag-deduction-v1`. A full browser "clear site data" wipes it.

**Undo:** `clues.slice(0, -1)` + recompute.  
**Selective delete:** `clues.filter(c => c.id !== id)` + recompute.  
**Reset:** clear `clues`, `selectedIds`, `seeker`.

---

## 15. File-by-File Reference

### `src/lib/geometry.js`
The core GIS engine. No React knowledge — pure Turf math.

Key functions:
- `computeZone(baseZone, clues)` — derives the current zone by folding clues
- `applyClue(zone, clue)` — applies one clue (intersect or difference)
- `bisectorHalfPlane(oldPos, newPos, keep)` — Category 3; built in local planar frame
- `voronoiCell(pointsFC, targetPoint, clipZone)` — Categories 1 and 5
- `lineCatchment(linesFC, seekerPoint, clipZone)` — Category 1 for line features
- `containingPolygon(areasFC, seekerPoint)` — Category 1 for admin divisions
- `multiBuffer(pointsFC, radiusKm, _seekerPoint)` — Category 2 for point features. Buffers **every** instance at exact Ds, no proximity cap, no radius inflation. See inline comments for the history of bugs.
- `multiBufferLines(linesFC, radiusKm, _seeker)` — Category 2 for line features. Buffers each raw fragment individually then unions. Do NOT stitch fragments first (super-linearly slow).
- `unionAll(features)` — binary union for stability with large feature counts
- `mainCluster(feature, maxKm)` — drops overseas territories from country polygons
- `maskPolygon(zone)` — world rectangle minus the zone, for the dark overlay

### `src/lib/overpass.js`
OSM data fetching with 3-tier cache and mirror failover.

Key exports:
- `FEATURES` — all feature definitions. Mountain query includes `(if: number(t["ele"]) >= 1000)` filter.
- `ADMIN_LEVELS` — `[{level: 4, ...}, {level: 6, ...}]`
- `fetchFeature(key, bbox, opts)` — main entry point; checks preload → memory → IDB → network
- `clearFeatureCache()` / `invalidateFeature(key)` — cache controls

Overpass mirrors tried in order: `overpass-api.de`, `overpass.kumi.systems`, `overpass.private.coffee`, `overpass.osm.jp`.

### `src/lib/preload.js`
Reads static files from `public/preload/`. Uses `?v=builtAt` cache-busting so stale files are never served after a bundle rebuild. The manifest is fetched `no-cache` on every page load; data files are fetched `force-cache` with the versioned URL.

### `src/lib/countries.js`
Fetches Natural Earth 1:50m borders from GitHub CDN on first load. Overlays higher-resolution OSM outlines from `public/preload/country.json` for the 5 bundled countries, matched by ISO alpha-2. The `id` field stays the Natural Earth id (ISO_A3) so selection/persistence is unchanged.

### `src/lib/store.js`
Zustand store. All game state flows through here. Recomputation is triggered by `recompute(set, get, patch)` which applies `computeZone` and persists to localStorage. The `makeId()` function is the `crypto.randomUUID()` fallback that works over plain HTTP.

### `src/lib/elevation.js`
Fetches a coarse 11×11 grid of elevations from Open-Meteo's free API. Classifies cells as closer or further from sea level than the seeker. Returns a constraint polygon or null on failure.

### `src/lib/idbCache.js`
Thin IndexedDB wrapper. All operations are null-safe. Schema version 2: records from older schema versions are ignored so upgrading query logic doesn't serve stale data.

### `src/components/MapView.jsx`
The Leaflet map. Notable details:
- `preferCanvas` is **not used** — it caused tile/overlay rendering failure on Android
- `detectRetina={false}` — prevents 2× tile image requests that caused partial tile failures on Pixel 9a
- `SizeFixer` component — calls `map.invalidateSize()` via a `ResizeObserver` and on the `visible` prop change. Critical on mobile: the map mounts inside a `display:none` parent and measures zero height until shown.
- Mask key computed inside `useMemo([currentZone])` — not inline in JSX — to avoid serializing the full zone polygon on every render.

### `src/components/QuestionPanel.jsx`
All five category controls plus seeker placement and manual shrink. Key details:
- `getData()` uses `bboxOf(baseZone)` (stable) not `bboxOf(currentZone)` (shrinking) — this keeps the cache key stable so questions hit the cache after the first query.
- `suggestAdminLevel()` — probes other admin levels when the seeker has no division at the chosen level, then provides a guiding message instead of a dead-end.

### `scripts/preload-data.js`
Node script (not part of the browser app). Key behaviours:
- **Resumable:** per-country parts saved immediately; re-runs skip saved parts
- **Tile-splitting:** `fetchBboxDeep(cfg, bbox, depth, iso)` recurses into only the failing quadrant, up to depth 6. Does NOT re-tile the whole country.
- **Country-precise tiles:** uses `area["ISO3166-1"="XX"](area.c)` combined with bbox so tiles don't pull in neighbouring countries.
- **Sticky "too big" signal:** in `run()`, if any mirror returns "too big", that error is surfaced even if later mirrors fail with network errors.
- **Re-simplify at merge:** both `fetchAdmin()` and `fetchCountryOutlines()` call `simplifyAreas()` on the merged result — not just on fresh fetches — so full-resolution cached parts never bloat the output files.
- **Country outlines:** `fetchCountryOutlines()` fetches admin_level=2 per country, stamps `properties.iso`, simplifies identically to admin-4/6, writes `country.json`.
- **Simplification:** coastline (~500m + 5dp rounding), admin polygons (~500m + 4dp rounding). Both applied at merge so the files stay small even on resume runs.
- `MIN_PEAK_ELE_M = 1000` — mountain elevation threshold. Change here and in `overpass.js`, delete old mountain parts, re-run preload.

---

## 16. Known Limitations

| Limitation | Detail |
|---|---|
| **GPS doesn't work over HTTP** | Requires HTTPS (or localhost). Use map tap instead. Fix: domain + Let's Encrypt. |
| **Each player has their own board** | No shared/synced state. All seekers must apply clues on their own device. |
| **Sea level is approximate** | Coarse 11×11 elevation grid from Open-Meteo. ~10–20km accuracy. |
| **Parks closer/further can be slow** | 96k instances at close range may take 10–30s or hit polygon-clipping limits. |
| **Coastline closer/further is ~8–10s** | 10,921 fragments each buffered individually. Correct but slow. |
| **Admin gaps in some cities/countries** | Berlin/Brussels/Hamburg/LU city-state/NL have no admin-6 coverage at certain levels. App guides the user to the working level. |
| **Map tiles need internet** | Tile images are fetched from CARTO's CDN on demand. Not preloaded. |
| **iOS Safari IndexedDB eviction** | Data cached in IndexedDB may be evicted if the app isn't opened for ~7 days. |
| **Parts folder not gitignored on older clones** | `public/preload/parts/` is gitignored in the current repo but old clones may have it tracked. |

---

## 17. Important Invariants — Do Not Break

1. **Turf v6 API:** `turf.intersect(a, b)`, `turf.union(a, b)`, `turf.difference(a, b)` take two arguments. Upgrading to v7 requires updating `safeIntersect`, `safeDifference`, `safeUnion` in `geometry.js`.

2. **Cache key uses baseZone bbox, not currentZone bbox.** If this is changed, the cache never hits and every question re-downloads.

3. **multiBuffer must buffer every instance at exact Ds with no cap and no radius inflation.** Any proximity cap (keep nearest N) or radius inflation (r > Ds) produces geometrically wrong results. The comments in `geometry.js:multiBuffer` explain the two bugs that were introduced and reverted.

4. **multiBufferLines must buffer raw short fragments, not stitched long lines.** Long lines are super-linearly expensive in JSTS; the same data stitched took 38s vs 4s for raw fragments.

5. **Admin merge must re-apply simplifyAreas().** The cached `parts/` files are full-resolution. Without re-simplifying at merge, a resume run will regenerate 46/109 MB admin files instead of 526 KB/1.25 MB.

6. **`preferCanvas` must not be added to Leaflet.** It caused tile/overlay rendering failure on Android.

7. **MapView mask key must not be computed inline in JSX.** Inline `JSON.stringify(mask)` runs on every render; it must stay inside `useMemo([currentZone])`.

---

## 18. Adding a New Country to the Bundle

```bash
# e.g. adding Italy
npm run preload -- --countries IT --features airport,station,museum,library,cinema,hospital,zoo,aquarium,theme_park,park,golf,consulate,mountain,coastline --admin 4,6
```

Resume logic skips existing parts. Only Italy's data downloads. Then:
1. Select Italy in the app's country picker — it uses the Natural Earth outline until a preload country outline exists.
2. To also get the OSM outline for Italy: the `--admin` flag triggers `fetchCountryOutlines()` which will add Italy to `country.json`.

---

## 19. Adding a New Feature Type

1. Add it to `FEATURES` in `src/lib/overpass.js` with a key, label, geom type, modes, and OSM query.
2. Add the same entry to `FEATURES` in `scripts/preload-data.js`.
3. Run `npm run preload -- --features <newkey>` to bundle it.
4. For line features: only `relative` mode is well-tested. Nearest/catchment for lines is implemented but complex.

---

## 20. Upgrading Turf to v7

All boolean geometry operations (`intersect`, `union`, `difference`) moved to `FeatureCollection` args in v7. Update the wrappers in `geometry.js`:
```js
// v7 versions:
export function safeIntersect(a, b) {
  try { return turf.intersect(turf.featureCollection([a, b])); } catch { return a; }
}
// same pattern for safeDifference and safeUnion
```

---

## 21. Dependencies (runtime only)

| Package | Version | Purpose |
|---|---|---|
| `@turf/turf` | ^6.5.0 | All GIS math |
| `leaflet` | ^1.9.4 | Map rendering |
| `react-leaflet` | ^4.2.1 | React wrapper for Leaflet |
| `osmtogeojson` | ^3.0.0-beta.5 | Converts Overpass JSON to GeoJSON |
| `react` + `react-dom` | ^18.3.1 | UI framework |
| `zustand` | ^4.5.5 | State management |

No external services require API keys. Map tiles (CARTO CDN), country data (GitHub CDN), and OSM data (Overpass public API) are all free and keyless.

---

## 22. Bug History — Problems Fixed and Why

This section documents every significant bug found and fixed during development, so future maintainers understand what not to reintroduce.

### coastline.json was 55.7 MB (never actually simplified)
The preload script had `simplify: 0.005` in the config but the merge step concatenated raw parts without re-applying it. Fixed by calling `roundLineCoords(simplifyLines(merged, cfg.simplify), 5)` at merge. Result: 55.7 MB → 1.6 MB.

### multiBuffer proximity cap — "closer/further" confined to a radius
The original `multiBuffer` kept only the 400 instances nearest the seeker. Dense features (hospitals 5,480, parks 96k) produced results that looked like a circle around the seeker. Sparse features (airports 318) were below the cap and worked. Fixed by removing the cap and buffering all instances.

### multiBuffer radius inflation — fake minimum circle for dense features
A `gridThin` approach was added to handle very dense features (parks 96k). When the point count exceeded 2,500, it inflated the buffer radius to the grid cell size (r = max(Ds, cell)). This made 8 features (cinema, hospital, museum, library, station, mountain, park, coastline) show a large blob instead of tight rings. Fixed by reverting to plain binaryUnion of all instances at exact Ds.

### multiBufferLines proximity cap — only one coast covered
A proximity cap on `multiBufferLines` kept only coastline segments near the seeker, leaving far coasts (e.g. German coast for a Benelux seeker) un-buffered. Fixed by removing the cap and buffering all fragments.

### multiBufferLines with stitched long lines — 38s vs 4s
Stitching raw fragments into continuous polylines before buffering made buffering super-linearly slow in JSTS (38s vs 4s for raw fragments). Reverted to buffering individual short fragments.

### "too big" signal masked by later mirror failures
In `run()`, if mirror 1 said "too big" but mirrors 3–4 had network failures, the thrown error was the last mirror's ("fetch failed"). The tile-split trigger checked `/too big/` and never matched. Fixed with a sticky `tooBig` flag: if any mirror reports "too big", that error is surfaced regardless of later failures.

### Tile-splitter re-tiled the whole country
When a tile was too big, the old splitter called `fetchByTiles(cfg, iso, grid * 2)` — re-fetching the entire country at a finer grid, duplicating features, and hitting a hard cap of 4×4. Fixed: `fetchBboxDeep` recurses into only the failing quadrant, not the whole country.

### Admin files bloated to 46/109 MB on resume
`fetchAdmin()` merged parts from disk without re-simplifying. Since parts are saved full-resolution, a resume run re-wrote the bloated files. Fixed by calling `simplifyAreas()` in the merge return of both `fetchAdmin()` and `fetchCountryOutlines()`.

### Preload cache served stale files after bundle rebuild
`loadFile()` used `fetch(url, { cache: 'force-cache' })` on a stable URL, so browsers cached the old file forever. Fixed with `?v=<manifest.builtAt>` — changes only when the bundle changes, so rebuilds bust the cache while unchanged bundles still hit the HTTP cache.

### MapView mask key re-serialized zone on every render
`key={'mask-' + JSON.stringify(mask).length}` ran inline in JSX, serializing the full zone polygon on every store change. Moved into `useMemo([currentZone])` so it runs once per zone change.

### Admin "same division" dead-end message
When no polygon covered the seeker at the chosen admin level, the message was "Seeker is not inside any division at this level." — no guidance. Fixed with `suggestAdminLevel()` which probes other levels and names the division that does cover the seeker.

### Country outlines lower-resolution than admin boundaries
Country outlines came from Natural Earth 1:50m (coarse, different source) while admin boundaries came from OSM. Fixed by preloading OSM admin_level=2 outlines for the 5 bundled countries with the same simplification as admin-4/6, and overlaying them in `countries.js`.

---

*Document generated: June 2026. Reflects the app as delivered, including all development and fixes.*
