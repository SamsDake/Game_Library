import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io } from "socket.io-client";

const PORT = 3132;
const BASE = `http://127.0.0.1:${PORT}`;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      await wait(250);
    }
  }
  throw new Error("server did not become ready");
}

function once<T = any>(socket: ReturnType<typeof io>, event: string) {
  return new Promise<T>(resolve => socket.once(event, resolve));
}

function emitAck<T = any>(socket: ReturnType<typeof io>, event: string, payload: unknown) {
  return new Promise<T>(resolve => socket.emit(event, payload, resolve));
}

async function connect() {
  const socket = io(BASE, { transports: ["websocket"], reconnection: false });
  await once(socket, "connect");
  return socket;
}

// Next admin state snapshot that contains an active game.
async function adminGameState(admin: ReturnType<typeof io>) {
  for (let i = 0; i < 25; i += 1) {
    const s: any = await once(admin, "state_admin");
    if (s.game) return s;
  }
  throw new Error("no active game state observed");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urban-hunt-modes-"));
  const server = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "server/src/index.ts"], {
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
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", chunk => { stderr += chunk.toString(); });

  try {
    await waitForServer();

    // ───────────────────────── VIP ESCORT ─────────────────────────
    {
      const admin = await connect();
      const h1 = await connect();
      const h2 = await connect();
      const seeker = await connect();

      assert.equal((await emitAck<any>(admin, "join_game", { role: "ADMIN", name: "Control", adminPin: "2468" })).ok, true);
      const j1 = await emitAck<any>(h1, "join_game", { role: "HIDER", name: "Ghost" });
      const j2 = await emitAck<any>(h2, "join_game", { role: "HIDER", name: "Wraith" });
      assert.equal((await emitAck<any>(seeker, "join_game", { role: "SEEKER", name: "Alpha" })).ok, true);

      assert.equal((await emitAck<any>(admin, "update_variables", { mode: "VIP_ESCORT", vipObjectiveTarget: 5, gameDurationMinutes: 0 })).ok, true);
      assert.equal((await emitAck<any>(admin, "admin_start_game", {})).ok, true);

      const state = await adminGameState(admin);
      const hiders: any[] = state.game.hiders;
      const vips = hiders.filter(h => h.hiderRole === "VIP");
      const guards = hiders.filter(h => h.hiderRole === "BODYGUARD");
      assert.equal(vips.length, 1, "exactly one VIP assigned");
      assert.equal(guards.length, 1, "the other hider is a bodyguard");
      assert.ok(hiders.every(h => typeof h.targetLabel === "string" && h.targetLabel.length), "every hider has a target label");

      // Seekers see anonymized "Target N" names, never the real call signs.
      const seekerState: any = await once(seeker, "ping_broadcast");
      assert.ok(seekerState.hiders.length >= 2);
      assert.ok(seekerState.hiders.every((h: any) => /^Target \d+$/.test(h.name)), "seeker sees pseudonyms");
      assert.ok(seekerState.hiders.every((h: any) => h.name !== "Ghost" && h.name !== "Wraith"), "real names hidden");
      assert.equal(seekerState.mode, "VIP_ESCORT");

      const vipId = vips[0].playerId;
      const guardId = guards[0].playerId;
      const socketFor = (id: string) => (id === j1.playerId ? h1 : id === j2.playerId ? h2 : null);

      // Tagging a decoy: game keeps running, the bodyguard stays in play.
      const decoyAck = await emitAck<any>(socketFor(guardId)!, "hider_caught", {});
      assert.equal(decoyAck.ok, true);
      assert.equal(decoyAck.decoy, true, "tagging a bodyguard reports a decoy");
      const afterDecoy = await adminGameState(admin);
      assert.equal(afterDecoy.phase, "active", "decoy tag does not end the game");
      assert.ok(afterDecoy.game.hiders.some((h: any) => h.playerId === guardId), "decoy remains in play");

      // Tagging the VIP ends the game for the seekers.
      const gameOver = once<any>(admin, "game_over");
      const vipAck = await emitAck<any>(socketFor(vipId)!, "hider_caught", {});
      assert.equal(vipAck.ok, true);
      assert.equal(vipAck.vipCaught, true, "tagging the VIP is reported");
      const result = await gameOver;
      assert.equal(result.winner, "SEEKERS", "catching the VIP wins for seekers");

      await emitAck(admin, "admin_game_control", { action: "reset" });
      [admin, h1, h2, seeker].forEach(s => s.close());
      await wait(200);
    }

    // ─────────────────── VIP ESCORT — objective win ───────────────────
    {
      const admin = await connect();
      const h1 = await connect();
      const h2 = await connect();
      const seeker = await connect();

      assert.equal((await emitAck<any>(admin, "join_game", { role: "ADMIN", name: "Control", adminPin: "2468" })).ok, true);
      const j1 = await emitAck<any>(h1, "join_game", { role: "HIDER", name: "Ghost" });
      const j2 = await emitAck<any>(h2, "join_game", { role: "HIDER", name: "Wraith" });
      assert.equal((await emitAck<any>(seeker, "join_game", { role: "SEEKER", name: "Alpha" })).ok, true);

      // One objective wins it.
      assert.equal((await emitAck<any>(admin, "update_variables", { mode: "VIP_ESCORT", vipObjectiveTarget: 1, gameDurationMinutes: 0 })).ok, true);
      assert.equal((await emitAck<any>(admin, "admin_start_game", {})).ok, true);

      const state = await adminGameState(admin);
      const vipEntry = state.game.hiders.find((h: any) => h.hiderRole === "VIP");
      assert.ok(vipEntry, "a VIP exists");
      const vipSecret = vipEntry.playerId === j1.playerId ? j1.playerSecret : j2.playerSecret;
      const vipSocket = vipEntry.playerId === j1.playerId ? h1 : h2;

      const vipStatus: any = await once(vipSocket, "status_update");
      assert.equal(vipStatus.me.hiderRole, "VIP");
      const objective = vipStatus.me.activeObjective;
      assert.ok(objective && objective.id !== "pending", "VIP has a real objective");

      // Stand on the objective so the claim clears the distance/staleness checks.
      assert.equal((await emitAck<any>(vipSocket, "location_update", { coordinates: objective.coordinates, timestamp: new Date().toISOString() })).ok, true);

      const gameOver = once<any>(admin, "game_over");
      const claim = await uploadClaim(vipEntry.playerId, vipSecret, objective, new Blob(["proof"], { type: "image/jpeg" }), "proof.jpg");
      assert.equal(claim.body.ok, true, `claim should succeed: ${JSON.stringify(claim.body)}`);
      const result = await gameOver;
      assert.equal(result.winner, "HIDERS", "VIP reaching the objective target wins for hiders");

      await emitAck(admin, "admin_game_control", { action: "reset" });
      [admin, h1, h2, seeker].forEach(s => s.close());
      await wait(200);
    }

    // ───────────────────────── SAFEHOUSES ─────────────────────────
    {
      const admin = await connect();
      const hider = await connect();
      const seeker = await connect();

      assert.equal((await emitAck<any>(admin, "join_game", { role: "ADMIN", name: "Control", adminPin: "2468" })).ok, true);
      const jh = await emitAck<any>(hider, "join_game", { role: "HIDER", name: "Ghost" });
      assert.equal((await emitAck<any>(seeker, "join_game", { role: "SEEKER", name: "Alpha" })).ok, true);

      assert.equal((await emitAck<any>(admin, "update_variables", { mode: "SAFEHOUSES", safehouseRadius: 400, gameDurationMinutes: 0 })).ok, true);
      assert.equal((await emitAck<any>(admin, "admin_start_game", {})).ok, true);

      const state = await adminGameState(admin);
      const safehouses: any[] = state.game.safehouses || [];
      assert.ok(safehouses.length >= 1, "safehouses auto-selected");
      assert.equal(state.game.totalCaptureSeconds, 0, "capture counter starts at zero");
      assert.ok(state.game.hiders.every((h: any) => (h.activeObjectives || []).length === 0), "hiders hold no personal objectives");

      const sh = safehouses[0];
      const center = sh.center as [number, number];
      const farAway: [number, number] = [center[0] + 0.05, center[1] + 0.05];

      // Hider alone inside a safehouse → breached, counter climbs.
      assert.equal((await emitAck<any>(seeker, "location_update", { coordinates: farAway, timestamp: new Date().toISOString() })).ok, true);
      assert.equal((await emitAck<any>(hider, "location_update", { coordinates: center, timestamp: new Date().toISOString() })).ok, true);
      await wait(2600);
      const breached = await adminGameState(admin);
      assert.ok((breached.game.totalCaptureSeconds || 0) >= 1, "capture time accrues while breached");
      assert.equal(breached.game.safehouses.find((s: any) => s.id === sh.id).state, "breached", "safehouse reports breached");

      // Seeker enters the same safehouse → contested, counter freezes.
      assert.equal((await emitAck<any>(seeker, "location_update", { coordinates: center, timestamp: new Date().toISOString() })).ok, true);
      await wait(1500);
      const cap1 = (await adminGameState(admin)).game.totalCaptureSeconds || 0;
      await wait(2000);
      const contested = await adminGameState(admin);
      assert.equal(contested.game.safehouses.find((s: any) => s.id === sh.id).state, "contested", "safehouse reports contested");
      assert.equal(contested.game.totalCaptureSeconds || 0, cap1, "capture time frozen while contested");

      await emitAck(admin, "admin_game_control", { action: "reset" });
      [admin, hider, seeker].forEach(s => s.close());
      await wait(200);
      void jh;
    }
  } finally {
    server.kill();
    await wait(250);
  }

  if (stderr) process.stderr.write(stderr);
  console.log("modes smoke ok");
}

async function uploadClaim(
  playerId: string,
  playerSecret: string,
  objective: { id: string; coordinates: [number, number] },
  photo: Blob | null,
  filename: string
) {
  const form = new FormData();
  form.append("playerId", playerId);
  form.append("playerSecret", playerSecret);
  form.append("objectiveId", objective.id);
  form.append("lon", String(objective.coordinates[0]));
  form.append("lat", String(objective.coordinates[1]));
  if (photo) form.append("photo", photo, filename);
  const response = await fetch(`${BASE}/api/claims`, { method: "POST", body: form });
  return { status: response.status, body: await response.json() as any };
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
