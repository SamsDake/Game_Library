// geometry.js
// The geospatial engine. Every question produces a "constraint" — a polygon
// plus a mode ('intersect' = keep inside, 'difference' = cut out). The store
// applies these uniformly. Nothing here knows about React.
//
// Pinned to @turf/turf v6 (2-arg boolean API: turf.intersect(a, b)).

import * as turf from '@turf/turf';

export const WORLD_BBOX = [-180, -85, 180, 85];

// ---------------------------------------------------------------------------
// Boolean ops (null-safe).
// ---------------------------------------------------------------------------
export function safeIntersect(a, b) {
  if (!a || !b) return null;
  try { return turf.intersect(a, b); } catch { return a; }
}
export function safeDifference(a, b) {
  if (!a) return null;
  if (!b) return a;
  try { return turf.difference(a, b); } catch { return a; }
}
export function safeUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  try { return turf.union(a, b) || a; } catch { return a; }
}

// Balanced (binary) union — stable and fast for hundreds of polygons.
export function binaryUnion(features) {
  let layer = (features || []).filter(Boolean);
  if (!layer.length) return null;
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(i + 1 < layer.length ? safeUnion(layer[i], layer[i + 1]) : layer[i]);
    }
    layer = next;
  }
  return layer[0];
}

export function unionAll(features) {
  if (!features || !features.length) return null;
  return binaryUnion(features);
}

// Reduce a country MultiPolygon to its main landmass cluster, dropping
// far-flung overseas territories (Dutch Caribbean, French Guiana/Réunion, etc.)
// that otherwise blow the bounding box across an ocean and break the bisector
// math and Overpass queries. Keeps the largest polygon plus any polygon within
// `maxKm` of it (so archipelagos like the UK/Japan stay intact).
export function mainCluster(feature, maxKm = 2500) {
  const g = feature?.geometry;
  if (!g || g.type !== 'MultiPolygon' || g.coordinates.length <= 1) return feature;

  const withArea = g.coordinates.map((coords) => {
    const p = turf.polygon(coords);
    let ar = 0; try { ar = turf.area(p); } catch {}
    return { p, ar };
  });
  withArea.sort((a, b) => b.ar - a.ar);
  const anchor = withArea[0].p;
  const anchorArea = withArea[0].ar || 1;
  const ac = turf.centroid(anchor);

  const kept = withArea
    .filter(({ p, ar }, i) => {
      if (i === 0) return true;
      const limit = ar >= anchorArea * 0.15 ? maxKm * 1.6 : maxKm; // be generous to big islands
      try { return turf.distance(ac, turf.centroid(p), { units: 'kilometers' }) <= limit; }
      catch { return false; }
    })
    .map((x) => x.p);

  const merged = binaryUnion(kept) || anchor;
  merged.properties = feature.properties;
  return merged;
}

// ---------------------------------------------------------------------------
// THE PIPELINE
// ---------------------------------------------------------------------------
export function applyClue(zone, clue) {
  if (!zone) return null;
  return clue.mode === 'intersect'
    ? safeIntersect(zone, clue.geometry)
    : safeDifference(zone, clue.geometry);
}
export function computeZone(baseZone, clues) {
  let zone = baseZone;
  for (const c of clues) { if (!zone) break; zone = applyClue(zone, c); }
  return zone;
}

// ---------------------------------------------------------------------------
// Constraint generators
// ---------------------------------------------------------------------------
export function circle(center, radiusMeters) {
  return turf.circle([center.lng, center.lat], radiusMeters / 1000, {
    steps: 128, units: 'kilometers',
  });
}

const clampLat = (lat) => Math.max(-89, Math.min(89, lat));
const clampLng = (lng) => Math.max(-179.9, Math.min(179.9, lng));

