import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppState } from "../shared/types";
import { StateStore } from "../server/src/state-store";
import { OBJECTIVE_CATEGORIES } from "../shared/poi-categories";

function appState(): AppState {
  return {
    phase: "lobby",
    config: {
      centerLat: 51.5125,
      centerLng: -0.0915,
      radiusM: 1500,
      objectiveCount: 6,
      minDistanceM: 300,
      maxDistanceM: 900,
      totalMinutes: 30,
      categories: [...OBJECTIVE_CATEGORIES],
      sameRouteForAll: true
    },
    players: {},
    game: null
  };
}

function tmpFile(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hide-and-seek-state-"));
  return path.join(dir, name);
}

describe("StateStore file persistence", () => {
  it("loads a previously saved state file", () => {
    const file = tmpFile("state.json");
    const saved = appState();
    saved.phase = "ended";
    fs.writeFileSync(file, JSON.stringify(saved));

    const store = new StateStore(appState(), file);
    expect(store.load().phase).toBe("ended");

    const next = appState();
    next.players.p1 = { id: "p1", secret: "s1", role: "HIDE", ready: false, name: "Hider", online: false, joinedAt: 1, sockets: [] };
    store.save(next);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).players.p1.secret).toBe("s1");
  });

  it("ignores legacy or malformed state files instead of crashing", () => {
    const file = tmpFile("legacy-state.json");
    fs.writeFileSync(file, JSON.stringify({
      phase: "setup",
      setup: { zone: { lat: 51.5, lng: -0.1, radius: 900 } },
      players: { p1: { id: "p1", role: "HIDER" } }
    }));

    const initial = appState();
    const store = new StateStore(initial, file);
    const loaded = store.load();
    expect(loaded.config).toEqual(initial.config);
    expect(loaded.players).toEqual({});
  });
});
