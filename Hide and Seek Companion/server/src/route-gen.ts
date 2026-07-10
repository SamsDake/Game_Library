import type { GameConfig, LngLat, Objective } from "../../shared/types";
import { distanceMeters } from "./geo";
import { objectivesNear } from "./poi-index";

export type RouteGenResult = { route: Objective[] } | { error: "not_enough_objectives" | "route_generation_failed" };

// Backtracking depth-first search: at each step try the in-band candidates in random order
// (preferred category first), and on a dead end back up and try a different branch — so a
// full-length route respecting [minDistanceM, maxDistanceM] between consecutive objectives
// is found whenever one exists. All-or-nothing: an unsatisfiable config fails rather than
// returning a route that breaks the spacing limits or comes up short.
export function generateRoute(config: GameConfig, excludeIds?: Set<string>): RouteGenResult {
  const center: LngLat = [config.centerLng, config.centerLat];
  const pool = excludeIds
    ? objectivesNear(center, config.radiusM, config.categories).filter(o => !excludeIds.has(o.id))
    : objectivesNear(center, config.radiusM, config.categories);
  if (pool.length < config.objectiveCount) return { error: "not_enough_objectives" };

  const route: Objective[] = [];
  const used = new Set<string>();
  // Bounds total candidate attempts so a near-unsatisfiable config fails in milliseconds
  // instead of exploring the whole search tree.
  let budget = 20000;

  const dfs = (anchor: LngLat, step: number): boolean => {
    if (step === config.objectiveCount) return true;
    const candidates = pool.filter(o => {
      if (used.has(o.id)) return false;
      const d = distanceMeters(anchor, o.coordinates);
      return d >= config.minDistanceM && d <= config.maxDistanceM;
    });
    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    // Stable sort keeps the shuffled order within each group, preferred category first.
    const preferred = config.categories[step % config.categories.length];
    candidates.sort((a, b) => Number(b.category === preferred) - Number(a.category === preferred));
    for (const candidate of candidates) {
      if (budget <= 0) return false;
      budget -= 1;
      route.push(candidate);
      used.add(candidate.id);
      if (dfs(candidate.coordinates, step + 1)) return true;
      route.pop();
      used.delete(candidate.id);
    }
    return false;
  };

  if (!dfs(center, 0)) return { error: "route_generation_failed" };
  return { route };
}
