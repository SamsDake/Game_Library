import { Database } from "../server/src/db";
import { osmElementToObjective, overpassQueryBlocks, type OverpassElement } from "../shared/poi-categories";
import type { Objective } from "../shared/types";

interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const COUNTRY_BBOX: Record<string, Bbox> = {
  uk: { south: 49.8, west: -8.7, north: 60.9, east: 1.9 },
  // Mainland (Iberian peninsula) Spain — islands intentionally excluded.
  es: { south: 35.9, west: -9.5, north: 43.8, east: 3.4 }
};

const TILE_DEGREES = Number(process.env.OVERPASS_TILE_DEGREES || 0.5);
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const DELAY_MS = Number(process.env.OVERPASS_DELAY_MS || 1200);
const MAX_BACKOFF_MS = 60_000;          // cap exponential backoff between retries
const REQUEST_TIMEOUT_MS = 90_000;      // client-side abort, above the server [timeout:60]

async function main() {
  const country = (arg("--country") || "uk").toLowerCase();
  const countryBbox = COUNTRY_BBOX[country];
  if (!countryBbox) {
    throw new Error(`Unsupported --country=${country}. Supported: ${Object.keys(COUNTRY_BBOX).join(", ")}.`);
  }
  const db = new Database(process.env.DATABASE_URL);
  if (!db.enabled) throw new Error("DATABASE_URL is required for POI seeding.");
  await db.migrate();

  let total = 0;
  for (let south = countryBbox.south; south < countryBbox.north; south += TILE_DEGREES) {
    for (let west = countryBbox.west; west < countryBbox.east; west += TILE_DEGREES) {
      const bbox = {
        south,
        west,
        north: Math.min(countryBbox.north, south + TILE_DEGREES),
        east: Math.min(countryBbox.east, west + TILE_DEGREES)
      };
      const pois = await fetchTile(bbox);
      const inserted = await db.upsertPois(pois);
      total += inserted;
      console.log(`seeded ${inserted} POIs from ${bbox.south},${bbox.west},${bbox.north},${bbox.east} (total ${total})`);
      await delay(DELAY_MS);
    }
  }
  await db.close();
  console.log(`${country.toUpperCase()} Overpass seed complete: ${total} POIs processed.`);
}

async function fetchTile(bbox: Bbox): Promise<Objective[]> {
  const bboxText = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query = `[out:json][timeout:60];(${overpassQueryBlocks(bboxText)});out center tags;`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // Overpass rejects requests without a descriptive User-Agent (HTTP 406).
          "user-agent": "UrbanHunt/0.2 (urban hunt game; POI seeding)"
        },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal
      }).finally(() => clearTimeout(abort));
      if (res.ok) {
        const json = await res.json() as { elements?: OverpassElement[] };
        return (json.elements || [])
          .map(element => osmElementToObjective(element, "postgis"))
          .filter((poi): poi is Objective => !!poi);
      }
      // 429 (rate-limited) and 504 (overloaded) carry a Retry-After hint we must honor to avoid a ban.
      const retryAfterMs = retryAfter(res.headers.get("retry-after"));
      const waitMs = Math.max(retryAfterMs, backoffMs(attempt));
      console.warn(`Overpass ${res.status} for ${bboxText}, attempt ${attempt}; waiting ${waitMs}ms`);
      await delay(waitMs);
    } catch (err) {
      // Network error or client-side timeout abort — back off and retry.
      const waitMs = backoffMs(attempt);
      console.warn(`Overpass request failed for ${bboxText}, attempt ${attempt} (${err instanceof Error ? err.message : err}); waiting ${waitMs}ms`);
      await delay(waitMs);
    }
  }
  return [];
}

// Exponential backoff with a cap, so repeated failures back off hard instead of hammering.
function backoffMs(attempt: number): number {
  return Math.min(DELAY_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

// Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into milliseconds; 0 if absent/invalid.
function retryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

function arg(name: string) {
  const found = process.argv.find(item => item.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : undefined;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
