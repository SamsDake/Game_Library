import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppState, LngLat } from "../shared/types";
import { StateStore } from "../server/src/state-store";
import { circlePolygon } from "../server/src/geo";
import { DEFAULT_CONFIG } from "../server/src/defaults";

function appState(): AppState {
  const center: LngLat = [-0.0915, 51.5125];
  return {
    phase: "setup",
    setup: {
      center,
      radius: 900,
      globalSafeZoneGeoJSON: circlePolygon(center, 900),
      config: DEFAULT_CONFIG
    },
    players: {},
    game: null,
    winner: null,
    history: []
  };
}

function tmpFile(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "urban-hunt-state-"));
  return path.join(dir, name);
}

describe("StateStore file fallback", () => {
  it("loads and saves current state shape when Redis is disabled", async () => {
    const file = tmpFile("state.json");
    const initial = appState();
    const saved = appState();
    saved.phase = "ended";
    fs.writeFileSync(file, JSON.stringify(saved));

    const store = new StateStore(initial, file);
    await store.connect("");
    expect(store.backend).toBe("file");
    expect((await store.load()).phase).toBe("ended");

    const next = appState();
    next.players.p1 = {
      id: "p1",
      secret: "s1",
      role: "HIDER",
      name: "Hider",
      online: false,
      joinedAt: 1,
      lastSeen: null,
      sockets: []
    };
    await store.save(next);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).players.p1.secret).toBe("s1");
  });

  it("ignores legacy state files instead of crashing or loading malformed state", async () => {
    const file = tmpFile("legacy-state.json");
    fs.writeFileSync(file, JSON.stringify({
      phase: "setup",
      setup: { zone: { lat: 51.5, lng: -0.1, radius: 900 }, config: {} },
      players: { p1: { id: "p1", role: "HIDER" } }
    }));

    const initial = appState();
    const store = new StateStore(initial, file);
    await store.connect("");

    const loaded = await store.load();
    expect(loaded.setup.center).toEqual(initial.setup.center);
    expect(loaded.players).toEqual({});
  });
});
