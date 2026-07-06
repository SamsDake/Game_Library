import fs from "node:fs";
import path from "node:path";
import type { LngLat, Objective, PoiCategory } from "../../shared/types";
import { REGIONS } from "./regions";
import { distanceMeters } from "./geo";

const CACHE_ROOT = path.resolve(process.cwd(), "server/data/poi-cache");

let index: Objective[] = [];
let loadedRegionIds: string[] = [];

// Reads every preloaded region's category JSON files into memory. Never calls Overpass itself —
// that only happens in the offline `preload-pois` script. Call once at server boot.
export function loadRegions(): void {
  const all: Objective[] = [];
  const loaded: string[] = [];
  for (const region of REGIONS) {
    const dir = path.join(CACHE_ROOT, region.id);
    if (!fs.existsSync(dir)) continue;
    let regionCount = 0;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const objectives = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Objective[];
        for (const objective of objectives) all.push(objective);
        regionCount += objectives.length;
      } catch (err) {
        console.warn(`[poi-index] could not read ${path.join(dir, file)}`, err instanceof Error ? err.message : err);
      }
    }
    if (regionCount > 0) loaded.push(region.id);
  }
  index = all;
  loadedRegionIds = loaded;
  if (!loaded.length) {
    console.warn("[poi-index] no preloaded POI data found; run `npm run preload:pois -- united-kingdom` first.");
  } else {
    console.log(`[poi-index] loaded ${index.length} POIs for region(s): ${loaded.join(", ")}`);
  }
}

export function loadedRegions(): string[] {
  return loadedRegionIds;
}

export function objectivesNear(center: LngLat, radiusM: number, categories: PoiCategory[]): Objective[] {
  return index.filter(o => categories.includes(o.category) && distanceMeters(center, o.coordinates) <= radiusM);
}

export function estimateAvailable(center: LngLat, radiusM: number, categories: PoiCategory[]): number {
  return objectivesNear(center, radiusM, categories).length;
}
