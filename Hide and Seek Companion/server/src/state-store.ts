import fs from "node:fs";
import path from "node:path";
import type { AppState } from "../../shared/types";

export class StateStore {
  private memory: AppState;

  constructor(initial: AppState, private filePath: string) {
    this.memory = initial;
    this.loadFile();
  }

  load(): AppState {
    return this.memory;
  }

  save(state: AppState) {
    this.memory = state;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  private loadFile() {
    if (!fs.existsSync(this.filePath)) return;
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
  return !!value?.config
    && Array.isArray(value.config.categories)
    && !!value.players
    && Object.values(value.players).every(player =>
      typeof player.id === "string"
      && typeof player.secret === "string"
      && Array.isArray(player.sockets)
    );
}
