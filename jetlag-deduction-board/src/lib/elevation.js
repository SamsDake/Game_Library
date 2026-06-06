// elevation.js
// "Sea level" relative-distance support. There is no vector feature for
// elevation, so this samples a coarse grid of ground elevations across the zone
// and builds an approximate region where the hider would be CLOSER (or FURTHER)
// from sea level than the seeker — i.e. |elevation| < |seekerElevation|.
//
// Uses Open-Meteo's elevation API: keyless, CORS-enabled (works from the
// browser), batches up to 100 coordinates per request. This replaces an earlier
// endpoint that was unreliable from the browser. Still approximate (coarse grid)
// and best-effort — callers handle failures gracefully.

import * as turf from '@turf/turf';
import { binaryUnion, safeIntersect } from './geometry';

const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';

async function lookup(latlngs) {
  const out = [];
  for (let i = 0; i < latlngs.length; i += 100) {
    const batch = latlngs.slice(i, i + 100);
    const lat = batch.map((b) => b[0].toFixed(4)).join(',');
    const lon = batch.map((b) => b[1].toFixed(4)).join(',');
    const res = await fetch(`${ENDPOINT}?latitude=${lat}&longitude=${lon}`);
    if (!res.ok) throw new Error(`elevation API ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.elevation)) throw new Error('elevation API returned no data');
    out.push(...j.elevation);
  }
  return out;
}

// Returns the valid-region polygon (already filtered) or null.
export async function elevationConstraint(zone, seeker, closer, { grid = 11 } = {}) {
  const [w, s, e, n] = turf.bbox(zone);
  const dx = (e - w) / grid, dy = (n - s) / grid;

  const cells = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const lng = w + (i + 0.5) * dx, lat = s + (j + 0.5) * dy;
      if (!turf.booleanPointInPolygon(turf.point([lng, lat]), zone)) continue;
      cells.push({ lat, lng, poly: turf.bboxPolygon([w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy]) });
    }
  }
  if (!cells.length) return null;

  const elevs = await lookup([[seeker.lat, seeker.lng], ...cells.map((c) => [c.lat, c.lng])]);
  const seekerElev = elevs[0];
  if (typeof seekerElev !== 'number') throw new Error('no seeker elevation');
  const threshold = Math.abs(seekerElev);

  const keep = [];
  cells.forEach((c, k) => {
    const el = elevs[k + 1];
    if (typeof el !== 'number') return;
    const ok = closer ? Math.abs(el) <= threshold : Math.abs(el) > threshold;
    if (ok) keep.push(c.poly);
  });
  if (!keep.length) return null;
  return safeIntersect(binaryUnion(keep), zone);
}
