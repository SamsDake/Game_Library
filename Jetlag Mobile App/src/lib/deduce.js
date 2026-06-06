// deduce.js — turn a hider-answered question into a map deduction automatically,
// using the GPS captured when the question was asked (instead of the seeker
// re-entering pin/feature/answer in the Deduce tab). Mirrors the manual
// DeductionConsole orchestration, reusing the same geometry.js + overpass.js
// primitives. Radar/Thermometer are pure geometry (also handled inline in the
// store on answer); the feature-based categories need async OSM lookups.

import {
  computeConstraint, bisectorHalfPlane, voronoiCell, multiBuffer, multiBufferLines,
  containingPolygon, lineCatchment, nearestLineGroup, linesFromPolygons, mainCluster,
  nearest, distanceKm, bboxOf, pt, parseKm, radarCircle,
} from './geometry.js';
import { fetchFeature, clipPointsToZone, pointsWithinRadius } from './overpass.js';
import { elevationConstraint } from './elevation.js';
import { countryId } from './useCountries.js';
import { CAT_BY_ID } from './data.js';

// Matching / Measuring option label → OSM feature layer (+ admin level).
export const OPTION_FEATURE = {
  'Commercial Airport': { feature: 'airport' },
  'Transit Line': { feature: 'station' },
  'Mountain (1 km elevation)': { feature: 'mountain' },
  'Park': { feature: 'park' },
  'Amusement / Theme Park': { feature: 'theme_park' },
  'Zoo': { feature: 'zoo' },
  'Aquarium': { feature: 'aquarium' },
  'Golf Course': { feature: 'golf' },
  'Museum': { feature: 'museum' },
  'Movie Theatre': { feature: 'cinema' },
  'Hospital': { feature: 'hospital' },
  'Library': { feature: 'library' },
  'Foreign Consulate': { feature: 'consulate' },
  '1st Administrative Division': { feature: 'admin', adminLevel: 4 },
  '2nd Administrative Division': { feature: 'admin', adminLevel: 6 },
  'International Border': { feature: 'border' },
  'Sea Level': { feature: 'sealevel' },
  'Coastline': { feature: 'coastline' },
  // 'Street / Path' has no data layer → not auto-resolvable.
};

// Tentacles option feature → OSM layer.
export const TENTACLE_FEATURE = {
  'Museums': 'museum', 'Libraries': 'library', 'Movie Theatres': 'cinema', 'Hospitals': 'hospital',
  'Metro Lines': 'station', 'Zoos': 'zoo', 'Aquariums': 'aquarium', 'Amusement Parks': 'theme_park',
};

const tentacleOpt = (q) => CAT_BY_ID.tentacles?.options?.[q.optIndex] || null;

// Seeker origin recorded at ask time: shared GPS, else the auto-captured fix.
export function deductionOrigin(q) {
  const o = q?.gps?.p1 || q?.askedLoc || q?.mapPin;
  return o ? { lat: o.lat, lng: o.lng } : null;
}

const SKIP_ANSWERS = new Set(['Vetoed', 'Photo sent', '']);

// Will this answered question produce a confirmed deduction at all?
export function isDeducible(q) {
  if (!q || !q.answer || SKIP_ANSWERS.has(q.answer.value)) return false;
  if (q.catId === 'radar') return true;
  if (q.catId === 'thermometer') return !!(q.gps?.p1 && q.gps?.p2);
  if (q.catId === 'matching' || q.catId === 'measuring') return !!OPTION_FEATURE[q.optStr];
  if (q.catId === 'tentacles') return !!TENTACLE_FEATURE[tentacleOpt(q)?.feature];
  return false;
}

// Tentacles now auto-resolves from the hider's exact pick (feature name) or
// "not within radius" answer. The seeker only picks by hand as a fallback when
// the answer can't be matched to a candidate (handled via status in ConfirmedList).
export function needsManualResolve() {
  return false;
}

// The exact answer string the hider submits when they're outside the seeker's
// tentacle radius. Both the hider button and resolveDeduction derive it from the
// same option so they always match.
export function tentacleOutsideLabel(q) {
  const opt = tentacleOpt(q);
  return `Not within ${opt?.radius || 'range'} of the seeker`;
}

// Fetch the candidate features within the seeker's radius (hider-side list).
export async function tentacleCandidates(q, ctx) {
  const opt = tentacleOpt(q);
  const feature = TENTACLE_FEATURE[opt?.feature];
  if (!feature) return { error: 'No data layer for this feature.' };
  const origin = deductionOrigin(q);
  if (!origin) return { error: 'No seeker location was captured for this question.' };
  const radiusKm = parseKm(opt.radius) || 2;
  const res = await getFeatureData(feature, undefined, ctx);
  const within = pointsWithinRadius(res.fc, origin, radiusKm * 1000);
  return { candidates: within, radiusKm, origin, feature: opt.feature };
}

