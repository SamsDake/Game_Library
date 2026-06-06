import pg from "pg";
import type { Feature, Polygon } from "geojson";
import type { ClaimRecord, Objective, PoiCategory } from "../../shared/types";
import { FALLBACK_OBJECTIVES } from "./defaults";
import { containsPoint } from "./geo";

const { Pool } = pg;

export class Database {
  private pool: pg.Pool | null = null;

  constructor(url?: string) {
    if (url) {
      this.pool = new Pool({ connectionString: url });
    }
  }

  get enabled() {
    return !!this.pool;
  }

  async close() {
    await this.pool?.end();
  }

  async migrate() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE EXTENSION IF NOT EXISTS postgis;

      CREATE TABLE IF NOT EXISTS pois (
        id BIGSERIAL PRIMARY KEY,
        osm_type TEXT NOT NULL,
        osm_id TEXT NOT NULL,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        geom geometry(Point, 4326) NOT NULL,
        source_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(osm_type, osm_id)
      );
      CREATE INDEX IF NOT EXISTS pois_geom_gix ON pois USING GIST (geom);
      CREATE INDEX IF NOT EXISTS pois_category_idx ON pois(category);

      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        hider_id TEXT NOT NULL,
        hider_name TEXT NOT NULL,
        objective JSONB NOT NULL,
        objective_kind TEXT NOT NULL DEFAULT 'regular',
        distance_meters DOUBLE PRECISION NOT NULL,
        photo_url TEXT NOT NULL,
        status TEXT NOT NULL,
        score_value INTEGER NOT NULL DEFAULT 1,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        disallowed_at TIMESTAMPTZ
      );
      ALTER TABLE claims ADD COLUMN IF NOT EXISTS objective_kind TEXT NOT NULL DEFAULT 'regular';
      ALTER TABLE claims ADD COLUMN IF NOT EXISTS score_value INTEGER NOT NULL DEFAULT 1;
    `);
  }

  async upsertPois(pois: Objective[]) {
    if (!this.pool) return 0;
    let count = 0;
    for (const poi of pois) {
      await this.pool.query(
        `INSERT INTO pois(osm_type, osm_id, category, name, geom, source_updated_at)
         VALUES($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), now())
         ON CONFLICT(osm_type, osm_id)
         DO UPDATE SET category = excluded.category, name = excluded.name, geom = excluded.geom, source_updated_at = now()`,
        [poi.osmType || "fallback", poi.osmId || poi.id, poi.category, poi.name, poi.coordinates[0], poi.coordinates[1]]
      );
      count += 1;
    }
    return count;
  }

  async findObjectiveInside(area: Feature<Polygon>, categories?: PoiCategory[], offset = 0): Promise<Objective | null> {
    if (this.pool) {
      const categorySql = categories?.length ? "AND category = ANY($2)" : "";
      const params: unknown[] = [JSON.stringify(area.geometry)];
      if (categories?.length) params.push(categories);
      params.push(offset);
      const offsetIndex = params.length;
      const result = await this.pool.query(
        `SELECT id, osm_type, osm_id, category, name, ST_X(geom) AS lon, ST_Y(geom) AS lat
         FROM pois
         WHERE ST_Contains(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), geom)
         ${categorySql}
         ORDER BY md5(osm_type || osm_id)
         OFFSET $${offsetIndex}
         LIMIT 1`,
        params
      );
      const row = result.rows[0];
      if (row) {
        return {
          id: `poi-${row.id}`,
          name: row.name,
          category: row.category,
          coordinates: [Number(row.lon), Number(row.lat)],
          source: "postgis",
          osmType: row.osm_type,
          osmId: row.osm_id
        };
      }
    }

    const valid = FALLBACK_OBJECTIVES.filter(poi => containsPoint(area, poi.coordinates));
    return valid[offset % Math.max(1, valid.length)] || null;
  }

  async insertClaim(gameId: string, claim: ClaimRecord) {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO claims(id, game_id, hider_id, hider_name, objective, objective_kind, distance_meters, photo_url, status, score_value)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
      [claim.id, gameId, claim.hiderId, claim.hiderName, JSON.stringify(claim.objective), claim.objectiveKind, claim.distanceMeters, claim.photoUrl, claim.status, claim.scoreValue]
    );
  }

  async disallowClaim(claimId: string, reason: string) {
    if (!this.pool) return;
    await this.pool.query(
      `UPDATE claims SET status = 'disallowed', reason = $2, disallowed_at = now() WHERE id = $1`,
      [claimId, reason]
    );
  }
}