// Category 3 — perpendicular-bisector half-plane. Built in a local planar frame
// (longitude scaled by cos(lat)) so the dividing edge passes EXACTLY through the
// midpoint and is perpendicular to the old→new segment. Using great-circle
// destinations here bows the line poleward and misses the midpoint, which is
// what broke the bisection. `keep` = 'new' (hotter, toward new) or 'old'.
export function bisectorHalfPlane(oldPos, newPos, keep) {
  const mid = { lng: (oldPos.lng + newPos.lng) / 2, lat: (oldPos.lat + newPos.lat) / 2 };
  const kx = Math.cos((mid.lat * Math.PI) / 180) || 1e-6; // lng → local-metric scale

  // Unit vector old→new in scaled space.
  let ux = (newPos.lng - oldPos.lng) * kx;
  let uy = newPos.lat - oldPos.lat;
  const len = Math.hypot(ux, uy) || 1e-9;
  ux /= len; uy /= len;
  if (keep === 'old') { ux = -ux; uy = -uy; } // extend toward the kept side
  const px = -uy, py = ux; // perpendicular = direction along the bisector edge

  const L = 25; // half-width of the dividing edge (degrees, ~2800 km)
  const D = 50; // depth into the kept half-plane (degrees)
  const corners = [
    [px * L, py * L],                       // mid + L·perp  (on the bisector)
    [-px * L, -py * L],                      // mid − L·perp  (on the bisector)
    [-px * L + ux * D, -py * L + uy * D],    // far side
    [px * L + ux * D, py * L + uy * D],
  ];
  const ring = corners.map(([sx, sy]) => [clampLng(mid.lng + sx / kx), clampLat(mid.lat + sy)]);
  ring.push(ring[0]);
  return turf.polygon([ring]);
}

// Category 2 (points) — buffer EVERY instance by Ds and union into one region.
// "Closer/further than me to the nearest <feature>" compares the hider's distance
// to ANY instance against the seeker's (Ds), so every instance must be buffered.
//
// DO NOT add a proximity cap (keep nearest N to seeker) — that was a prior bug
// that confined results to a radius around the seeker, leaving far instances
// uncompared. DO NOT inflate the buffer radius beyond Ds — that creates a visible
// minimum circle for dense features (cinemas, hospitals, museums, etc.) that is
// geometrically wrong. Both mistakes have been made and reverted here.
//
// For very dense features (parks ~96k) this can be slow (~10-30s) or may hit
// polygon-clipping limits on extreme close-range queries; that is a known
// limitation of the current data size. All features up to ~17k instances
// (museum, library) run in acceptable time at typical Ds values.
export function multiBuffer(pointsFC, radiusKm, _seekerPoint) {
  const buffers = [];
  for (const p of pointsFC.features) {
    const c = p.geometry?.coordinates;
    if (!c) continue;
    const b = turf.buffer(p, radiusKm, { units: 'kilometers' });
    if (b) buffers.push(b);
  }
  return binaryUnion(buffers);
}

// Category 2 (lines) — buffer EVERY coastline fragment by Ds and union into one
// region. This question compares the hider's distance to *any* coast against the
// seeker's (Ds), so the constraint must cover the WHOLE game area — every coast,
// not just the ones near the seeker.
//
// IMPORTANT — do NOT add a proximity cap (keep only the N segments nearest the
// seeker): that leaves far coasts (e.g. the German coast for a BeNeLux seeker)
// un-buffered, so "further" fails to cut their coastal strips and "closer" fails
// to keep them. The whole coastline must be buffered.
//
// Performance — buffer each SHORT raw fragment individually, then binary-union.
// Measured on the preloaded simplified coastline (~10.9k fragments): buffering
// ≈0.9s + union ≈3.3s ≈ 4.3s total, covering all coasts. Do NOT stitch fragments
// into long polylines first: long lines are super-linearly expensive to buffer
// in JSTS (the same data merged took ~38s). `binaryUnion` uses `safeUnion`, which
// swallows the occasional polygon-clipping ring error so one bad pair can't abort
// the whole region.
export function multiBufferLines(linesFC, radiusKm, _seeker) {
  const buffers = [];
  const bufferCoords = (coords) => {
    if (!coords || coords.length < 2) return;
    try { const b = turf.buffer(turf.lineString(coords), radiusKm, { units: 'kilometers' }); if (b) buffers.push(b); } catch {}
  };
  for (const f of linesFC.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'LineString') bufferCoords(g.coordinates);
    else if (g.type === 'MultiLineString') for (const c of g.coordinates) bufferCoords(c);
  }
  return binaryUnion(buffers);
}

// Categories 1 & 5 (points) — Voronoi catchment cell containing targetPoint.
export function voronoiCell(pointsFC, targetPoint, clipZone) {
  if (!pointsFC.features.length) return null;
  if (pointsFC.features.length === 1) return clipZone;
  const bb = turf.bbox(turf.buffer(clipZone, 30, { units: 'kilometers' }) || clipZone);
  let vor; try { vor = turf.voronoi(pointsFC, { bbox: bb }); } catch { return null; }
  let cell = null;
  turf.featureEach(vor, (f) => {
    if (f && turf.booleanPointInPolygon(turf.center(targetPoint), f)) cell = f;
  });
  if (!cell) return null;
  return safeIntersect(cell, clipZone);
}