// Nearest named candidate to the hider → its name (matchable by the seeker).
export function tentacleNearest(candidatesFC, hiderLoc) {
  const named = { type: 'FeatureCollection', features: (candidatesFC?.features || []).filter(f => f.properties?.name) };
  if (!named.features.length) return null;
  const n = nearest(pt(hiderLoc.lng, hiderLoc.lat), named);
  return n?.properties?.name || null;
}

// Compute the hider's truthful answer string from their GPS, using the same map
// data that builds the seeker's zone cut. Returns { value } or { error }.
const sameFeature = (a, b) => !!(a && b) &&
  JSON.stringify(a.geometry?.coordinates) === JSON.stringify(b.geometry?.coordinates);

export async function autoAnswer(q, hiderLoc, ctx) {
  if (!hiderLoc) return { error: 'Could not read your location.' };
  const hiderPt = pt(hiderLoc.lng, hiderLoc.lat);
  const zone = ctx.currentZone || ctx.baseZone;
  const origin = deductionOrigin(q);

  if (q.catId === 'radar') {
    if (!origin) return { error: 'No seeker location captured for this question.' };
    const km = parseKm(q.optStr);
    if (km == null) return { error: 'Could not read the radar distance.' };
    return { value: distanceKm(hiderPt, pt(origin.lng, origin.lat)) <= km ? 'Yes' : 'No' };
  }

  if (q.catId === 'thermometer') {
    if (!q.gps?.p1 || !q.gps?.p2) return { error: "Seeker hasn't shared their 2nd GPS yet." };
    const dNew = distanceKm(hiderPt, pt(q.gps.p2.lng, q.gps.p2.lat));
    const dOld = distanceKm(hiderPt, pt(q.gps.p1.lng, q.gps.p1.lat));
    return { value: dNew <= dOld ? 'Hotter' : 'Colder' };
  }

  if (!origin) return { error: 'No seeker location captured for this question.' };
  const originPt = pt(origin.lng, origin.lat);

  if (q.catId === 'matching' || q.catId === 'measuring') {
    const m = OPTION_FEATURE[q.optStr];
    if (!m) return { error: `“${q.optStr}” can't be auto-answered — please answer manually.` };
    const { feature, adminLevel } = m;
    if (feature === 'sealevel') return { error: "Sea level can't be auto-answered — please answer manually." };

    const res = await getFeatureData(feature, adminLevel, ctx);
    const fc = res.fc;
    if (!fc?.features?.length) return { error: 'No such features in the play area.' };

    if (q.catId === 'matching') {
      let same;
      if (res.geom === 'area') {
        const sPoly = containingPolygon(fc, originPt);
        if (!sPoly) return { error: 'Seeker is not inside any division at this level.' };
        same = sPoly === containingPolygon(fc, hiderPt);
      } else if (res.geom === 'line') {
        same = nearestLineGroup(originPt, fc).group === nearestLineGroup(hiderPt, fc).group;
      } else {
        const clip = clipPointsToZone(fc, zone);
        if (!clip.features.length) return { error: 'No such features in the play area.' };
        same = sameFeature(nearest(originPt, clip), nearest(hiderPt, clip));
      }
      return { value: same ? 'Yes' : 'No' };
    }

    // measuring (closer / further)
    let dSeeker, dHider;
    if (res.geom === 'line') {
      dSeeker = nearestLineGroup(originPt, fc).distanceKm;
      dHider = nearestLineGroup(hiderPt, fc).distanceKm;
      if (dSeeker == null || dHider == null) return { error: 'Could not measure distance to a line.' };
    } else {
      const clip = clipPointsToZone(fc, zone);
      if (!clip.features.length) return { error: 'No such features in the play area.' };
      dSeeker = distanceKm(originPt, nearest(originPt, clip));
      dHider = distanceKm(hiderPt, nearest(hiderPt, clip));
    }
    return { value: dHider <= dSeeker ? 'Closer' : 'Further' };
  }

  return { error: "This question type can't be auto-answered." };
}

// Fetch the feature collection for a layer, mirroring DeductionConsole.getData.
async function getFeatureData(feature, adminLevel, ctx) {
  if (feature === 'border') {
    const feats = (ctx.countries || [])
      .filter((f) => (ctx.selectedIds || []).includes(countryId(f)))
      .map((f) => mainCluster(f));
    return { geom: 'line', fc: linesFromPolygons(feats) };
  }
  return fetchFeature(feature, bboxOf(ctx.baseZone || ctx.currentZone), { adminLevel: adminLevel || 6 });
}

