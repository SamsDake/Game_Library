# Hide & Seek — Digital Deduction Board

A client-side GIS app inspired by *Jet Lag: The Game – Hide and Seek*. Seekers
pick the countries in play, drop their own pin, and log the hider's answers as
questions. Each answer slices the hiding zone on a live map. Everything runs in
the browser; the full deduction state survives a refresh via `localStorage`.

Stack: **React + Vite + Tailwind + Leaflet (react-leaflet) + Turf.js + Zustand**.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

No API keys. Map tiles come from CARTO's free dark basemap, country borders from
a public CDN, and POIs from the OpenStreetMap Overpass API.

## The one idea that runs the whole app

Every question — country selection, manual shrink, and all five deduction
categories — reduces to a single primitive:

> produce a **constraint polygon**, then either `intersect` it with the zone
> (keep what's inside) or `difference` it (cut it out).

So the entire game is:

```
currentZone = countries.union()  →  fold every clue's (polygon, mode) over it
```

That's why the requirements fall out cleanly:

| Requirement            | How it works                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| Immutable history      | `clues[]` is never mutated; the zone is *derived* by `computeZone`. |
| Undo last clue         | drop the last clue, recompute.                                      |
| Delete any clue        | drop it by id, recompute — order-independent, no Overpass re-fetch. |
| Persistence            | `clues` (with resolved geometry), `selectedIds`, `seeker` → `localStorage`. |
| Feature data cache     | OSM pulls → in-memory `Map` + `IndexedDB` (survives refresh; complete results only). |
| Area %                 | `turf.area(currentZone) / turf.area(baseZone)`.                     |

Each clue stores its **already-resolved** geometry, so recomputing after a
delete is pure polygon math and never depends on re-querying live data.

## Project structure

```
src/
  lib/
    geometry.js   # all Turf math — circles, bisector half-plane, multi-buffer,
                  #   Voronoi catchments, the intersect/difference pipeline
    overpass.js   # OSM POI fetching + filters (airport, museum, station, …)
    countries.js  # loads simplified world GeoJSON from a CDN
    store.js      # Zustand store: clue pipeline, undo/delete, persistence
  components/
    MapView.jsx        # Leaflet map, world mask, zone outline, seeker pin, clicks
    CountrySelect.jsx  # searchable country checklist
    QuestionPanel.jsx  # the deduction console (all categories)
    ClueTimeline.jsx   # logged clues with per-clue % reduction + delete
  App.jsx              # responsive shell + stats
```

## Question categories → geometry

The feature dropdown now spans three geometry kinds, and each question picks the
right operation automatically:

| Feature kind | Examples | "Same nearest?" operation |
| ------------ | -------- | ------------------------- |
| **point** | airport, hospital, station, **mountain (peak)**, museum, library, cinema, zoo, aquarium, amusement park, park, golf, consulate | Voronoi catchment cell of the seeker's nearest instance |
| **line**  | **train line (railway)** | line catchment — dense samples along each line, grouped by name, partitioned by Voronoi, dissolved to the seeker's nearest line |
| **area**  | **administrative division** (level 4/6/8/10 → region/county/district/parish) | the division polygon that *contains* the seeker |

| # | Question                              | Constraint produced                                  | Mode |
| - | ------------------------------------- | ---------------------------------------------------- | ---- |
| 1 | Same nearest feature / same division? | catchment / containing polygon (per table above)     | YES→intersect / NO→difference |
| 2 | Closer/further from a feature?        | union of buffers (radius = seeker→nearest distance) around every instance/line | closer→intersect / further→difference |
| 3 | Hotter/colder after moving            | half-plane on the far side of the perpendicular bisector | intersect |
| 4 | Within X distance?                    | geodesic circle of radius X around seeker            | YES→intersect / NO→difference |
| 5 | Closest of features within X?         | Voronoi cell of the chosen instance among the in-radius set (points only) | intersect |

All distances use Turf's geodesic helpers, so circles and buffers respect
Earth's curvature rather than being flat pixel circles.

### What changed in this revision

- **Offline preloaded data (instant feature questions).** A new script,
  `scripts/preload-data.js`, downloads all feature data for a set of countries
  once and writes it into `public/preload/`. The app checks that bundle first
  (Tier 0, before cache and network), so feature questions for the bundled
  countries are instant and work with no internet during play.

  Run it from your laptop:

  ```bash
  npm run preload                              # default: NL, BE, LU, FR, DE, GB
  npm run preload -- --countries NL,BE,DE      # custom country set (ISO alpha-2)
  npm run preload -- --features airport,railway,hospital
  npm run preload -- --admin 4,6,8             # which admin levels to bundle
  ```

  Overpass requires a descriptive `User-Agent` (anonymous requests get HTTP 406)
  and throttles heavy clients (429). The script sends a proper User-Agent and
  retries 429s with backoff across several mirrors; set your own contact with
  `OSM_CONTACT="you@email.com" npm run preload` if you like (good etiquette for
  heavy use).

  **Resumable & incremental.** Each country's result for each feature is saved
  immediately under `public/preload/parts/` as it downloads. A re-run **skips
  countries already saved** and only retries what's missing or failed — so if,
  say, France's railways fail (its rail network is huge), you just run
  `npm run preload` again and it re-fetches only `railway/FR`, then merges all
  parts into the final files. Use `--force` to re-fetch everything from scratch.
  If a whole-country query is too big for the servers, the script automatically
  splits that country into tiles (and sub-tiles if needed) and unions the
  results, so dense features like French railways still complete.

  **Adding more later.** The merge step always combines *every* part file on
  disk, so you can extend the bundle any time without losing what you have:

  ```bash
  npm run preload -- --countries IT            # add Italy to all features
  npm run preload -- --countries UK            # add the UK (alias for ISO GB)
  npm run preload -- --features golf,consulate # add features you skipped
  npm run preload -- --admin 10                # add an admin level
  ```

  Adding a country tops up every feature's merged file (it won't shrink to just
  the new country), and running a subset of features preserves the manifest
  entries for everything already on disk. The manifest's country list is
  recomputed from the union of all parts present, so it always reflects what's
  actually bundled.

  It queries per country using OSM area filters (precise; doesn't drag in
  neighbours), merges and de-duplicates across countries, and writes one file
  per feature plus a `manifest.json`. The whole run for the default countries and all
  features can take 10–20 minutes (it paces requests to be polite to the public
  servers) and produces several MB of data — that's the trade-off for instant
  in-game lookups. Re-run any time to refresh; commit `public/preload/` so it
  ships with the app. Features without a preload file (or countries you didn't
  bundle) fall back to the existing live-query + cache path automatically.
  Border and sea level are not preloaded (border is computed locally; sea level
  uses a live elevation API).

  (Verified by a 7-case test: preloaded points/lines/admin serve with zero
  Overpass calls, and un-bundled features/levels correctly fall through.)

