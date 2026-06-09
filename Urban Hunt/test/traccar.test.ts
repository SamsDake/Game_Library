import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Integration test for the Traccar Client (OsmAnd protocol) ingest endpoint. Spawns the real
// server (same pattern as test/modes-smoke.ts) and drives it over HTTP + Socket.IO.
const PORT = 3133;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let server: ChildProcess;
let tmp: string;

function once<T = any>(socket: Socket, event: string): Promise<T> {
  return new Promise(resolve => socket.once(event, resolve as (value: T) => void));
}
function emitAck<T = any>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}
async function connect(): Promise<Socket> {
  const socket = io(BASE, { transports: ["websocket"], reconnection: false });
  await once(socket, "connect");
  return socket;
}
async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await wait(250);
  }
  throw new Error("server did not become ready");
}
// boundaryTick emits ~1/sec during an active game, so polling these snapshots is reliable.
async function adminStateMatching(admin: Socket, predicate: (s: any) => boolean): Promise<any> {
  for (let i = 0; i < 40; i += 1) {
    const s: any = await once(admin, "state_admin");
    if (s.game && predicate(s)) return s;
  }
  throw new Error("expected admin state not observed");
}
async function seekerPingMatching(seeker: Socket, predicate: (p: any) => boolean): Promise<any> {
  for (let i = 0; i < 40; i += 1) {
    const p: any = await once(seeker, "ping_broadcast");
    if (predicate(p)) return p;
  }
  throw new Error("expected seeker ping not observed");
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urban-hunt-traccar-"));
  server = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "server/src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PIN: "2468",
      REDIS_URL: "",
      DATABASE_URL: "",
      STATE_FILE: path.join(tmp, "state.json"),
      HISTORY_FILE: path.join(tmp, "history.json"),
      UPLOAD_DIR: path.join(tmp, "uploads")
    },
    stdio: ["ignore", "ignore", "inherit"]
  });
  await waitForServer();
}, 40000);

afterAll(async () => {
  server?.kill();
  await wait(250);
});

describe("traccar OsmAnd ingest", () => {
  it("attributes a ping by player secret and serves it to seekers with the configured delay", async () => {
    const admin = await connect();
    const hider = await connect();
    const seeker = await connect();
    try {
      expect((await emitAck<any>(admin, "join_game", { role: "ADMIN", name: "Control", adminPin: "2468" })).ok).toBe(true);
      const jh = await emitAck<any>(hider, "join_game", { role: "HIDER", name: "Ghost" });
      expect(jh.ok).toBe(true);
      expect((await emitAck<any>(seeker, "join_game", { role: "SEEKER", name: "Alpha" })).ok).toBe(true);
      // Zero delay so the freshest ingested point is revealed to seekers immediately; no time limit.
      expect((await emitAck<any>(admin, "update_variables", { locationDelayMinutes: 0, gameDurationMinutes: 0 })).ok).toBe(true);
      expect((await emitAck<any>(admin, "admin_start_game", {})).ok).toBe(true);

      const started = await adminStateMatching(admin, () => true);
      // The zone centre is comfortably inside the global safe zone, so the hider bounds-check accepts it.
      const [lon, lat] = started.setup.center as [number, number];

      // OsmAnd ping: device identifier = player secret, lat/lon as query params (GET).
      const ping = await fetch(`${BASE}/api/traccar?id=${encodeURIComponent(jh.playerSecret)}&lat=${lat}&lon=${lon}`);
      expect(ping.status).toBe(200);

      // Admin (live) view reflects the ingested position and the history grew.
      const after = await adminStateMatching(admin, s => {
        const h = s.game.hiders.find((x: any) => x.playerId === jh.playerId);
        return !!h && Math.abs(h.coords[0] - lon) < 1e-6 && Math.abs(h.coords[1] - lat) < 1e-6;
      });
      const me = after.game.hiders.find((x: any) => x.playerId === jh.playerId);
      expect(me.history.length).toBeGreaterThanOrEqual(1);

      // Seekers receive it as delayedCoordinates (delay 0 → newest sample wins).
      const seen = await seekerPingMatching(seeker, p => {
        const h = p.hiders?.find((x: any) => x.hiderId === jh.playerId);
        return !!h && Math.abs(h.delayedCoordinates[0] - lon) < 1e-6 && Math.abs(h.delayedCoordinates[1] - lat) < 1e-6;
      });
      expect(seen).toBeTruthy();

      // Simulate the phone app being backgrounded/closed: its socket is gone, but Traccar keeps
      // posting by player secret. The server must still use that location for admin + seekers.
      hider.close();
      await wait(150);
      const backgroundLon = lon + 0.001;
      const backgroundLat = lat + 0.001;
      const backgroundPing = await fetch(`${BASE}/api/traccar?id=${encodeURIComponent(jh.playerSecret)}&lat=${backgroundLat}&lon=${backgroundLon}`);
      expect(backgroundPing.status).toBe(200);

      await adminStateMatching(admin, s => {
        const h = s.game.hiders.find((x: any) => x.playerId === jh.playerId);
        return !!h && Math.abs(h.coords[0] - backgroundLon) < 1e-6 && Math.abs(h.coords[1] - backgroundLat) < 1e-6;
      });
      await seekerPingMatching(seeker, p => {
        const h = p.hiders?.find((x: any) => x.hiderId === jh.playerId);
        return !!h && Math.abs(h.delayedCoordinates[0] - backgroundLon) < 1e-6 && Math.abs(h.delayedCoordinates[1] - backgroundLat) < 1e-6;
      });

      // If the app later resumes and flushes an older pending socket coordinate, it must not
      // overwrite the newer Traccar sample.
      const resumed = await connect();
      try {
        expect((await emitAck<any>(resumed, "join_game", {
          role: "HIDER",
          name: "Ghost",
          playerId: jh.playerId,
          playerSecret: jh.playerSecret
        })).ok).toBe(true);
        const staleAck = await emitAck<any>(resumed, "location_update", {
          coordinates: [lon, lat],
          accuracy: 10,
          timestamp: new Date(Date.now() - 60000).toISOString()
        });
        expect(staleAck.ok).toBe(true);
        const afterStale = await adminStateMatching(admin, s => {
          const h = s.game.hiders.find((x: any) => x.playerId === jh.playerId);
          return !!h && Math.abs(h.coords[0] - backgroundLon) < 1e-6 && Math.abs(h.coords[1] - backgroundLat) < 1e-6;
        });
        expect(afterStale).toBeTruthy();
      } finally {
        resumed.close();
      }
    } finally {
      admin.close();
      hider.close();
      seeker.close();
      await wait(150);
    }
  }, 40000);

  it("rejects unknown device ids and malformed coordinates with 400", async () => {
    const unknown = await fetch(`${BASE}/api/traccar?id=not-a-real-secret&lat=51.5&lon=-0.09`);
    expect(unknown.status).toBe(400);

    const badCoords = await fetch(`${BASE}/api/traccar?id=not-a-real-secret&lat=abc&lon=xyz`);
    expect(badCoords.status).toBe(400);
  }, 20000);
});
