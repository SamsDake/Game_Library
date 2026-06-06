// geometry.js — Turf-based GIS operations for the seeker map (Turf v6 API)
import * as turf from '@turf/turf';

// World bounding box as a polygon (for mask computation)
const WORLD_BBOX = [-180, -85, 180, 85];

// Turf v7 boolean ops take a single FeatureCollection (NOT two args like v6).
export function safeIntersect(a, b) {
  if (!a || !b) return null;
  try { return turf.intersect(turf.featureCollection([a, b])); } catch { return null; }
}
export function safeDifference(a, b) {
  if (!a) return null;
  if (!b) return a;
  try { return turf.difference(turf.featureCollection([a, b])); } catch { return a; }
}
export function safeUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  try { return turf.union(turf.featureCollection([a, b])) || a; } catch { return a; }
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
  if (!features || features.length === 0) return null;
  let result = features[0];
  for (let i = 1; i < features.length; i++) {
    const u = safeUnion(result, features[i]);
    if (u) result = u;
  }
  return result;
}

// The world rectangle minus the zone — for the dark overlay mask
export function maskPolygon(zone) {
  if (!zone) return turf.bboxPolygon(WORLD_BBOX);
  const world = turf.bboxPolygon(WORLD_BBOX);
  return safeDifference(world, zone) || world;
}

// Apply a single cut to the zone:
// mode='intersect' → keep only the part inside the polygon
// mode='difference' → subtract the polygon from the zone
export function applyClue(zone, cluePolygon, mode) {
  if (!zone || !cluePolygon) return zone;
  if (mode === 'intersect') return safeIntersect(zone, cluePolygon) || zone;
  if (mode === 'difference') { const d = safeDifference(zone, cluePolygon); return d !== undefined ? d : zone; }
  return zone;
}

// Radar: circle of radiusKm around center { lat, lng }
export function radarCircle(center, radiusKm) {
  return turf.circle([center.lng, center.lat], radiusKm, { steps: 64, units: 'kilometers' });
}

// Parse a distance string like "500 m", "1 km", "40 km" → km
export function parseKm(str) {
  if (!str) return null;
  const m = String(str).match(/([\d.]+)\s*(km|m)?/i);
  if (!m) return null;
  let v = parseFloat(m[1]); if (isNaN(v)) return null;
  if ((m[2] || 'km').toLowerCase() === 'm') v /= 1000;
  return v;
}

const clampLat = (lat) => Math.max(-89, Math.min(89, lat));
const clampLng = (lng) => Math.max(-179.9, Math.min(179.9, lng));

