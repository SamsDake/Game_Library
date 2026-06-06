import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { Database } from "../server/src/db";
import type { PoiCategory } from "../shared/types";

// One-off importer for the preload GeoJSON FeatureCollection files (one per category,
// each feature = { properties.name, geometry.Point coordinates[lon,lat] }). Loads them into
// the same `pois` table the game queries, so objectives come straight from this dataset.

const DEFAULT_DIR = "C:/Users/Samuel Chung/Desktop/Jetlag Mobile App/public/preload/parts";
const CATEGORIES: PoiCategory[] = ["cinema", "hospital", "library", "museum", "park", "station", "consulate", "golf"];
const CHUNK = 500;

interface Feature {
  properties?: { name?: string };
  geometry?: { type?: string; coordinates?: [number, number] };
}

function arg(name: string) {
  const found = process.argv.find(item => item.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : undefined;
}

function stableId(category: string, lon: number, lat: number, name: string) {
  return crypto.createHash("sha1").update(`${category}|${lon}|${lat}|${name}`).digest("hex").slice(0, 16);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  const dir = arg("--dir") || DEFAULT_DIR;

  // Ensure the schema exists, then use a dedicated pool for fast chunked inserts.
  await new Database(url).migrate();
  const pool = new pg.Pool({ connectionString: url });

  let grand = 0;
  for (const category of CATEGORIES) {
    const file = path.join(dir, `${category}__GB.json`);
    if (!fs.existsSync(file)) {
      console.warn(`skip ${category}: file not found (${file})`);
      continue;
    }
    const fc = JSON.parse(fs.readFileSync(file, "utf8")) as { features?: Feature[] };
    const rows: Array<[string, string, string, string, number, number]> = [];
    const seen = new Set<string>();
    for (const f of fc.features || []) {
      const name = (f.properties?.name || "").trim();
      const coords = f.geometry?.coordinates;
      if (f.geometry?.type !== "Point" || !coords || !name || name === "Unnamed") continue;
      const [lon, lat] = coords;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const osmId = stableId(category, lon, lat, name);
      if (seen.has(osmId)) continue; // de-dupe identical features within a file
      seen.add(osmId);
      rows.push(["preload", osmId, category, name, lon, lat]);
    }

    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      chunk.forEach((r, idx) => {
        const b = idx * 6;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},ST_SetSRID(ST_MakePoint($${b + 5},$${b + 6}),4326),now())`);
        params.push(...r);
      });
      await pool.query(
        `INSERT INTO pois(osm_type, osm_id, category, name, geom, source_updated_at)
         VALUES ${values.join(",")}
         ON CONFLICT(osm_type, osm_id)
         DO UPDATE SET category = excluded.category, name = excluded.name, geom = excluded.geom, source_updated_at = now()`,
        params
      );
      inserted += chunk.length;
    }
    grand += inserted;
    console.log(`${category}: ${inserted} POIs`);
  }

  const total = await pool.query("SELECT category, count(*)::int AS n FROM pois GROUP BY category ORDER BY category");
  console.log("--- pois table by category ---");
  for (const row of total.rows) console.log(`  ${row.category}: ${row.n}`);
  await pool.end();
  console.log(`Import complete: ${grand} features processed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
