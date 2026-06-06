import { Database } from "../server/src/db";
import { osmElementToObjective, overpassQueryBlocks, type OverpassElement } from "../shared/poi-categories";
import type { Objective } from "../shared/types";

const UK_BBOX = {
  south: 49.8,
  west: -8.7,
  north: 60.9,
  east: 1.9
};

const TILE_DEGREES = Number(process.env.OVERPASS_TILE_DEGREES || 0.5);
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const DELAY_MS = Number(process.env.OVERPASS_DELAY_MS || 1200);

async function main() {
  const country = arg("--country") || "uk";
  if (country.toLowerCase() !== "uk") throw new Error("Only --country=uk is currently supported.");
  const db = new Database(process.env.DATABASE_URL);
  if (!db.enabled) throw new Error("DATABASE_URL is required for POI seeding.");
  await db.migrate();

  let total = 0;
  for (let south = UK_BBOX.south; south < UK_BBOX.north; south += TILE_DEGREES) {
    for (let west = UK_BBOX.west; west < UK_BBOX.east; west += TILE_DEGREES) {
      const bbox = {
        south,
        west,
        north: Math.min(UK_BBOX.north, south + TILE_DEGREES),
        east: Math.min(UK_BBOX.east, west + TILE_DEGREES)
      };
      const pois = await fetchTile(bbox);
      const inserted = await db.upsertPois(pois);
      total += inserted;
      console.log(`seeded ${inserted} POIs from ${bbox.south},${bbox.west},${bbox.north},${bbox.east} (total ${total})`);
      await delay(DELAY_MS);
    }
  }
  await db.close();
  console.log(`UK Overpass seed complete: ${total} POIs processed.`);
}

async function fetchTile(bbox: typeof UK_BBOX): Promise<Objective[]> {
  const bboxText = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query = `[out:json][timeout:60];(${overpassQueryBlocks(bboxText)});out center tags;`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Overpass rejects requests without a descriptive User-Agent (HTTP 406).
        "user-agent": "UrbanHunt/0.2 (urban hunt game; POI seeding)"
      },
      body: new URLSearchParams({ data: query })
    });
    if (res.ok) {
      const json = await res.json() as { elements?: OverpassElement[] };
      return (json.elements || [])
        .map(element => osmElementToObjective(element, "postgis"))
        .filter((poi): poi is Objective => !!poi);
    }
    console.warn(`Overpass ${res.status} for ${bboxText}, attempt ${attempt}`);
    await delay(DELAY_MS * attempt);
  }
  return [];
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