// Thermometer: perpendicular-bisector half-plane. Built in a local planar frame
// (longitude scaled by cos(lat)) so the dividing edge passes EXACTLY through the
// midpoint of p1→p2 and is perpendicular to it. The earlier version built a huge
// rectangle and clamped its corners to the world bbox, which bowed the edge off
// the midpoint — that is what broke the bisection.
// p1 = start pos {lat,lng}, p2 = end pos {lat,lng}.
// keep = 'hotter' → p2 side (closer to the new position), 'colder' → p1 side.
export function bisectorHalfPlane(p1, p2, keep) {
  if (!p1 || !p2) return null;
  const mid = { lng: (p1.lng + p2.lng) / 2, lat: (p1.lat + p2.lat) / 2 };
  const kx = Math.cos((mid.lat * Math.PI) / 180) || 1e-6; // lng → local-metric scale

  // Unit vector p1→p2 in scaled space (points toward the "hotter" side).
  let ux = (p2.lng - p1.lng) * kx;
  let uy = p2.lat - p1.lat;
  const len = Math.hypot(ux, uy) || 1e-9;
  ux /= len; uy /= len;
  if (keep === 'colder') { ux = -ux; uy = -uy; } // extend toward the kept side
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

// Compute the constraint polygon for a question answer.
// Returns { polygon, mode } or null if no map geometry applies.
export function computeConstraint(catId, answerValue, optStr, seekerPin, mapPoints) {
  const v = (answerValue || '').toLowerCase();

  if (catId === 'radar') {
    if (!seekerPin) return null;
    const km = parseKm(optStr);
    if (!km) return null;
    const circle = radarCircle(seekerPin, km);
    return { polygon: circle, mode: v === 'yes' ? 'intersect' : 'difference' };
  }

  if (catId === 'thermometer') {
    const p1 = mapPoints?.p1;
    const p2 = mapPoints?.p2;
    if (!p1 || !p2) return null;
    const keep = v === 'hotter' ? 'hotter' : 'colder';
    const plane = bisectorHalfPlane(p1, p2, keep);
    if (!plane) return null;
    return { polygon: plane, mode: 'intersect' };
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Deduction-console helpers (ported from jetlag-deduction-board geometry.js).
// Every feature question produces a constraint polygon the store folds in.
// ───────────────────────────────────────────────────────────────────────────

// Reduce a country MultiPolygon to its main landmass cluster, dropping far-flung
// overseas territories that otherwise blow the bbox across an ocean and break
// bisector math / Overpass queries. Keeps the largest polygon plus any within
// `maxKm` of it (so archipelagos like the UK/Japan stay intact).
export function mainCluster(feature, maxKm = 2500) {
  const g = feature?.geometry;
  if (!g || g.type !== 'MultiPolygon' || g.coordinates.length <= 1) return feature;

  const withArea = g.coordinates.map((coords) => {
    const p = turf.polygon(coords);
    let ar = 0; try { ar = turf.area(p); } catch { /* keep area at 0 if Turf fails */ }
    return { p, ar };
  });
  withArea.sort((a, b) => b.ar - a.ar);
  const anchor = withArea[0].p;
  const anchorArea = withArea[0].ar || 1;
  const ac = turf.centroid(anchor);

  const kept = withArea
    .filter(({ p, ar }, i) => {
      if (i === 0) return true;
      const limit = ar >= anchorArea * 0.15 ? maxKm * 1.6 : maxKm;
      try { return turf.distance(ac, turf.centroid(p), { units: 'kilometers' }) <= limit; }
      catch { return false; }
    })
    .map((x) => x.p);

  const merged = binaryUnion(kept) || anchor;
  merged.properties = feature.properties;
  return merged;
}

// Geodesic circle of radiusMeters around center { lat, lng }.
export function circle(center, radiusMeters) {
  return turf.circle([center.lng, center.lat], radiusMeters / 1000, {
    steps: 128, units: 'kilometers',
  });
}

// Category 2 (points) — buffer EVERY instance by Ds and union into one region.
export function multiBuffer(pointsFC, radiusKm) {
  const buffers = [];
  for (const p of pointsFC.features) {
    if (!p.geometry?.coordinates) continue;
    const b = turf.buffer(p, radiusKm, { units: 'kilometers' });
    if (b) buffers.push(b);
  }
  return binaryUnion(buffers);
}

// Category 2 (lines) — buffer EVERY line fragment by Ds and union into one region.
export function multiBufferLines(linesFC, radiusKm) {
  const buffers = [];
  const bufferCoords = (coords) => {
    if (!coords || coords.length < 2) return;
    try { const b = turf.buffer(turf.lineString(coords), radiusKm, { units: 'kilometers' }); if (b) buffers.push(b); } catch { /* skip invalid line fragment */ }
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

// Category 1 (lines) — nearest line group + its distance.
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
  for (const { f } of keyed) { try { total += turf.length(f, { units: 'kilometers' }); } catch { /* skip invalid line length */ } }
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
    try { if (turf.booleanPointInPolygon(seekerPoint, f)) found = f; } catch { /* skip invalid area */ }
  });
  return found;
}

// International borders from polygons → LineStrings (no Overpass).
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

// Helpers
export function nearest(fromPoint, pointsFC) {
  if (!pointsFC.features.length) return null;
  return turf.nearestPoint(fromPoint, pointsFC);
}
export function distanceKm(a, b) { return turf.distance(a, b, { units: 'kilometers' }); }
export function areaKm2(zone) { if (!zone) return 0; try { return turf.area(zone) / 1e6; } catch { return 0; } }
export function bboxOf(zone) { return turf.bbox(zone); }
export function pt(lng, lat) { return turf.point([lng, lat]); }
