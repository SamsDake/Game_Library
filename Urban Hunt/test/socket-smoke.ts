import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io } from "socket.io-client";

const PORT = 3131;
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

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urban-hunt-smoke-"));
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
      UPLOAD_DIR: path.join(tmp, "uploads"),
      PLAYER_LOCATION_STALE_SECONDS: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", chunk => { stderr += chunk.toString(); });

  try {
    await waitForServer();
    const health = await (await fetch(`${BASE}/api/health`)).json() as { stateBackend: string; demoLocationEnabled: boolean };
    assert.equal(health.stateBackend, "file");
    assert.equal(health.demoLocationEnabled, false);
    const admin = io(BASE, { transports: ["websocket"], reconnection: false });
    const hider = io(BASE, { transports: ["websocket"], reconnection: false });
    const seeker = io(BASE, { transports: ["websocket"], reconnection: false });
    await Promise.all([once(admin, "connect"), once(hider, "connect"), once(seeker, "connect")]);

    const bad = await emitAck<{ ok: boolean }>(admin, "join_game", { role: "ADMIN", name: "Control", adminPin: "bad" });
    assert.equal(bad.ok, false);
    const adminJoin = await emitAck<{ ok: boolean }>(admin, "join_game", { role: "ADMIN", name: "Control", adminPin: "2468" });
    assert.equal(adminJoin.ok, true);
    const hiderJoin = await emitAck<{ ok: boolean; playerId: string; playerSecret: string }>(hider, "join_game", { role: "HIDER", name: "Ghost" });
    assert.equal(hiderJoin.ok, true);
    const seekerJoin = await emitAck<{ ok: boolean }>(seeker, "join_game", { role: "SEEKER", name: "Alpha" });
    assert.equal(seekerJoin.ok, true);
    const configured = await emitAck<{ ok: boolean }>(admin, "update_variables", {
      regularObjectivePoints: 3,
      lockdownObjectivePoints: 5,
      lockdownForecastDistance: 75
    });
    assert.equal(configured.ok, true);
    const started = await emitAck<{ ok: boolean }>(admin, "admin_start_game", {});
    assert.equal(started.ok, true);
    const duplicateStart = await emitAck<{ ok: boolean; error?: string }>(admin, "admin_start_game", {});
    assert.equal(duplicateStart.ok, false);
    assert.equal(duplicateStart.error, "game_already_active");
    const invalidAction = await emitAck<{ ok: boolean; error?: string }>(admin, "admin_game_control", { action: "dance" });
    assert.equal(invalidAction.ok, false);
    assert.equal(invalidAction.error, "invalid_action");

    const hiderState: any = await once(hider, "status_update");
    const seekerState: any = await once(seeker, "ping_broadcast");
    assert.ok(hiderState.me.activeObjective.id);
    assert.equal(hiderState.me.activeObjectives[0].scoreValue, 3);
    assert.ok(hiderState.me.nextLockdownCircleGeoJSON);
    assert.ok(hiderState.me.lockdownExpiresAt);
    assert.ok(hiderState.me.nextLockdownStartsAt);
    assert.equal(seekerState.hiders[0].coords, undefined);
    assert.ok(seekerState.hiders[0].delayedCoordinates);

    const roleSwitch = await emitAck<{ ok: boolean; error?: string }>(hider, "join_game", {
      role: "SEEKER",
      name: "Ghost",
      playerId: hiderJoin.playerId,
      playerSecret: hiderJoin.playerSecret
    });
    assert.equal(roleSwitch.ok, false);
    assert.equal(roleSwitch.error, "active_role_locked");
    const lateHider = io(BASE, { transports: ["websocket"], reconnection: false });
    await once(lateHider, "connect");
    const lateHiderJoin = await emitAck<{ ok: boolean; error?: string }>(lateHider, "join_game", { role: "HIDER", name: "Late" });
    assert.equal(lateHiderJoin.ok, false);
    assert.equal(lateHiderJoin.error, "late_hider_join");
    lateHider.close();

    const left = await emitAck<{ ok: boolean }>(hider, "leave_game", {});
    assert.equal(left.ok, true);
    const rejoined = await emitAck<{ ok: boolean }>(hider, "join_game", {
      role: "HIDER",
      name: "Ghost",
      playerId: hiderJoin.playerId,
      playerSecret: hiderJoin.playerSecret
    });
    assert.equal(rejoined.ok, true);

    const obj = hiderState.me.activeObjective;
    const noLocation = await uploadClaim(hiderJoin.playerId, hiderJoin.playerSecret, obj, new Blob(["proof"], { type: "image/jpeg" }), "proof.jpg");
    assert.equal(noLocation.status, 422);
    assert.equal(noLocation.body.error, "location_unavailable");

    const invalidPhoto = await uploadClaim(hiderJoin.playerId, hiderJoin.playerSecret, obj, new Blob(["nope"], { type: "text/plain" }), "proof.txt");
    assert.equal(invalidPhoto.status, 400);
    assert.equal(invalidPhoto.body.error, "invalid_photo_type");

    const missingPhoto = await uploadClaim(hiderJoin.playerId, hiderJoin.playerSecret, obj, null, "proof.jpg");
    assert.equal(missingPhoto.status, 400);
    assert.equal(missingPhoto.body.error, "photo_required");

    const farLoc = await emitAck<{ ok: boolean }>(hider, "location_update", {
      coordinates: hiderState.me.coordinates,
      timestamp: new Date().toISOString()
    });
    assert.equal(farLoc.ok, true);
    const tooFar = await uploadClaim(hiderJoin.playerId, hiderJoin.playerSecret, obj, new Blob(["proof"], { type: "image/jpeg" }), "proof.jpg");
    assert.equal(tooFar.status, 422);
    assert.equal(tooFar.body.error, "too_far_from_objective");

    const loc = await emitAck<{ ok: boolean }>(hider, "location_update", {
      coordinates: obj.coordinates,
      timestamp: new Date().toISOString()
    });
    assert.equal(loc.ok, true);

    const { body: claim } = await uploadClaim(hiderJoin.playerId, hiderJoin.playerSecret, obj, new Blob(["proof"], { type: "image/jpeg" }), "proof.jpg");
    assert.equal(claim.ok, true);
    assert.equal(claim.claim.scoreValue, 3);
    assert.deepEqual(claim.claim.coordinates, obj.coordinates);

    await wait(1200);
    const stale = await uploadClaim(
      hiderJoin.playerId,
      hiderJoin.playerSecret,
      claim.nextObjectives[0].objective,
      new Blob(["proof"], { type: "image/jpeg" }),
      "proof.jpg"
    );
    assert.equal(stale.status, 422);
    assert.equal(stale.body.error, "location_stale");

    const ended = await emitAck<{ ok: boolean }>(admin, "admin_game_control", { action: "end", winner: "HIDERS" });
    assert.equal(ended.ok, true);
    const disallowed = await emitAck<{ ok: boolean }>(admin, "admin_disallow_claim", { claimId: claim.claim.id, reason: "smoke" });
    assert.equal(disallowed.ok, true);
    const history = JSON.parse(fs.readFileSync(path.join(tmp, "history.json"), "utf8")) as any[];
    assert.equal(history[0].claims.find(claimItem => claimItem.id === claim.claim.id).status, "disallowed");
    await emitAck(admin, "admin_game_control", { action: "reset" });
    admin.close();
    hider.close();
    seeker.close();
  } finally {
    server.kill();
    await wait(250);
  }

  if (stderr) process.stderr.write(stderr);
  console.log("socket smoke ok");
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
