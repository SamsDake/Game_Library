import * as turf from "@turf/turf";
import type { Feature, Polygon } from "geojson";
import type { Objective } from "../../shared/types";
import { osmElementToObjective, overpassQueryBlocks, type OverpassElement } from "../../shared/poi-categories";
import { containsPoint } from "./geo";

const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const CACHE_TTL_MS = 15 * 60 * 1000;   // re-fetch a tile at most every 15 min
const TILE_DEGREES = 0.05;             // ~5 km cache tiles
const MIN_FETCH_GAP_MS = 1100;         // be courteous to the public Overpass API
const MAX_PER_TILE = 400;              // cap POIs kept per tile (restaurants are dense)

interface CacheEntry {
  at: number;
  objectives: Objective[];
}

/**
 * Live source of real map features from the OpenStreetMap Overpass API, used to fill
 * objective slots when the seeded PostGIS database has none for an area. Network calls are
 * tile-cached and fired in the background, so the game loop never blocks on Overpass:
 * `getCached` returns whatever is currently cached (possibly empty) and schedules a fetch.
 */
export class OverpassClient {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<Objective[]>>();
  private lastFetchStartedAt = 0;

  // Real POIs known to be inside `area` right now. May be empty on a cold tile; a background
  // fetch is kicked off so subsequent calls (next game tick) return real features.
  getCached(area: Feature<Polygon>): Objective[] {
    const key = this.tileKey(area);
    const entry = this.cache.get(key);
    if ((!entry || Date.now() - entry.at > CACHE_TTL_MS) && Date.now() - this.lastFetchStartedAt >= MIN_FETCH_GAP_MS) {
      void this.refresh(key, area); // throttle bursts; retried next tick
    }
    if (!entry) return [];
    return entry.objectives.filter(o => containsPoint(area, o.coordinates));
  }

  // Awaitable warm-up: resolves once real POIs for `area` are cached, fetching now if the tile is
  // cold. Used at game start so the first objectives are real features, not placeholders. Resolves
  // with whatever is cached (possibly empty) if the fetch errors or exceeds `timeoutMs`.
  async ensureLoaded(area: Feature<Polygon>, timeoutMs = 8000): Promise<Objective[]> {
    const key = this.tileKey(area);
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.at <= CACHE_TTL_MS) {
      return entry.objectives.filter(o => containsPoint(area, o.coordinates));
    }
    const timeout = new Promise<void>(resolve => setTimeout(resolve, timeoutMs));
    await Promise.race([this.refresh(key, area).then(() => undefined), timeout]);
    return this.getCached(area);
  }

  private tileKey(area: Feature<Polygon>): string {
    const [west, south] = turf.bbox(area);
    return `${Math.floor(west / TILE_DEGREES)}:${Math.floor(south / TILE_DEGREES)}`;
  }

  // Fetch a tile, sharing one in-flight promise per tile so concurrent callers don't duplicate work.
  private refresh(key: string, area: Feature<Polygon>): Promise<Objective[]> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    this.lastFetchStartedAt = Date.now();
    const promise = this.fetchTile(area)
      .then(objectives => {
        this.cache.set(key, { at: Date.now(), objectives });
        return objectives;
      })
      .catch(err => {
        console.warn("[overpass] fetch failed", err instanceof Error ? err.message : err);
        return [] as Objective[];
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async fetchTile(area: Feature<Polygon>): Promise<Objective[]> {
    const [west, south, east, north] = turf.bbox(area);
    const bboxText = `${south},${west},${north},${east}`;
    const query = `[out:json][timeout:25];(${overpassQueryBlocks(bboxText)});out center tags;`;
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Overpass rejects requests without a descriptive User-Agent (HTTP 406).
        "user-agent": "UrbanHunt/0.2 (urban hunt game; live objectives)"
      },
      body: new URLSearchParams({ data: query })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { elements?: OverpassElement[] };
    const objectives = (json.elements || [])
      .map(element => osmElementToObjective(element, "overpass"))
      .filter((poi): poi is Objective => !!poi);
    return objectives.length > MAX_PER_TILE ? shuffle(objectives).slice(0, MAX_PER_TILE) : objectives;
  }
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
