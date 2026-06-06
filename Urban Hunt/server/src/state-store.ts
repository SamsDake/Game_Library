import { createClient, type RedisClientType } from "redis";
import fs from "node:fs";
import path from "node:path";
import type { AppState } from "../../shared/types";

const KEY = "urban-hunt:state";
export type StateBackend = "redis" | "file" | "memory";

export class StateStore {
  private redis: RedisClientType | null = null;
  private memory: AppState;
  private ready = false;
  private backendValue: StateBackend = "memory";

  constructor(initial: AppState, private filePath?: string) {
    this.memory = initial;
  }

  async connect(url?: string) {
    if (!url) {
      this.loadFile();
      this.ready = true;
      this.backendValue = this.filePath ? "file" : "memory";
      return;
    }
    try {
      this.redis = createClient({ url, socket: { reconnectStrategy: false } });
      this.redis.on("error", err => console.warn("[redis]", err.message));
      await this.redis.connect();
      const raw = await this.redis.get(KEY);
      if (raw) this.memory = JSON.parse(raw) as AppState;
      await this.save(this.memory);
      this.ready = true;
      this.backendValue = "redis";
    } catch (err) {
      console.warn("[redis] unavailable; using in-memory state", err instanceof Error ? err.message : err);
      this.redis = null;
      this.loadFile();
      this.ready = true;
      this.backendValue = this.filePath ? "file" : "memory";
    }
  }

  get backend(): StateBackend {
    return this.backendValue;
  }

  async load(): Promise<AppState> {
    if (!this.ready) return this.memory;
    if (!this.redis) return this.memory;
    const raw = await this.redis.get(KEY);
    if (raw) this.memory = JSON.parse(raw) as AppState;
    return this.memory;
  }

  async save(state: AppState) {
    this.memory = state;
    if (this.redis) await this.redis.set(KEY, JSON.stringify(state));
    else if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
    }
  }

  private loadFile() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<AppState>;
      if (isCurrentStateShape(parsed)) this.memory = parsed as AppState;
      else console.warn(`[state] ignoring legacy or malformed state file: ${this.filePath}`);
    } catch (err) {
      console.warn("[state] could not read state file", err instanceof Error ? err.message : err);
    }
  }
}

function isCurrentStateShape(value: Partial<AppState>): value is AppState {
  return value?.setup?.center instanceof Array
    && typeof value.setup.radius === "number"
    && !!value.setup.globalSafeZoneGeoJSON
    && !!value.setup.config
    && !!value.players
    && Object.values(value.players).every(player =>
      typeof player.id === "string"
      && typeof player.secret === "string"
      && Array.isArray(player.sockets)
    );
}
