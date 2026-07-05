import type { LngLat } from "../../shared/types";

const EARTH_RADIUS_M = 6371000;

export function distanceMeters(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const p1 = a[1] * toRad;
  const p2 = b[1] * toRad;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Destination point `distM` meters from `origin` along `bearingDeg` (0 = north), haversine formula.
export function destPoint(origin: LngLat, bearingDeg: number, distM: number): LngLat {
  const [lng, lat] = origin;
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lng1 = lng * Math.PI / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distM / EARTH_RADIUS_M) +
    Math.cos(lat1) * Math.sin(distM / EARTH_RADIUS_M) * Math.cos(brng)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(distM / EARTH_RADIUS_M) * Math.cos(lat1),
    Math.cos(distM / EARTH_RADIUS_M) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [lng2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}