// Resolve an answered question into { geometry, mode, kind, label } (a confirmed
// cut), or { needsPick, candidates, ... } (Tentacles), or { error }.
export async function resolveDeduction(q, ctx) {
  const val = (q.answer?.value || '');
  const zone = ctx.currentZone || ctx.baseZone;
  const origin = deductionOrigin(q);

  if (q.catId === 'radar') {
    const c = computeConstraint('radar', val, q.optStr, origin, null);
    return c?.polygon
      ? { geometry: c.polygon, mode: c.mode, kind: 'radar', label: `Radar ${q.optStr}: ${val}` }
      : { error: 'No GPS captured for this radar question.' };
  }

  if (q.catId === 'thermometer') {
    if (!q.gps?.p1 || !q.gps?.p2) return { error: 'Needs both GPS points (before & after travel).' };
    const keep = val.toLowerCase() === 'hotter' ? 'hotter' : 'colder';
    const poly = bisectorHalfPlane(q.gps.p1, q.gps.p2, keep);
    return poly
      ? { geometry: poly, mode: 'intersect', kind: 'thermometer', label: `Thermometer: ${val}` }
      : { error: 'Could not build the bisector.' };
  }

  if (!origin) return { error: 'No GPS captured for this question.' };
  const originPt = pt(origin.lng, origin.lat);

  if (q.catId === 'matching' || q.catId === 'measuring') {
    const m = OPTION_FEATURE[q.optStr];
    if (!m) return { error: `No data layer for "${q.optStr}".` };
    const { feature, adminLevel } = m;

    if (feature === 'sealevel') { // measuring only — coarse elevation grid
      const closer = val.toLowerCase() === 'closer';
      const geom = await elevationConstraint(zone, origin, closer);
      return geom
        ? { geometry: geom, mode: 'intersect', kind: 'relative', label: `Sea level: ${val}` }
        : { error: 'Elevation data unavailable.' };
    }

    const res = await getFeatureData(feature, adminLevel, ctx);
    const fc = res.fc;
    if (!fc?.features?.length) return { error: 'No such features in the zone.' };

    if (q.catId === 'matching') {
      const same = val.toLowerCase() === 'yes';
      let constraint;
      if (res.geom === 'area') {
        constraint = containingPolygon(fc, originPt);
        if (!constraint) return { error: 'Seeker is not inside any division at this level.' };
      } else if (res.geom === 'line') {
        constraint = lineCatchment(fc, originPt, zone);
      } else {
        const clip = clipPointsToZone(fc, zone);
        if (!clip.features.length) return { error: 'No such features in the zone.' };
        constraint = voronoiCell(clip, nearest(originPt, clip), zone);
      }
      if (!constraint) return { error: 'Could not build a catchment area.' };
      return { geometry: constraint, mode: same ? 'intersect' : 'difference', kind: 'nearest', label: `Matching ${q.optStr}: ${val}` };
    }

    // measuring (closer / further)
    const closer = val.toLowerCase() === 'closer';
    let buffers, ds;
    if (res.geom === 'line') {
      ds = nearestLineGroup(originPt, fc).distanceKm;
      if (ds == null) return { error: 'Could not measure distance to a line.' };
      buffers = multiBufferLines(fc, ds);
    } else {
      const clip = clipPointsToZone(fc, zone);
      if (!clip.features.length) return { error: 'No such features in the zone.' };
      const near = nearest(originPt, clip);
      ds = distanceKm(originPt, near);
      buffers = multiBuffer(clip, ds, origin);
    }
    if (!buffers) return { error: 'Could not build buffer zones.' };
    return { geometry: buffers, mode: closer ? 'intersect' : 'difference', kind: 'relative', label: `Measuring ${q.optStr}: ${val}` };
  }

  if (q.catId === 'tentacles') {
    const opt = tentacleOpt(q);
    const feature = TENTACLE_FEATURE[opt?.feature];
    if (!feature) return { error: 'No data layer for this feature.' };
    const radiusKm = parseKm(opt.radius) || 2;
    const baseLabel = `Tentacles ${opt.feature}`;
    // Hider was outside the seeker's radius → erase that circle from the zone.
    if (val === tentacleOutsideLabel(q)) {
      return { geometry: radarCircle(origin, radiusKm), mode: 'difference', kind: 'target', label: `${baseLabel}: not within ${opt.radius}` };
    }
    const res = await getFeatureData(feature, undefined, ctx);
    const within = pointsWithinRadius(res.fc, origin, radiusKm * 1000);
    if (!within.features.length) return { error: `No ${opt.feature.toLowerCase()} within ${opt.radius} of where you asked.` };
    // Hider tapped an exact place → auto-build its catchment cell.
    const match = within.features.find(f => f.properties?.name === val);
    if (match) return tentacleCut(match, within, zone, baseLabel) || { error: 'Could not build the catchment cell.' };
    // Legacy free-text / unmatched → seeker picks by hand.
    return { needsPick: true, candidates: within, label: baseLabel, hint: val };
  }

  return { error: 'This question type does not produce a map region.' };
}

// Build the cut for a Tentacles pick (the seeker tapped the place the hider named).
export function tentacleCut(chosenFeature, candidatesFC, zone, label) {
  const cell = voronoiCell(candidatesFC, chosenFeature, zone);
  if (!cell) return null;
  return { geometry: cell, mode: 'intersect', kind: 'target', label: `${label} → ${chosenFeature.properties?.name || 'picked'}` };
}
