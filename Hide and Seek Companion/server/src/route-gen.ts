import type { GameConfig, LngLat, Objective, PoiCategory } from "../../shared/types";
import { destPoint, distanceMeters } from "./geo";
import { objectivesNear } from "./poi-index";

export type RouteGenResult = { route: Objective[] } | { error: "not_enough_objectives" | "route_generation_failed" };

export function generateRoute(config: GameConfig, excludeIds?: Set<string>): RouteGenResult {
  const center: LngLat = [config.centerLng, config.centerLat];
  const pool = excludeIds
    ? objectivesNear(center, config.radiusM, config.categories).filter(o => !excludeIds.has(o.id))
    : objectivesNear(center, config.radiusM, config.categories);
  if (pool.length < config.objectiveCount) return { error: "not_enough_objectives" };

  const remaining = [...pool];
  const route: Objective[] = [];
  let angle = Math.random() * 360;
  let anchor: LngLat = center;
  const categories = config.categories;

  for (let step = 0; step < config.objectiveCount; step += 1) {
    if (!remaining.length) break;
    // Step from the last placed objective (not the game center), so the configured
    // min/max distance actually governs the gap between consecutive objectives.
    const stepDistance = config.minDistanceM + Math.random() * (config.maxDistanceM - config.minDistanceM);
    angle += (Math.random() * 120) - 60;
    const target = destPoint(anchor, angle, stepDistance);

    const preferredCategory = categories[step % categories.length];
    const pick = nearestUnused(remaining, target, preferredCategory)
      ?? nearestUnused(remaining, target, null);
    if (!pick) break;

    route.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
    anchor = pick.coordinates;
  }

  if (route.length < Math.min(3, config.objectiveCount)) return { error: "route_generation_failed" };
  return { route };
}

// Nearest candidate to `target`, optionally restricted to `category` (null = any category).
function nearestUnused(pool: Objective[], target: LngLat, category: PoiCategory | null): Objective | null {
  const candidates = category ? pool.filter(o => o.category === category) : pool;
  if (!candidates.length) return null;
  let best = candidates[0];
  let bestDist = distanceMeters(target, best.coordinates);
  for (let i = 1; i < candidates.length; i += 1) {
    const d = distanceMeters(target, candidates[i].coordinates);
    if (d < bestDist) {
      best = candidates[i];
      bestDist = d;
    }
  }
  return best;
}
