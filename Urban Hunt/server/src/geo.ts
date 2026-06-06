import * as turf from "@turf/turf";
import type { Feature, Polygon } from "geojson";
import type { GameConfig, HiderState, LngLat, ProximityStatus, SeekerState } from "../../shared/types";

export type PolygonFeature = Feature<Polygon>;

export function circlePolygon(center: LngLat, radiusMeters: number, steps = 96): PolygonFeature {
  return turf.circle(center, radiusMeters / 1000, { units: "kilometers", steps }) as PolygonFeature;
}

export function pointFeature(coordinates: LngLat) {
  return turf.point(coordinates);
}

export function distanceMeters(a: LngLat, b: LngLat): number {
  return turf.distance(pointFeature(a), pointFeature(b), { units: "kilometers" }) * 1000;
}

export function midpointOfSeekers(seekers: SeekerState[], fallbackPolygon: PolygonFeature): LngLat {
  const coords = seekers.filter(s => s.coords).map(s => s.coords);
  if (!coords.length) return turf.center(fallbackPolygon).geometry.coordinates as LngLat;
  return turf.center(turf.featureCollection(coords.map(pointFeature))).geometry.coordinates as LngLat;
}

export function shrinkGlobalZone(
  globalSafeZone: PolygonFeature,
  seekers: SeekerState[],
  areaShrinkPercent: number
): PolygonFeature {
  const origin = midpointOfSeekers(seekers, globalSafeZone);
  const linearScale = Math.sqrt(Math.max(0.01, 1 - areaShrinkPercent / 100));
  return turf.transformScale(globalSafeZone, linearScale, { origin }) as PolygonFeature;
}

export function legalArea(globalSafeZone: PolygonFeature, lockdownCircle: PolygonFeature | null): PolygonFeature {
  if (!lockdownCircle) return globalSafeZone;
  const intersected = turf.intersect(turf.featureCollection([globalSafeZone, lockdownCircle])) as PolygonFeature | null;
  return intersected || globalSafeZone;
}

export function containsPoint(area: PolygonFeature, point: LngLat): boolean {
  return turf.booleanPointInPolygon(pointFeature(point), area);
}

export function containsPointWithBuffer(area: PolygonFeature, point: LngLat, bufferMeters: number): boolean {
  const buffered = turf.buffer(area, bufferMeters, { units: "meters" }) as PolygonFeature | undefined;
  return buffered ? containsPoint(buffered, point) : containsPoint(area, point);
}

export function proximityFor(hider: HiderState, seekers: SeekerState[], config: GameConfig): ProximityStatus {
  if (!seekers.length) return "Distant";
  const min = Math.min(...seekers.map(s => distanceMeters(hider.coords, s.coords)));
  if (min < config.proximityThresholds.near) return "Near";
  if (min < config.proximityThresholds.far) return "Far";
  return "Distant";
}

export function delayedCoordinate(history: HiderState["history"], delayMinutes: number): {
  coordinates: LngLat;
  timestamp: number;
} {
  const target = Date.now() - delayMinutes * 60 * 1000;
  return history.find(item => item.timestamp >= target) || history[0] || {
    coordinates: [0, 0],
    timestamp: Date.now()
  };
}

export function delayedTrail(history: HiderState["history"], delayMinutes: number, count = 5): LngLat[] {
  if (!history.length) return [];
  const target = Date.now() - delayMinutes * 60 * 1000;
  let revealedIndex = history.findIndex(item => item.timestamp >= target);
  if (revealedIndex < 0) revealedIndex = history.length - 1;
  const start = Math.max(0, revealedIndex - (count - 1));
  return history.slice(start, revealedIndex + 1).map(item => item.coordinates);
}

export function coordinateKey(coord: LngLat): string {
  return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
}

export function polygonCentroid(area: PolygonFeature): LngLat {
  return turf.centroid(area).geometry.coordinates as LngLat;
}
