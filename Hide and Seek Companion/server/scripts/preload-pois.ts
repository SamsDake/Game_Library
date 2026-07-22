import fs from "node:fs";
import path from "node:path";
import { OVERPASS_CATEGORIES, osmElementToObjective, overpassCategoryAreaQuery, type OverpassElement } from "../../shared/poi-categories";
import type { Objective, PoiCategory } from "../../shared/types";
import { findRegion, REGIONS } from "../src/regions";

const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const MIN_FETCH_GAP_MS = 1100;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 8000;
const CACHE_ROOT = path.resolve(process.cwd(), "server/data/poi-cache");

async function main() {
  const regionId = process.argv[2];
  if (!regionId) {
    console.error("usage: preload-pois <region-id>  (e.g. united-kingdom)");
    process.exit(1);
  }
  const region = findRegion(regionId);
  if (!region) {
    console.error(`unknown region "${regionId}". Known regions: ${REGIONS.map(r => r.id).join(", ")}`);
    process.exit(1);
  }

  const outDir = path.join(CACHE_ROOT, region.id);
  fs.mkdirSync(outDir, { recursive: true });

  const start = Date.now();
  console.log(`[preload-pois] fetching ${OVERPASS_CATEGORIES.length} categories for ${region.label}...`);

  const failed: string[] = [];
  let fetchedAny = false;
  for (const cat of OVERPASS_CATEGORIES) {
    const outFile = path.join(outDir, `${cat.category}.json`);
    if (fs.existsSync(outFile)) {
      console.log(`[preload-pois] ${cat.category}: already cached, skipping`);
      continue;
    }
    if (fetchedAny) await sleep(MIN_FETCH_GAP_MS);
    fetchedAny = true;
    const objectives = await fetchCategoryWithRetries(region.overpassAreaQuery, cat.category);
    if (!objectives) {
      failed.push(cat.category);
      continue;
    }
    fs.writeFileSync(outFile, JSON.stringify(objectives));
    console.log(`[preload-pois] ${cat.category}: ${objectives.length} POIs -> ${outFile}`);
  }

  console.log(`[preload-pois] done in ${Math.round((Date.now() - start) / 1000)}s`);
  if (failed.length) {
    console.error(`[preload-pois] failed categories (re-run this script to retry just these): ${failed.join(", ")}`);
    process.exit(1);
  }
}

// Retries on failure (Overpass's public instance rate-limits with 429 under load); returns null
// (rather than throwing) once retries are exhausted, so one bad category doesn't lose the
// categories that already succeeded and were written to disk.
async function fetchCategoryWithRetries(areaFilter: string, category: PoiCategory): Promise<Objective[] | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fetchCategory(areaFilter, category);
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.warn(`[preload-pois] ${category} failed after ${MAX_RETRIES + 1} attempts:`, err instanceof Error ? err.message : err);
        return null;
      }
      console.warn(`[preload-pois] ${category} failed, retrying in ${RETRY_BACKOFF_MS / 1000}s:`, err instanceof Error ? err.message : err);
      await sleep(RETRY_BACKOFF_MS);
    }
  }
  return null;
}

async function fetchCategory(areaFilter: string, category: PoiCategory): Promise<Objective[]> {
  const query = `[out:json][timeout:180];\narea${areaFilter}->.a;\n(\n${overpassCategoryAreaQuery(category)}\n);\nout center tags;`;
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "HideAndSeekCompanion/0.1 (preload script; hide-and-seek companion game)"
    },
    body: new URLSearchParams({ data: query })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for category ${category}`);
  const json = await res.json() as { elements?: OverpassElement[]; remark?: string };
  // Overpass returns HTTP 200 with a `remark` (e.g. a query timeout) instead of an error status,
  // which would otherwise be cached as a silent, permanent 0-result for the category.
  if (json.remark) throw new Error(`Overpass remark for category ${category}: ${json.remark}`);
  return (json.elements || [])
    .map(osmElementToObjective)
    .filter((o): o is Objective => !!o);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

void main();