### What changed earlier in this series

- Cache keyed to the stable base area (not the shrinking zone) so it actually
  hits; features clipped to the current zone locally.
- Persistent two-tier cache: in-memory `Map` + IndexedDB (survives refresh),
  complete-results-only guard across both tiers.
- Hotter/colder bisector fixed; coastline/continental railways fixed via
  multi-mirror failover; sea level via the Open-Meteo elevation API; overseas
  territories handled by `mainCluster()`; `osmtogeojson` fixed airports/hospitals;
  train lines, mountains, admin divisions, coastline, border, sea level added.

### Honest caveats on the new features

- **Train-line grouping** keys lines by OSM `name`; unnamed segments fall back
  to per-segment. A route mapped as many ways is treated as one line (usually
  what you want), but messy tagging can fragment it. Tune `maxSamples` in
  `lineCatchment` for accuracy vs. speed.
- **Admin levels vary by country** — the level→label mapping is a guide. UK:
  6 ≈ county, 8 ≈ district, 10 ≈ civil parish. Containment needs the seeker to
  sit inside a fetched division; near borders it says so rather than guess.
- **Relative-distance buffers** cap to the nearest ~400 instances for speed.
- **International border** is the boundary of the *selected* play area, so it
  includes coastline where a country meets the sea, and only shows borders
  between two countries if both are selected. For literal land borders against
  unselected neighbours, query OSM `admin_level=2` instead.
- **Sea level is experimental.** There's no vector feature for elevation, so it
  samples a coarse 10×10 grid from the public OpenTopoData API and approximates
  the region nearer/farther from sea level than the seeker. The API is
  rate-limited (~1 call/sec, 1000/day) and may be unavailable; the app degrades
  gracefully with a status message. For real use, host your own DEM/tiles.
- **`mainCluster` drops distant territory** (Hawaii, French Guiana, the Dutch
  Caribbean) beyond ~2500 km of a country's main landmass. That's the right call
  for a regional game but means you can't play *in* those territories without
  raising the threshold in `geometry.js`.
- **Borders at 50m** are a balance; swap the URL in `countries.js` to
  `ne_10m_admin_0_countries.geojson` (~13 MB) for city-scale precision.

## What's fully working vs. worth hardening

Working end-to-end out of the box: country selection + masking, seeker pin (map
click **and** GPS), manual shrink (safe/exclusion), Category 3 (hotter/colder),
Category 4 (radius), the undo stack, selective delete, persistence, and area
stats. Categories 1, 2 and 5 are wired to live Overpass and work, but in a real
game you'll want to:

- **Cache & rate-limit Overpass.** It's a shared free service (HTTP 429/504
  under load). Cache results per (feature, bbox) and add retry/backoff, or run
  your own instance.
- **Add more features.** `FEATURE_FILTERS` in `overpass.js` covers the common
  ones; add coastline/water/admin-border (these are lines/polygons, so you'd
  buffer/clip the geometry rather than reduce to a centre point).
- **Voronoi at scale.** `turf.voronoi` needs a bbox and can get heavy with
  thousands of points — clip POIs to the zone first (already done) and consider
  capping counts.
- **Turf version.** Pinned to v6 for the simple 2-arg boolean API
  (`turf.intersect(a, b)`). Turf v7 takes a `FeatureCollection` instead — adjust
  the wrappers in `geometry.js` if you upgrade.

## Notes

- Country borders are a ~250 KB simplified dataset for snappy boolean ops. Swap
  the URL in `countries.js` for a high-res set if you need precise coastlines.
- `crypto.randomUUID()` requires a secure context (https or localhost) — fine
  for `npm run dev` and any real deployment.