// Category 1 (lines) — nearest line group + dissolved catchment.
export function nearestLineGroup(seekerPoint, linesFC) {
  let best = null, bestD = Infinity;
  turf.featureEach(linesFC, (f, i) => {
    if (f.geometry?.type !== 'LineString') return;
    let d; try { d = turf.pointToLineDistance(seekerPoint, f, { units: 'kilometers' }); } catch { return; }
    if (d < bestD) { bestD = d; best = f.properties?.name || `seg-${i}`; }
  });
  return { group: best, distanceKm: isFinite(bestD) ? bestD : null };
}

export function lineCatchment(linesFC, seekerPoint, clipZone, { maxSamples = 1400 } = {}) {
  const lines = linesFC.features.filter((f) => f.geometry?.type === 'LineString');
  if (!lines.length) return null;
  const keyed = lines.map((f, i) => ({ f, key: f.properties?.name || `seg-${i}` }));
  let total = 0;
  for (const { f } of keyed) { try { total += turf.length(f, { units: 'kilometers' }); } catch {} }
  if (total <= 0) return clipZone;
  const step = Math.max(total / maxSamples, 0.3);
  const bb = turf.bbox(turf.buffer(clipZone, 30, { units: 'kilometers' }) || clipZone);
  const bbPoly = turf.bboxPolygon(bb);

  const samples = [];
  for (const { f, key } of keyed) {
    let len; try { len = turf.length(f, { units: 'kilometers' }); } catch { continue; }
    if (len <= 0) continue;
    for (let d = 0; d <= len; d += step) {
      let p; try { p = turf.along(f, d, { units: 'kilometers' }); } catch { break; }
      if (!turf.booleanPointInPolygon(p, bbPoly)) continue;
      p.properties = { key };
      samples.push(p);
    }
  }
  if (samples.length < 2) return clipZone;
  const { group: seekerKey } = nearestLineGroup(seekerPoint, linesFC);
  const fc = turf.featureCollection(samples);
  let vor; try { vor = turf.voronoi(fc, { bbox: bb }); } catch { vor = null; }
  if (!vor) return null;
  const cells = vor.features;
  const mine = [];
  samples.forEach((s, i) => { if (s.properties.key === seekerKey && cells[i]) mine.push(cells[i]); });
  return safeIntersect(binaryUnion(mine), clipZone);
}

// Category 1 (areas / admin) — division polygon containing the seeker.
export function containingPolygon(areasFC, seekerPoint) {
  let found = null;
  turf.featureEach(areasFC, (f) => {
    if (found) return;
    try { if (turf.booleanPointInPolygon(seekerPoint, f)) found = f; } catch {}
  });
  return found;
}

// International borders / coastline from polygons → LineStrings (no Overpass).
// Used for "international border": the boundaries of the selected countries,
// including internal borders between two selected countries.
export function linesFromPolygons(features) {
  const out = [];
  const push = (geom, props) => {
    if (!geom) return;
    if (geom.type === 'LineString') out.push(turf.lineString(geom.coordinates, props));
    else if (geom.type === 'MultiLineString') geom.coordinates.forEach((c) => out.push(turf.lineString(c, props)));
  };
  for (const f of features) {
    if (!f?.geometry) continue;
    let ln; try { ln = turf.polygonToLine(f); } catch { continue; }
    if (ln.type === 'FeatureCollection') ln.features.forEach((x) => push(x.geometry, x.properties || {}));
    else push(ln.geometry, ln.properties || {});
  }
  return turf.featureCollection(out);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function nearest(fromPoint, pointsFC) {
  if (!pointsFC.features.length) return null;
  return turf.nearestPoint(fromPoint, pointsFC);
}
export function distanceKm(a, b) { return turf.distance(a, b, { units: 'kilometers' }); }
export function areaKm2(zone) { if (!zone) return 0; try { return turf.area(zone) / 1e6; } catch { return 0; } }
export function bboxOf(zone) { return turf.bbox(zone); }
export function maskPolygon(zone) {
  const world = turf.bboxPolygon(WORLD_BBOX);
  if (!zone) return world;
  return safeDifference(world, zone) || world;
}
export function pt(lng, lat) { return turf.point([lng, lat]); }
