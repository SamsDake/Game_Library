import express from "express";
import type { Request, Response } from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { Server } from "socket.io";
import type { Feature, Polygon } from "geojson";
import type {
  AdminConfigPayload,
  AdminStatePayload,
  AppState,
  ClaimRecord,
  GameHistoryEntry,
  GameMode,
  GameState,
  HiderState,
  HiderStatusPayload,
  HiderTeamRole,
  JoinGamePayload,
  LeaderboardEntry,
  LocationUpdatePayload,
  LngLat,
  Objective,
  ObjectiveSlot,
  PlayerInternal,
  PlayerPublic,
  Safehouse,
  SafehouseState,
  SeekerPingPayload,
  SeekerState
} from "../../shared/types";
import { DEFAULT_CONFIG, FALLBACK_OBJECTIVES } from "./defaults";
import { OBJECTIVE_CATEGORIES } from "../../shared/poi-categories";
import { Database } from "./db";
import {
  circlePolygon,
  containsPoint,
  containsPointWithBuffer,
  delayedCoordinate,
  delayedTrail,
  distanceMeters,
  legalArea,
  proximityFor,
  shrinkGlobalZone
} from "./geo";
import { StateStore } from "./state-store";
import { PushService } from "./push";
import { OverpassClient } from "./overpass";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || "data/uploads");
const HISTORY_FILE = path.resolve(ROOT, process.env.HISTORY_FILE || "data/history.json");
const STATE_FILE = path.resolve(ROOT, process.env.STATE_FILE || "data/state.json");
const CLIENT_DIST = path.resolve(ROOT, "client/dist");
const PLAYER_STALE_MS = clampNumber(process.env.PLAYER_STALE_SECONDS, 90, 20, 600) * 1000;
const PLAYER_LOCATION_STALE_MS = clampNumber(process.env.PLAYER_LOCATION_STALE_SECONDS, 120, 1, 600) * 1000;
const DEMO_LOCATION_ENABLED = ["1", "true", "yes"].includes(String(process.env.DEMO_LOCATION_ENABLED || "").toLowerCase());
const PLAYER_STALE_SWEEP_MS = 10 * 1000;
// Grace before an offline device is pruned from the pre-game lobby (tolerates page refreshes/reconnects).
const PLAYER_OFFLINE_PRUNE_MS = 15 * 1000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
if (!process.env.ADMIN_PIN) console.warn("[urban-hunt] ADMIN_PIN not set; using development PIN 1234.");

const initialState = (): AppState => {
  const center: LngLat = [-0.0915, 51.5125];
  const radius = 900;
  return {
    phase: "setup",
    setup: {
      center,
      radius,
      globalSafeZoneGeoJSON: circlePolygon(center, radius),
      config: DEFAULT_CONFIG
    },
    players: {},
    game: null,
    winner: null,
    history: readHistoryFile()
  };
};

const store = new StateStore(initialState(), STATE_FILE);
const db = new Database(process.env.DATABASE_URL);
const push = new PushService(path.resolve(ROOT, "data/vapid.json"));
const overpass = new OverpassClient();
const PROXIMITY_RANK: Record<string, number> = { Distant: 0, Far: 1, Near: 2 };
let state: AppState = initialState();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 15 * 1024 * 1024, cors: { origin: true } });
let lastSeekerPingAt = 0;

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const gameId = state.game?.id || "pending";
    const dir = path.join(UPLOAD_DIR, gameId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    cb(null, `${id("claim")}${ext}`);
  }
});
const allowedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const allowedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!allowedImageMimeTypes.has(file.mimetype) || !allowedImageExtensions.has(ext)) {
      return cb(new Error("invalid_photo_type"));
    }
    cb(null, true);
  }
});
const uploadClaimPhoto = upload.single("photo");

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", origin || "*");
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/uploads", express.static(UPLOAD_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    phase: state.phase,
    players: Object.keys(state.players).length,
    redis: store.backend === "redis",
    postgis: db.enabled,
    stateBackend: store.backend,
    demoLocationEnabled: DEMO_LOCATION_ENABLED
  });
});

app.get("/api/client-config", (_req, res) => {
  res.json({ ok: true, demoLocationEnabled: DEMO_LOCATION_ENABLED });
});

// Traccar Client (OsmAnd protocol) background-location ingest. A player runs the Traccar
// Client app pointed at this URL with their player secret as the "Device identifier", so
// their position keeps flowing while the Urban Hunt app is backgrounded or closed. Pings
// feed the same history + delay pipeline as socket location updates.
app.all("/api/traccar", async (req, res) => {
  const params = { ...req.query, ...req.body } as Record<string, unknown>;
  const id = String(params.id ?? params.deviceid ?? "");
  const lat = Number(params.lat);
  const lon = Number(params.lon);
  const player = id ? Object.values(state.players).find(p => p.secret === id) : undefined;
  if (!player || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.sendStatus(400);
    return;
  }
  // Known device but no live game for them: accept-and-ignore so the client doesn't retry-spam.
  if (state.game?.phase !== "active" || !activeGameRole(player.id)) {
    res.sendStatus(200);
    return;
  }
  player.lastSeen = Date.now();
  const accuracy = Number(params.accuracy);
  await applyLocationToGame(
    player,
    [lon, lat],
    Number.isFinite(accuracy) ? accuracy : null,
    parseLocationTimestamp(params.timestamp ?? params.time ?? params.fixtime)
  );
  res.sendStatus(200);
});

app.get("/api/history", (_req, res) => {
  res.json({ ok: true, history: state.history || [] });
});

app.get("/api/push/vapid", (_req, res) => {
  res.json({ ok: true, publicKey: push.vapidPublicKey });
});

app.post("/api/claims", (req, res) => {
  uploadClaimPhoto(req, res, err => {
    if (err) {
      const error = err instanceof multer.MulterError
        ? (err.code === "LIMIT_FILE_SIZE" ? "photo_too_large" : "invalid_photo")
        : err instanceof Error && err.message === "invalid_photo_type"
          ? "invalid_photo_type"
          : "invalid_photo";
      res.status(400).json({ ok: false, error });
      return;
    }
    void handleClaim(req, res);
  });
});

async function handleClaim(req: Request, res: Response) {
  const { playerId, playerSecret, objectiveId, slotId, lon, lng, lat } = req.body;
  const player = state.players[playerId];
  const game = state.game;
  const hider = game?.hiders[playerId];

  const fail = (status: number, error: string) => {
    if (req.file) fs.rm(req.file.path, { force: true }, () => undefined);
    res.status(status).json({ ok: false, error });
  };

  if (!game || game.phase !== "active") return fail(409, "game_not_active");
  if (!player || player.role !== "HIDER" || player.secret !== playerSecret) return fail(403, "invalid_player");
  if (!hider) return fail(404, "hider_not_found");
  if (game.config.mode === "SAFEHOUSES") return fail(409, "no_objectives");
  if (game.config.mode === "VIP_ESCORT" && hider.hiderRole !== "VIP") return fail(403, "not_vip");
  if (hider.caughtAt) return fail(409, "hider_caught");
  if (hider.isOutOfBounds) return fail(409, "out_of_bounds");
  if (!req.file) return fail(400, "photo_required");
  if (!player.coords) return fail(422, "location_unavailable");
  const lastValidLocationAt = hider.history[hider.history.length - 1]?.timestamp || 0;
  if (!lastValidLocationAt || Date.now() - lastValidLocationAt > PLAYER_LOCATION_STALE_MS) return fail(422, "location_stale");
  const submittedCoordinates = [
    Number(lon ?? req.body.longitude ?? lng ?? req.body[0]),
    Number(lat ?? req.body.latitude ?? req.body[1])
  ] as LngLat;
  if ((lon != null || lat != null || lng != null || req.body.longitude != null || req.body.latitude != null)
    && (!Number.isFinite(submittedCoordinates[0]) || !Number.isFinite(submittedCoordinates[1]))) {
    return fail(400, "invalid_coordinates");
  }
  const coordinates = player.coords;

  expireLockdownObjectives(hider);
  const objectiveSlot = findObjectiveSlot(hider, String(slotId || ""), String(objectiveId || ""));
  if (!objectiveSlot) return fail(409, "objective_changed");

  const distance = distanceMeters(coordinates, objectiveSlot.objective.coordinates);
  if (distance > game.config.claimRadius) return fail(422, "too_far_from_objective");
  const lockdownClaim = !!hider.lockdownCircleGeoJSON && containsPoint(hider.lockdownCircleGeoJSON, objectiveSlot.objective.coordinates);
  const scoreValue = lockdownClaim ? game.config.lockdownObjectivePoints : objectiveSlot.scoreValue;

  const claimId = path.basename(req.file.filename, path.extname(req.file.filename));
  const claim: ClaimRecord = {
    id: claimId,
    hiderId: playerId,
    hiderName: player.name,
    objective: objectiveSlot.objective,
    objectiveKind: objectiveSlot.kind,
    coordinates,
    distanceMeters: distance,
    photoUrl: `/uploads/${game.id}/${req.file.filename}`,
    status: "accepted",
    scoreValue,
    createdAt: Date.now()
  };

  hider.claims.push(claim);
  game.claims.push(claim);
  hider.score += scoreValue;
  if (game.config.mode === "VIP_ESCORT") {
    // Deception rule: seekers get a non-specific marker that the VIP is active — no name, no place.
    emitAlert("An objective has been cleared!");
    push.sendToMany([...Object.keys(game.seekers), ...Object.keys(game.hiders)], {
      title: "Objective Cleared",
      body: "An objective has been cleared!",
      tag: "objective"
    });
  } else {
    push.sendToMany(Object.keys(game.seekers), {
      title: "Objective Claimed",
      body: `${player.name} completed an objective (+${scoreValue}pt).`,
      tag: "claim"
    });
  }
  hider.activeObjectives = hider.activeObjectives.filter(slot => slot.slotId !== objectiveSlot.slotId);
  if (objectiveSlot.kind === "regular") {
    hider.objectiveIndex += 1;
    await assignRegularObjective(hider, game);
  }
  await syncHiderObjectives(hider, game);
  await db.insertClaim(game.id, claim);
  if (game.config.mode === "VIP_ESCORT") {
    const cleared = hider.claims.filter(c => c.status === "accepted").length;
    if (cleared >= game.config.vipObjectiveTarget) await finishGame("HIDERS");
  }
  await saveAndEmit();
  res.json({ ok: true, claim, nextObjective: hider.activeObjective, nextObjectives: hider.activeObjectives });
}

io.on("connection", socket => {
  socket.emit("state_admin", adminPayload());
  socket.use((_event, next) => {
    touchPlayer(socket.data.playerId, socket.id);
    next();
  });

  socket.on("join_game", async (payload: JoinGamePayload, ack = noop) => {
    const role = payload?.role;
    if (!["HIDER", "SEEKER", "ADMIN"].includes(role)) return ack({ ok: false, error: "invalid_role" });
    if (role === "ADMIN" && String(payload.adminPin || "") !== ADMIN_PIN) {
      return ack({ ok: false, error: "invalid_admin_pin" });
    }

    const existing = payload.playerId && state.players[payload.playerId]?.secret === payload.playerSecret
      ? state.players[payload.playerId]
      : null;

    const activeRole = existing ? activeGameRole(existing.id) : null;
    if (state.game?.phase === "active" && role !== "ADMIN") {
      if (activeRole && activeRole !== role) return ack({ ok: false, error: "active_role_locked" });
      if (!activeRole && role === "HIDER") return ack({ ok: false, error: "late_hider_join" });
    }

    // A device maps to a single active identity. If this socket was attached to a different
    // player (e.g. a seeker who left and is rejoining as a hider), drop the stale identity so
    // it doesn't linger in the roster.
    for (const other of Object.values(state.players)) {
      if (other === existing || !other.sockets?.includes(socket.id)) continue;
      if (state.game?.phase === "active" && activeGameRole(other.id)) {
        return ack({ ok: false, error: "active_identity_locked" });
      }
      other.sockets = other.sockets.filter(socketId => socketId !== socket.id);
      if (other.sockets.length) other.online = true;
      else removePlayer(other.id);
    }

    const player: PlayerInternal = existing || {
      id: id("p"),
      secret: id("secret"),
      joinedAt: Date.now(),
      lastSeen: null,
      sockets: [],
      online: false,
      role,
      name: role
    };
    player.role = role;
    player.name = cleanName(payload.name || role);
    player.online = true;
    player.lastSeen = Date.now();
    player.sockets = Array.from(new Set([...(player.sockets || []), socket.id]));
    state.players[player.id] = player;
    socket.data.playerId = player.id;
    socket.data.role = role;
    socket.data.isAdmin = role === "ADMIN";
    if (role === "ADMIN") socket.join("admins");

    if (state.game?.phase === "active") ensurePlayerInActiveGame(player, state.game);
    await saveAndEmit();
    ack({ ok: true, playerId: player.id, playerSecret: player.secret, role });
  });

  socket.on("leave_game", async (_payload = {}, ack = noop) => {
    const player = state.players[socket.data.playerId];
    if (player) {
      player.sockets = (player.sockets || []).filter(socketId => socketId !== socket.id);
      if (player.sockets.length) player.online = true;
      else if (state.game?.phase === "active" && activeGameRole(player.id)) {
        player.online = false;
        player.lastSeen = Date.now();
      }
      else removePlayer(player.id);
    }
    socket.leave("admins");
    socket.data.playerId = undefined;
    socket.data.role = undefined;
    socket.data.isAdmin = false;
    await saveAndEmit();
    ack({ ok: true });
  });

  socket.on("update_variables", async (payload: AdminConfigPayload, ack = noop) => {
    if (!requireAdmin(socket, ack)) return;
    applyConfig(payload);
    await saveAndEmit();
    ack({ ok: true, setup: state.setup });
  });

  socket.on("admin_setup_update", async (payload: AdminConfigPayload, ack = noop) => {
    if (!requireAdmin(socket, ack)) return;
    applyConfig(payload);
    await saveAndEmit();
    ack({ ok: true, setup: state.setup });
  });

  socket.on("admin_start_game", async (_payload = {}, ack = noop) => {
    if (!requireAdmin(socket, ack)) return;
    if (state.game?.phase === "active") return ack({ ok: false, error: "game_already_active" });
    removeOfflinePlayers();
    const hiders = Object.values(state.players).filter(p => p.role === "HIDER");
    const seekers = Object.values(state.players).filter(p => p.role === "SEEKER");
    if (!hiders.length || !seekers.length) return ack({ ok: false, error: "need_hider_and_seeker" });
    state.phase = "active";
    state.winner = null;
    state.game = await makeGame(hiders, seekers);
    await saveAndEmit();
    ack({ ok: true, gameId: state.game.id });
  });

  socket.on("admin_disconnect_all", async (_payload = {}, ack = noop) => {
    if (!requireAdmin(socket, ack)) return;
    if (state.phase === "active") return ack({ ok: false, error: "game_in_progress" });
    const removed = disconnectAllPlayers(socket.data.playerId);
    await saveAndEmit();
    ack({ ok: true, removed });
  });

  socket.on("location_update", async (payload: LocationUpdatePayload, ack = noop) => {
    const playerId = socket.data.playerId;
    const player = state.players[playerId];
    const game = state.game;
    if (!player || !game || game.phase !== "active") return ack({ ok: false, error: "not_active" });
    const coords = payload.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2 || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
      return ack({ ok: false, error: "invalid_coordinates" });
    }
    player.lastSeen = Date.now();
    player.online = true;
    player.sockets = Array.from(new Set([...(player.sockets || []), socket.id]));

    await applyLocationToGame(player, coords, payload.accuracy ?? null, parseLocationTimestamp(payload.timestamp));
    ack({ ok: true });
  });

  socket.on("client_heartbeat", async (_payload = {}, ack = noop) => {
    const changed = touchPlayer(socket.data.playerId, socket.id);
    if (changed) await saveAndEmit();
    ack({ ok: true, serverTime: Date.now() });
  });

  socket.on("register_push", (payload: { playerId?: string; playerSecret?: string; subscription?: unknown; nativeToken?: string; platform?: string } = {}, ack = noop) => {
    const verified = payload.playerId && state.players[payload.playerId]?.secret === payload.playerSecret
      ? payload.playerId
      : socket.data.playerId;
    push.register(verified, payload?.subscription as never);
    push.registerNative(verified, payload?.nativeToken, payload?.platform);
    ack({ ok: true });
  });

  socket.on("hider_caught", async (_payload = {}, ack = noop) => {
    const playerId = socket.data.playerId;
    const player = state.players[playerId];
    const game = state.game;
    const hider = game?.hiders[playerId];
    if (!player || !game || game.phase !== "active") return ack({ ok: false, error: "not_active" });
    if (player.role !== "HIDER" || !hider) return ack({ ok: false, error: "not_hider" });

    // VIP Escort: catching the VIP ends the game; catching a bodyguard only burns a decoy.
    if (game.config.mode === "VIP_ESCORT") {
      if (hider.hiderRole === "VIP") {
        hider.caughtAt = Date.now();
        await finishGame("SEEKERS");
        await saveAndEmit();
        return ack({ ok: true, vipCaught: true });
      }
      emitAlert("A decoy was tagged — that wasn't the VIP.");
      push.sendToMany(seekerIds(game), { title: "Decoy Tagged", body: "You tagged a decoy — that wasn't the VIP.", tag: "decoy" });
      await saveAndEmit();
      return ack({ ok: true, decoy: true });
    }

    hider.caughtAt = Date.now();
    const entry = leaderboardEntry(hider);
    game.leaderboard = [
      ...game.leaderboard.filter(item => item.playerId !== hider.playerId),
      entry
    ];
    delete game.hiders[playerId];
    player.role = "SEEKER";
    socket.data.role = "SEEKER";
    game.seekers[playerId] = {
      playerId,
      name: player.name,
      coords: player.coords || hider.coords,
      history: [{ coordinates: player.coords || hider.coords, timestamp: Date.now() }]
    };

    if (!Object.keys(game.hiders).length) {
      await finishGame("SEEKERS");
      await saveAndEmit();
    } else {
      await saveAndEmit();
    }
    ack({ ok: true, leaderboard: game.leaderboard });
  });

  socket.on("admin_game_control", async (payload: { action?: string; winner?: "HIDERS" | "SEEKERS"; clearHistory?: boolean }, ack = noop) => {
    if (!requireAdmin(socket, ack)) return;
    const action = payload.action;
    if (!["pause", "resume", "end", "reset"].includes(String(action || ""))) return ack({ ok: false, error: "invalid_action" });
    if (action === "pause" && state.game) state.game.paused = true;
    if (action === "resume" && state.game) state.game.paused = false;
    if (action === "end" && state.game) {
      await finishGame(payload.winner || "SEEKERS");
    }
    if (action === "reset") {
      const history = payload.clearHistory ? [] : (state.history || readHistoryFile());
      if (payload.clearHistory) writeHistoryFile([]);
      // Keep the admin-configured settings (config, center, radius) so they carry into the next game.
      const setup = state.setup;
      state = { ...initialState(), setup, history };
      lastRosterSignature = "";
      push.clear();
      // Send every non-admin client back to the home screen for a clean slate.
      io.emit("force_reset");
    }
    await saveAndEmit();
    ack({ ok: true });
  });

  socket.on("admin_disallow_claim", async (payload: { claimId?: string; reason?: string }, ack = noop) => {
    if (!requireAdmin(socket, ack)) return;
    const claim = state.game?.claims.find(c => c.id === payload.claimId);
    if (!claim) return ack({ ok: false, error: "claim_not_found" });
    const wasAccepted = claim.status === "accepted";
    claim.status = "disallowed";
    claim.reason = String(payload.reason || "manual review").slice(0, 200);
    claim.disallowedAt = Date.now();
    if (wasAccepted && state.game) {
      const hider = state.game.hiders[claim.hiderId];
      if (hider) hider.score = Math.max(0, hider.score - (claim.scoreValue || 1));
      const entry = state.game.leaderboard.find(item => item.playerId === claim.hiderId);
      if (entry) entry.score = Math.max(0, entry.score - (claim.scoreValue || 1));
    }
    syncHistoryClaimDisallow(claim);
    await db.disallowClaim(claim.id, claim.reason);
    await saveAndEmit();
    ack({ ok: true, claim });
  });

  socket.on("disconnect", async () => {
    const player = state.players[socket.data.playerId];
    if (!player) return;
    player.sockets = player.sockets.filter(socketId => socketId !== socket.id);
    player.online = player.sockets.length > 0;
    await saveAndEmit();
  });
});

function applyConfig(payload: AdminConfigPayload) {
  const rawConfig = state.game?.config || state.setup.config;
  const current = {
    ...DEFAULT_CONFIG,
    ...rawConfig,
    proximityThresholds: {
      ...DEFAULT_CONFIG.proximityThresholds,
      ...rawConfig.proximityThresholds
    }
  };
  // Mode is chosen during setup and locked once a game is active.
  const allowedModes: GameMode[] = ["CLASSIC", "VIP_ESCORT", "SAFEHOUSES"];
  const requestedMode = allowedModes.includes(payload.mode as GameMode) ? (payload.mode as GameMode) : current.mode;
  const mode = state.game?.phase === "active" ? current.mode : requestedMode;
  const config = {
    ...current,
    mode,
    vipObjectiveTarget: Math.round(clampNumber(payload.vipObjectiveTarget, current.vipObjectiveTarget, 1, 50)),
    safehouseRadius: clampNumber(payload.safehouseRadius, current.safehouseRadius, 10, 500),
    safehouseCaptureTargetSeconds: Math.round(clampNumber(payload.safehouseCaptureTargetSeconds, current.safehouseCaptureTargetSeconds, 30, 7200)),
    pingIntervalMinutes: clampNumber(payload.pingIntervalMinutes, current.pingIntervalMinutes, 0.1, 30),
    locationDelayMinutes: clampNumber(payload.locationDelayMinutes, current.locationDelayMinutes, 0, 30),
    lockdownIntervalCount: Math.round(clampNumber(payload.lockdownIntervalCount, current.lockdownIntervalCount, 1, 20)),
    globalSqueezePercentage: clampNumber(payload.globalSqueezePercentage, current.globalSqueezePercentage, 1, 50),
    lockdownRadius: clampNumber(payload.lockdownRadius, current.lockdownRadius, 50, 2000),
    lockdownForecastDistance: clampNumber(payload.lockdownForecastDistance, current.lockdownForecastDistance, 0, 3000),
    lockdownDurationSeconds: clampNumber(payload.lockdownDurationSeconds, current.lockdownDurationSeconds, 10, 3600),
    shrinkIntervalSeconds: clampNumber(payload.shrinkIntervalSeconds, current.shrinkIntervalSeconds, 10, 3600),
    gameDurationMinutes: Math.round(clampNumber(payload.gameDurationMinutes, current.gameDurationMinutes, 0, 600)),
    objectiveMinDistance: clampNumber(payload.objectiveMinDistance, current.objectiveMinDistance, 0, 3000),
    objectiveMaxDistance: Math.max(
      clampNumber(payload.objectiveMaxDistance, current.objectiveMaxDistance, 0, 3000),
      clampNumber(payload.objectiveMinDistance, current.objectiveMinDistance, 0, 3000)
    ),
    regularObjectivePoints: Math.round(clampNumber(payload.regularObjectivePoints, current.regularObjectivePoints, 1, 20)),
    lockdownObjectivePoints: Math.round(clampNumber(payload.lockdownObjectivePoints, current.lockdownObjectivePoints, 1, 40)),
    proximityThresholds: {
      near: clampNumber(payload.proximityThresholds?.near, current.proximityThresholds.near, 10, 1000),
      far: clampNumber(payload.proximityThresholds?.far, current.proximityThresholds.far, 100, 5000)
    },
    claimRadius: clampNumber(payload.claimRadius, current.claimRadius, 10, 200)
  };
  const center = payload.center || state.setup.center;
  const radius = clampNumber(payload.radius, state.setup.radius, 100, 20000);
  state.setup = {
    center,
    radius,
    globalSafeZoneGeoJSON: circlePolygon(center, radius),
    config
  };
  if (state.game?.phase === "active") state.game.config = config;
  // Warm the objective cache for the (possibly new) play area so it's hot by game start.
  void overpass.getCached(state.setup.globalSafeZoneGeoJSON);
}

async function makeGame(hiders: PlayerInternal[], seekers: PlayerInternal[]): Promise<GameState> {
  const startedAt = Date.now();
  const game: GameState = {
    id: `HUNT-${Math.floor(1000 + Math.random() * 9000)}`,
    phase: "active",
    startedAt,
    endedAt: null,
    leaderboard: [],
    globalSafeZoneGeoJSON: state.setup.globalSafeZoneGeoJSON,
    config: state.setup.config,
    shrinkCountdown: state.setup.config.shrinkIntervalSeconds,
    hiders: {},
    seekers: {},
    claims: [],
    oobCount: 0,
    paused: false
  };

  // Preload real map features for the play area before assigning objectives, so hiders start with
  // real, claimable objectives instead of the "Awaiting Objective" placeholder.
  await overpass.ensureLoaded(game.globalSafeZoneGeoJSON);
  lastSeekerPingAt = startedAt;

  seekers.forEach((player, index) => {
    const coords = player.coords || offsetCoordinate(state.setup.center, -180 - index * 70, -140 + index * 75);
    game.seekers[player.id] = {
      playerId: player.id,
      name: player.name,
      coords,
      history: [{ coordinates: coords, timestamp: Date.now() }]
    };
  });

  // Lockdowns are a classic-mode mechanic; the VIP Escort and Safehouses modes don't use them.
  const lockdownsEnabled = game.config.mode === "CLASSIC";
  for (const [index, player] of hiders.entries()) {
    const coords = player.coords || offsetCoordinate(state.setup.center, 160 + index * 65, 120 + index * 50);
    const lockdownCircleGeoJSON = lockdownsEnabled ? circlePolygon(coords, game.config.lockdownRadius) : null;
    const lockdownExpiresAt = lockdownsEnabled ? Date.now() + game.config.lockdownDurationSeconds * 1000 : null;
    const legalAreaGeoJSON = legalArea(game.globalSafeZoneGeoJSON, lockdownCircleGeoJSON);
    const hider: HiderState = {
      playerId: player.id,
      name: player.name,
      coords,
      delayedCoordinates: coords,
      timestampOfCapture: new Date().toISOString(),
      history: [{ coordinates: coords, timestamp: Date.now() }],
      pingCount: 0,
      objectiveIndex: 0,
      activeObjective: {
        id: "pending",
        name: "Pending objective",
        category: "park",
        coordinates: coords,
        source: "fallback"
      },
      activeObjectives: [],
      score: 0,
      caughtAt: null,
      lockdownCircleGeoJSON,
      lastLockdownCircleGeoJSON: lockdownCircleGeoJSON,
      lockdownExpiresAt,
      nextLockdownCircleGeoJSON: null,
      nextLockdownStartsAt: null,
      lockdownTravelStartedAt: null,
      legalAreaGeoJSON,
      proximityStatus: "Distant",
      isOutOfBounds: false,
      oobSamples: 0,
      claims: []
    };
    if (lockdownsEnabled) scheduleNextLockdown(hider, game, startedAt + lockdownCycleMs(game));
    game.hiders[player.id] = hider;
  }

  await applyModeSetup(game);
  return game;
}

const SAFEHOUSE_IDS = ["alpha", "bravo", "charlie"];
const SAFEHOUSE_LABELS = ["Alpha", "Bravo", "Charlie"];

// Per-mode setup run once at game start: assign objectives (classic), pick the VIP and
// anonymization labels (VIP Escort), or auto-select the three safehouses (Safehouses).
async function applyModeSetup(game: GameState) {
  const hiders = Object.values(game.hiders);
  if (!hiders.length) return;

  if (game.config.mode === "VIP_ESCORT") {
    // Stable "Target N" pseudonyms (seeker anonymization), in a deterministic order.
    hiderIdsSorted(game).forEach((playerId, index) => {
      game.hiders[playerId].targetLabel = `Target ${index + 1}`;
    });
    // One random hider becomes the VIP; everyone else is a bodyguard/decoy.
    const vipIndex = Math.floor(Math.random() * hiders.length);
    hiders.forEach((hider, index) => {
      hider.hiderRole = index === vipIndex ? "VIP" : "BODYGUARD";
      hider.activeObjectives = [];
    });
    const vip = hiders[vipIndex];
    await assignRegularObjective(vip, game);
    await syncHiderObjectives(vip, game);
    return;
  }

  if (game.config.mode === "SAFEHOUSES") {
    game.safehouses = await selectSafehouses(game);
    game.totalCaptureSeconds = 0;
    for (const hider of hiders) hider.activeObjectives = [];
    return;
  }

  // CLASSIC — every hider gets their own objective.
  for (const hider of hiders) {
    await assignRegularObjective(hider, game);
    await syncHiderObjectives(hider, game);
  }
}

// Auto-select three distinct landmarks inside the play zone from the existing POI sources
// (Overpass cache → PostGIS → fallback list), spaced apart, and wrap each in a circle polygon.
async function selectSafehouses(game: GameState): Promise<Safehouse[]> {
  const zone = game.globalSafeZoneGeoJSON;
  const radius = game.config.safehouseRadius;
  const candidates: Objective[] = [];
  const seen = new Set<string>();
  const add = (obj: Objective | null | undefined) => {
    if (!obj || seen.has(obj.id) || !containsPoint(zone, obj.coordinates)) return;
    seen.add(obj.id);
    candidates.push(obj);
  };
  for (const obj of overpass.getCached(zone)) add(obj);
  if (db.enabled && candidates.length < 12) {
    for (let attempt = 0; attempt < 60 && candidates.length < 24; attempt += 1) {
      add(await db.findObjectiveInside(zone, OBJECTIVE_CATEGORIES, Math.floor(Math.random() * 1000) + attempt));
    }
  }
  for (const obj of FALLBACK_OBJECTIVES) add(obj);

  const shuffled = candidates.sort(() => Math.random() - 0.5);
  const chosen: Objective[] = [];
  const minSpacing = Math.max(120, radius * 2);
  for (const spacing of [minSpacing, 0]) {
    for (const obj of shuffled) {
      if (chosen.length >= 3) break;
      if (chosen.some(c => c.id === obj.id)) continue;
      if (chosen.every(c => distanceMeters(c.coordinates, obj.coordinates) >= spacing)) chosen.push(obj);
    }
    if (chosen.length >= 3) break;
  }

  return chosen.slice(0, 3).map((objective, index) => ({
    id: SAFEHOUSE_IDS[index],
    label: SAFEHOUSE_LABELS[index],
    objective,
    center: objective.coordinates,
    circleGeoJSON: circlePolygon(objective.coordinates, radius),
    state: "idle" as SafehouseState
  }));
}

function findVip(game: GameState): HiderState | null {
  return Object.values(game.hiders).find(hider => hider.hiderRole === "VIP") || null;
}

function hiderIdsSorted(game: GameState): string[] {
  return Object.keys(game.hiders).sort();
}

function seekerIds(game: GameState): string[] {
  return Object.keys(game.seekers);
}

// Lightweight one-shot toast broadcast to every connected client (seekers + hiders + admin).
function emitAlert(text: string) {
  io.emit("game_alert", { text });
}

// Recompute safehouse occupancy from live coordinates each tick. Returns true when the shared
// capture target is reached (Hider victory). Fires breach/secure alerts on state transitions.
function updateSafehouses(game: GameState): boolean {
  if (!game.safehouses?.length) return false;
  const hiders = Object.values(game.hiders).filter(hider => !hider.caughtAt && !hider.isOutOfBounds);
  const seekers = Object.values(game.seekers);
  const liveCoordsFor = (playerId: string) => state.players[playerId]?.coords || null;
  let anyBreached = false;
  for (const safehouse of game.safehouses) {
    const hidersInside = hiders.some(hider => {
      const coords = liveCoordsFor(hider.playerId);
      return !!coords && containsPoint(safehouse.circleGeoJSON, coords);
    });
    const seekersInside = seekers.some(seeker => {
      const coords = liveCoordsFor(seeker.playerId);
      return !!coords && containsPoint(safehouse.circleGeoJSON, coords);
    });
    const next: SafehouseState = hidersInside && seekersInside ? "contested" : hidersInside ? "breached" : "idle";
    if (next !== safehouse.state) {
      if (next === "breached" && safehouse.state === "idle") {
        emitAlert(`Safehouse ${safehouse.label} is being breached!`);
        push.sendToMany(seekerIds(game), { title: "Safehouse Breach", body: `Safehouse ${safehouse.label} is being breached!`, tag: "safehouse" });
      } else if (next === "idle") {
        emitAlert(`Safehouse ${safehouse.label} is secure.`);
        push.sendToMany(seekerIds(game), { title: "Safehouse Secure", body: `Safehouse ${safehouse.label} is secure.`, tag: "safehouse" });
      }
      safehouse.state = next;
    }
    if (next === "breached") anyBreached = true;
  }
  // Anti-stacking: at most 1 second of capture per elapsed second, regardless of how many
  // hiders or safehouses are breached.
  if (anyBreached) game.totalCaptureSeconds = (game.totalCaptureSeconds || 0) + 1;
  return (game.totalCaptureSeconds || 0) >= game.config.safehouseCaptureTargetSeconds;
}

function ensurePlayerInActiveGame(player: PlayerInternal, game: GameState) {
  if (player.role === "SEEKER" && !game.seekers[player.id]) {
    const coords = player.coords || state.setup.center;
    game.seekers[player.id] = { playerId: player.id, name: player.name, coords, history: [{ coordinates: coords, timestamp: Date.now() }] };
  }
}

function activeGameRole(playerId: string): "HIDER" | "SEEKER" | null {
  if (!state.game || state.game.phase !== "active") return null;
  if (state.game.hiders[playerId]) return "HIDER";
  if (state.game.seekers[playerId]) return "SEEKER";
  return null;
}

async function updateHiderLocation(playerId: string, coords: LngLat, timestamp: number): Promise<boolean> {
  const game = state.game;
  const hider = game?.hiders[playerId];
  if (!game || !hider) return false;
  const lastTimestamp = hider.history[hider.history.length - 1]?.timestamp || 0;
  if (timestamp < lastTimestamp) return false;

  const insideTrue = containsPoint(game.globalSafeZoneGeoJSON, coords);
  const insideBuffered = containsPointWithBuffer(game.globalSafeZoneGeoJSON, coords, 20);
  if (!insideBuffered) {
    hider.oobSamples += 1;
    if (hider.oobSamples >= 3) {
        hider.isOutOfBounds = true;
      game.oobCount += 1;
    }
    return false;
  }
  if (insideTrue) {
    hider.isOutOfBounds = false;
    hider.oobSamples = 0;
    hider.coords = coords;
    hider.history = [...hider.history, { coordinates: coords, timestamp }]
      .filter(item => item.timestamp > Date.now() - 30 * 60 * 1000);
    return true;
  }
  return false;
}

function updateSeekerLocation(playerId: string, coords: LngLat, timestamp: number): boolean {
  const seeker = state.game?.seekers[playerId];
  if (!seeker) return false;
  const lastTimestamp = seeker.history[seeker.history.length - 1]?.timestamp || 0;
  if (timestamp < lastTimestamp) return false;
  seeker.coords = coords;
  seeker.history = [...seeker.history, { coordinates: coords, timestamp }]
    .filter(item => item.timestamp > Date.now() - 30 * 60 * 1000);
  return true;
}

// Shared by the socket `location_update` handler and the Traccar HTTP ingest so both
// sources funnel through the identical bounds-check / history / delay / broadcast path.
async function applyLocationToGame(player: PlayerInternal, coords: LngLat, accuracy: number | null, timestamp = Date.now()) {
  if (player.role === "HIDER") {
    const accepted = await updateHiderLocation(player.id, coords, timestamp);
    if (accepted) {
      player.coords = coords;
      player.accuracy = accuracy;
    }
  }
  if (player.role === "SEEKER") {
    const accepted = updateSeekerLocation(player.id, coords, timestamp);
    if (accepted) {
      player.coords = coords;
      player.accuracy = accuracy;
    }
  }
  await recomputeDerived();
  await saveAndEmit();
}

async function recomputeDerived() {
  const game = state.game;
  if (!game || game.phase !== "active") return;
  const seekers = Object.values(game.seekers);
  for (const hider of Object.values(game.hiders)) {
    if (hider.lockdownExpiresAt && hider.lockdownExpiresAt <= Date.now()) {
      hider.lockdownCircleGeoJSON = null;
      hider.lockdownExpiresAt = null;
      hider.lockdownTravelStartedAt ||= Date.now();
    }
    normalizeHiderState(hider);
    if (game.config.mode === "CLASSIC" && (!hider.nextLockdownCircleGeoJSON || !hider.nextLockdownStartsAt)) {
      scheduleNextLockdown(hider, game, Date.now() + lockdownCycleMs(game));
    }
    expireLockdownObjectives(hider);
    hider.legalAreaGeoJSON = legalArea(game.globalSafeZoneGeoJSON, hider.lockdownCircleGeoJSON);
    const previousProximity = hider.proximityStatus;
    hider.proximityStatus = proximityFor(hider, seekers, game.config);
    if (PROXIMITY_RANK[hider.proximityStatus] > (PROXIMITY_RANK[previousProximity] ?? 0)) {
      push.sendTo(hider.playerId, {
        title: "Seeker Closing In",
        body: `A seeker is getting closer — proximity now ${hider.proximityStatus}.`,
        tag: "proximity"
      });
    }
    const delayed = delayedCoordinate(hider.history, game.config.locationDelayMinutes);
    hider.delayedCoordinates = delayed.coordinates;
    hider.timestampOfCapture = new Date(delayed.timestamp).toISOString();
    await syncHiderObjectives(hider, game);
  }
}

function gameSecondsRemaining(game: GameState): number | null {
  const minutes = game.config.gameDurationMinutes;
  if (!minutes || minutes <= 0) return null;
  return Math.max(0, Math.round((game.startedAt + minutes * 60 * 1000 - Date.now()) / 1000));
}

async function boundaryTick() {
  const game = state.game;
  if (!game || game.phase !== "active" || game.paused) return;
  // Time limit reached. In classic/VIP the hiders survived and win; in Safehouses the hiders
  // failed to bank enough capture time, so the seekers win.
  if (gameSecondsRemaining(game) === 0) {
    await finishGame(game.config.mode === "SAFEHOUSES" ? "SEEKERS" : "HIDERS");
    await saveAndEmit();
    return;
  }
  // Safehouses: accumulate shared capture time and fire breach/secure alerts.
  if (game.config.mode === "SAFEHOUSES" && updateSafehouses(game)) {
    await finishGame("HIDERS");
    await saveAndEmit();
    return;
  }
  // Safehouses are FIXED landmarks, so shrinking the zone past one would make it permanently
  // uncapturable (a hider on it reads as out-of-bounds). The global shrink is a classic/VIP
  // pressure mechanic only.
  if (game.config.mode !== "SAFEHOUSES") {
    game.shrinkCountdown -= 1;
    if (game.shrinkCountdown <= 0) {
      game.globalSafeZoneGeoJSON = shrinkGlobalZone(
        game.globalSafeZoneGeoJSON,
        Object.values(game.seekers),
        game.config.globalSqueezePercentage
      );
      for (const hider of Object.values(game.hiders)) {
        hider.legalAreaGeoJSON = legalArea(game.globalSafeZoneGeoJSON, hider.lockdownCircleGeoJSON);
      }
      game.shrinkCountdown = game.config.shrinkIntervalSeconds;
    }
  }
  await recomputeDerived();
  await saveAndEmit();
}

async function seekerPingTick() {
  const game = state.game;
  if (!game || game.phase !== "active" || game.paused) return;
  const intervalMs = game.config.pingIntervalMinutes * 60 * 1000;
  if (Date.now() - lastSeekerPingAt < intervalMs) return;
  lastSeekerPingAt = Date.now();
  for (const hider of Object.values(game.hiders)) {
    hider.pingCount += 1;
    if (game.config.mode === "CLASSIC" && hider.pingCount % game.config.lockdownIntervalCount === 0) {
      const lockdownCircle = hider.nextLockdownCircleGeoJSON || forecastLockdownCircle(hider, game);
      hider.lockdownCircleGeoJSON = lockdownCircle;
      hider.lastLockdownCircleGeoJSON = lockdownCircle;
      hider.lockdownExpiresAt = Date.now() + game.config.lockdownDurationSeconds * 1000;
      hider.lockdownTravelStartedAt = null;
      hider.legalAreaGeoJSON = legalArea(game.globalSafeZoneGeoJSON, lockdownCircle);
      // Any active objective now caught inside the new lockdown zone gets the lockdown score.
      for (const slot of hider.activeObjectives || []) {
        if (containsPoint(lockdownCircle, slot.objective.coordinates)) slot.scoreValue = game.config.lockdownObjectivePoints;
      }
      scheduleNextLockdown(hider, game, Date.now() + lockdownCycleMs(game));
      push.sendTo(hider.playerId, {
        title: "Lockdown Zone Active",
        body: "A new lockdown zone has appeared. Reach it for bonus points.",
        tag: "lockdown"
      });
    }
  }
  await recomputeDerived();
  await saveAndEmit();
}

function adminPayload(): AdminStatePayload {
  const game = state.game
    ? {
        ...state.game,
        hiders: Object.values(state.game.hiders).map(({ proximityStatus: _hidden, ...hider }) => hider),
        seekers: Object.values(state.game.seekers)
      }
    : null;
  return {
    phase: state.phase,
    roster: roster(),
    setup: state.setup,
    game,
    winner: state.winner,
    history: state.history || []
  };
}

function hiderPayload(playerId: string): HiderStatusPayload {
  const game = state.game;
  const hider = game?.hiders[playerId] || null;
  if (!hider || !game) {
    return { phase: state.phase, roster: roster(), gameId: game?.id || null, me: null };
  }
  const mode = game.config.mode;
  const isVip = mode === "VIP_ESCORT";
  const isSafehouse = mode === "SAFEHOUSES";
  const vip = isVip ? findVip(game) : null;
  const mirror = isVip && hider.hiderRole === "BODYGUARD" && !!vip;
  // VIP Escort + Safehouses: hiders see their teammates' live positions.
  const teammates = (isVip || isSafehouse)
    ? Object.values(game.hiders)
        .filter(other => other.playerId !== hider.playerId)
        .map(other => ({ hiderId: other.playerId, name: other.name, hiderRole: other.hiderRole, coordinates: other.coords }))
    : undefined;
  return {
    phase: state.phase,
    roster: roster(),
    gameId: game.id,
    me: {
      hiderId: hider.playerId,
      name: hider.name,
      coordinates: hider.coords,
      proximityStatus: hider.proximityStatus,
      globalSafeZoneGeoJSON: game.globalSafeZoneGeoJSON,
      myLockdownCircleGeoJSON: hider.lockdownCircleGeoJSON,
      nextLockdownCircleGeoJSON: hider.nextLockdownCircleGeoJSON,
      lockdownExpiresAt: hider.lockdownExpiresAt,
      nextLockdownStartsAt: hider.nextLockdownStartsAt,
      lockdownTravelStartedAt: hider.lockdownTravelStartedAt,
      legalAreaGeoJSON: hider.legalAreaGeoJSON,
      activeObjective: mirror ? vip!.activeObjective : hider.activeObjective,
      activeObjectives: mirror ? vip!.activeObjectives : hider.activeObjectives,
      score: hider.score,
      isOutOfBounds: hider.isOutOfBounds,
      shrinkCountdown: game.shrinkCountdown,
      gameSecondsRemaining: gameSecondsRemaining(game),
      config: game.config,
      mode,
      hiderRole: hider.hiderRole,
      teammates,
      safehouses: isSafehouse ? game.safehouses : undefined,
      totalCaptureSeconds: isSafehouse ? (game.totalCaptureSeconds || 0) : undefined,
      captureTargetSeconds: isSafehouse ? game.config.safehouseCaptureTargetSeconds : undefined
    }
  };
}

function seekerPayload(): SeekerPingPayload {
  const game = state.game;
  const mode = game?.config.mode || "CLASSIC";
  const isSafehouse = !!game && mode === "SAFEHOUSES";
  // VIP Escort: every hider is anonymized and shown the SAME (the VIP's) objective so the VIP
  // is indistinguishable from a bodyguard.
  const vip = game && mode === "VIP_ESCORT" ? findVip(game) : null;
  return {
    phase: state.phase,
    roster: roster(),
    globalSafeZoneGeoJSON: game?.globalSafeZoneGeoJSON || null,
    gameSecondsRemaining: game ? gameSecondsRemaining(game) : null,
    mode,
    safehouses: isSafehouse ? game!.safehouses : undefined,
    totalCaptureSeconds: isSafehouse ? (game!.totalCaptureSeconds || 0) : undefined,
    captureTargetSeconds: isSafehouse ? game!.config.safehouseCaptureTargetSeconds : undefined,
    seekers: game ? Object.values(game.seekers).map(s => ({ playerId: s.playerId, name: s.name, coordinates: s.coords })) : [],
    hiders: game ? Object.values(game.hiders).map(h => {
      const obj = (vip || h).activeObjective;
      return {
        hiderId: h.playerId,
        name: vip ? (h.targetLabel || "Target") : h.name,
        delayedCoordinates: h.delayedCoordinates,
        delayedTrail: delayedTrail(h.history, game.config.locationDelayMinutes, 120),
        timestampOfCapture: h.timestampOfCapture,
        lockdownCircleGeoJSON: h.lockdownCircleGeoJSON,
        nextLockdownCircleGeoJSON: null,
        activeObjective: {
          id: obj.id,
          name: obj.name,
          category: obj.category,
          coordinates: obj.coordinates
        },
        activeObjectives: vip ? vip.activeObjectives : h.activeObjectives
      };
    }) : []
  };
}

function normalizeHiderState(hider: HiderState) {
  hider.activeObjectives ||= hider.activeObjective ? [{
    slotId: `legacy-${hider.activeObjective.id}`,
    kind: "regular",
    objective: hider.activeObjective,
    scoreValue: 1,
    createdAt: Date.now(),
    expiresAt: null
  }] : [];
  hider.score ||= hider.claims?.filter(claim => claim.status === "accepted").reduce((sum, claim) => sum + (claim.scoreValue || 1), 0) || 0;
  hider.caughtAt ||= null;
  hider.lastLockdownCircleGeoJSON ||= hider.lockdownCircleGeoJSON;
  hider.nextLockdownCircleGeoJSON ||= null;
  hider.nextLockdownStartsAt ||= null;
  hider.lockdownTravelStartedAt ||= null;
  if (!hider.activeObjective && hider.activeObjectives[0]) hider.activeObjective = hider.activeObjectives[0].objective;
}

async function syncHiderObjectives(hider: HiderState, game: GameState) {
  // Safehouses: the three safehouses are the only objectives — hiders hold no personal slot.
  if (game.config.mode === "SAFEHOUSES") {
    hider.activeObjectives = [];
    return;
  }
  // VIP Escort: only the VIP carries objectives; bodyguards mirror the VIP's current target.
  if (game.config.mode === "VIP_ESCORT" && hider.hiderRole === "BODYGUARD") {
    hider.activeObjectives = [];
    const vip = findVip(game);
    if (vip) hider.activeObjective = vip.activeObjective;
    return;
  }
  normalizeHiderState(hider);
  expireLockdownObjectives(hider);
  const regular = hider.activeObjectives.find(slot => slot.kind === "regular");
  if (!regular || !containsPoint(game.globalSafeZoneGeoJSON, regular.objective.coordinates)) {
    hider.activeObjectives = hider.activeObjectives.filter(slot => slot.kind !== "regular");
    await assignRegularObjective(hider, game);
  }
  await ensureLockdownObjective(hider, game);
  hider.activeObjective = hider.activeObjectives.find(slot => slot.kind === "regular")?.objective
    || hider.activeObjectives[0]?.objective
    || {
      id: `fallback-empty-${hider.playerId}`,
      name: "Awaiting Objective",
      category: "park" as const,
      coordinates: hider.coords,
      source: "fallback" as const
    };
}

function expireLockdownObjectives(hider: HiderState) {
  const now = Date.now();
  hider.activeObjectives = (hider.activeObjectives || []).filter(slot => !slot.expiresAt || slot.expiresAt > now);
}

async function assignRegularObjective(hider: HiderState, game: GameState) {
  const objective = await nextObjectiveFor(hider, game, "regular", game.globalSafeZoneGeoJSON, hider.lastLockdownCircleGeoJSON);
  const existing = hider.activeObjectives.filter(slot => slot.kind !== "regular");
  // No real feature available yet (e.g. Overpass warming up) — keep other slots and retry next sync.
  if (!objective) {
    hider.activeObjectives = existing.slice(0, 2);
    return;
  }
  hider.activeObjectives = [{
    slotId: id("obj"),
    kind: "regular" as const,
    objective,
    scoreValue: game.config.regularObjectivePoints,
    createdAt: Date.now(),
    expiresAt: null
  }, ...existing].slice(0, 2);
  hider.activeObjective = objective;
}

async function ensureLockdownObjective(hider: HiderState, game: GameState) {
  if (!hider.lockdownCircleGeoJSON || !hider.lockdownExpiresAt) {
    hider.activeObjectives = hider.activeObjectives.filter(slot => slot.kind !== "lockdown");
    return;
  }
  const regular = hider.activeObjectives.find(slot => slot.kind === "regular");
  if (!regular || containsPoint(hider.lockdownCircleGeoJSON, regular.objective.coordinates)) {
    hider.activeObjectives = hider.activeObjectives.filter(slot => slot.kind !== "lockdown");
    return;
  }
  if (hider.activeObjectives.some(slot => slot.kind === "lockdown")) return;
  const lockdownArea = legalArea(game.globalSafeZoneGeoJSON, hider.lockdownCircleGeoJSON);
  const objective = await nextObjectiveFor(hider, game, "lockdown", lockdownArea, null);
  if (!objective) return; // no real feature inside the lockdown yet — retry next sync
  hider.activeObjectives = [
    ...hider.activeObjectives.filter(slot => slot.kind !== "lockdown"),
    {
      slotId: id("obj"),
      kind: "lockdown" as const,
      objective,
      scoreValue: game.config.lockdownObjectivePoints,
      createdAt: Date.now(),
      expiresAt: hider.lockdownExpiresAt
    }
  ].slice(0, 2);
}

// Pick a real map feature inside `area` (and outside `outsideArea`) that no other hider holds.
// Prefers features within the admin's spawn-distance band from the hider, relaxing it only if
// nothing real fits. Returns null if nothing real is available yet (e.g. Overpass warming up).
async function nextObjectiveFor(
  hider: HiderState,
  game: GameState,
  _kind: ObjectiveSlot["kind"],
  area: Feature<Polygon>,
  outsideArea: Feature<Polygon> | null
): Promise<Objective | null> {
  const used = activeObjectiveIds(game);
  const blocked = (obj: Objective) =>
    used.has(obj.id) ||
    !containsPoint(area, obj.coordinates) ||
    (!!outsideArea && containsPoint(outsideArea, obj.coordinates));
  const { objectiveMinDistance, objectiveMaxDistance } = game.config;
  const outOfBand = (obj: Objective) => {
    const d = distanceMeters(hider.coords, obj.coordinates);
    return d < objectiveMinDistance || d > objectiveMaxDistance;
  };
  return (await pickObjective(hider, area, obj => blocked(obj) || outOfBand(obj)))
    ?? (await pickObjective(hider, area, blocked));
}

// Resolve a single objective from the source chain (seeded PostGIS → live Overpass → fallback
// landmarks) skipping any candidate the `reject` predicate excludes.
async function pickObjective(
  hider: HiderState,
  area: Feature<Polygon>,
  reject: (obj: Objective) => boolean
): Promise<Objective | null> {
  if (db.enabled) {
    const start = Math.floor(Math.random() * 1000) + hider.objectiveIndex;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const obj = await db.findObjectiveInside(area, OBJECTIVE_CATEGORIES, start + attempt);
      if (!obj) break;
      if (!reject(obj)) return obj;
    }
  }
  const live = overpass.getCached(area).filter(obj => !reject(obj));
  if (live.length) return live[Math.floor(Math.random() * live.length)];
  const fallback = FALLBACK_OBJECTIVES.filter(obj => !reject(obj));
  if (fallback.length) return fallback[Math.floor(Math.random() * fallback.length)];
  return null;
}

// Every objective currently assigned to any hider, so each hider receives a distinct objective.
function activeObjectiveIds(game: GameState) {
  const used = new Set<string>();
  for (const hider of Object.values(game.hiders)) {
    for (const slot of hider.activeObjectives || []) used.add(slot.objective.id);
  }
  return used;
}

function findObjectiveSlot(hider: HiderState, slotId: string, objectiveId: string) {
  return (hider.activeObjectives || []).find(slot =>
    (slotId && slot.slotId === slotId) || (objectiveId && slot.objective.id === objectiveId)
  ) || null;
}

function leaderboardEntry(hider: HiderState): LeaderboardEntry {
  return {
    playerId: hider.playerId,
    name: hider.name,
    score: hider.score || 0,
    caughtAt: hider.caughtAt,
    becameSeekerAt: hider.caughtAt
  };
}

function buildLeaderboard(game: GameState): LeaderboardEntry[] {
  const entries = new Map<string, LeaderboardEntry>();
  for (const item of game.leaderboard || []) entries.set(item.playerId, item);
  for (const hider of Object.values(game.hiders)) entries.set(hider.playerId, leaderboardEntry(hider));
  return Array.from(entries.values()).sort((a, b) => b.score - a.score || (a.caughtAt || Number.MAX_SAFE_INTEGER) - (b.caughtAt || Number.MAX_SAFE_INTEGER));
}

function syncHistoryClaimDisallow(claim: ClaimRecord) {
  if (!state.game || state.game.phase !== "ended") return;
  let changed = false;
  for (const entry of state.history || []) {
    if (entry.id !== state.game.id) continue;
    const historyClaim = entry.claims.find(item => item.id === claim.id);
    if (historyClaim) {
      historyClaim.status = claim.status;
      historyClaim.reason = claim.reason;
      historyClaim.disallowedAt = claim.disallowedAt;
      changed = true;
    }
    const leaderboardEntry = entry.hiders.find(item => item.playerId === claim.hiderId);
    if (leaderboardEntry && claim.status === "disallowed") {
      leaderboardEntry.score = Math.max(0, leaderboardEntry.score - (claim.scoreValue || 1));
      changed = true;
    }
  }
  if (changed) writeHistoryFile(state.history || []);
}

async function finishGame(winner: "HIDERS" | "SEEKERS") {
  const game = state.game;
  if (!game || game.phase === "ended") return;
  state.phase = "ended";
  state.winner = winner;
  game.phase = "ended";
  game.endedAt = Date.now();
  game.leaderboard = buildLeaderboard(game);
  const historyEntry: GameHistoryEntry = {
    id: game.id,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    durationSeconds: Math.max(0, Math.round((game.endedAt - game.startedAt) / 1000)),
    hiders: game.leaderboard,
    seekers: Object.values(game.seekers).map(seeker => ({ playerId: seeker.playerId, name: seeker.name })),
    claims: game.claims
  };
  state.history = [historyEntry, ...(state.history || []).filter(item => item.id !== game.id)];
  writeHistoryFile(state.history);
  io.emit("game_over", { winner, leaderboard: game.leaderboard, durationSeconds: historyEntry.durationSeconds, historyEntry });
}

function readHistoryFile(): GameHistoryEntry[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed as GameHistoryEntry[] : [];
  } catch (err) {
    console.warn("[history] could not read history file", err instanceof Error ? err.message : err);
    return [];
  }
}

function writeHistoryFile(history: GameHistoryEntry[]) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function touchPlayer(playerId: string | undefined, socketId: string) {
  if (!playerId) return false;
  const player = state.players[playerId];
  if (!player) return false;
  const wasOnline = player.online;
  const socketCount = player.sockets?.length || 0;
  player.lastSeen = Date.now();
  player.online = true;
  player.sockets = Array.from(new Set([...(player.sockets || []), socketId]));
  return !wasOnline || player.sockets.length !== socketCount;
}

async function stalePlayerTick() {
  let changed = false;
  const now = Date.now();
  for (const player of Object.values(state.players)) {
    const sockets = player.sockets || [];
    const liveSockets = sockets.filter(socketId => io.sockets.sockets.has(socketId));
    if (liveSockets.length !== sockets.length) {
      player.sockets = liveSockets;
      changed = true;
    }

    const lastSeen = player.lastSeen || player.joinedAt || 0;
    const isStale = now - lastSeen > PLAYER_STALE_MS;
    if (isStale) {
      for (const socketId of liveSockets) io.sockets.sockets.get(socketId)?.disconnect(true);
      if (player.sockets.length) {
        player.sockets = [];
        changed = true;
      }
    }

    const online = !isStale && player.sockets.length > 0;
    if (player.online !== online) {
      player.online = online;
      changed = true;
    }
  }
  // Before the game starts, automatically drop devices that have gone offline.
  if (state.phase !== "active" && removeOfflinePlayers(PLAYER_OFFLINE_PRUNE_MS)) changed = true;
  if (changed) await saveAndEmit();
}

let lastRosterSignature = "";

async function saveAndEmit() {
  await store.save(state);
  io.to("admins").emit("state_admin", adminPayload());
  for (const player of Object.values(state.players)) {
    if (player.role === "HIDER") {
      player.sockets.forEach(socketId => io.to(socketId).emit("status_update", hiderPayload(player.id)));
    }
    if (player.role === "SEEKER") {
      player.sockets.forEach(socketId => io.to(socketId).emit("ping_broadcast", seekerPayload()));
    }
  }
  // The shrink timer drives ~1 emit/sec; only broadcast the roster when it actually changed.
  const currentRoster = roster();
  const rosterSignature = JSON.stringify(currentRoster.map(p => [p.id, p.role, p.online, p.name]));
  if (rosterSignature !== lastRosterSignature) {
    lastRosterSignature = rosterSignature;
    io.emit("roster_update", currentRoster);
  }
}

function roster(): PlayerPublic[] {
  return Object.values(state.players).map(player => ({
    id: player.id,
    name: player.name,
    role: player.role,
    online: player.online,
    joinedAt: player.joinedAt,
    lastSeen: player.lastSeen
  }));
}

function removePlayer(playerId: string | undefined) {
  if (!playerId || !state.players[playerId]) return;
  delete state.players[playerId];
  push.unregister(playerId);
  if (state.game) {
    delete state.game.seekers[playerId];
    delete state.game.hiders[playerId];
  }
}

function removeOfflinePlayers(graceMs = 0): boolean {
  const now = Date.now();
  let changed = false;
  for (const player of Object.values(state.players)) {
    if (player.role === "ADMIN") continue;
    if ((player.sockets?.length || 0) > 0) continue;
    const lastSeen = player.lastSeen || player.joinedAt || 0;
    if (now - lastSeen < graceMs) continue;
    delete state.players[player.id];
    push.unregister(player.id);
    changed = true;
  }
  return changed;
}

function disconnectAllPlayers(exceptPlayerId?: string): number {
  let removed = 0;
  for (const player of Object.values(state.players)) {
    if (player.id === exceptPlayerId || player.role === "ADMIN") continue;
    for (const socketId of player.sockets || []) {
      io.sockets.sockets.get(socketId)?.disconnect(true);
    }
    delete state.players[player.id];
    push.unregister(player.id);
    removed += 1;
  }
  return removed;
}

function requireAdmin(socket: { data: { isAdmin?: boolean } }, ack: (value: unknown) => void) {
  if (socket.data.isAdmin) return true;
  ack({ ok: false, error: "admin_required" });
  return false;
}

function cleanName(name: string) {
  return String(name || "Player").trim().slice(0, 32) || "Player";
}

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseLocationTimestamp(value: unknown): number {
  const fallback = Date.now();
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    return Math.min(fallback, Math.max(0, milliseconds));
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.min(fallback, Math.max(0, parsed)) : fallback;
}

function lockdownCycleMs(game: GameState) {
  return game.config.pingIntervalMinutes * 60 * 1000 * game.config.lockdownIntervalCount;
}

function scheduleNextLockdown(hider: HiderState, game: GameState, startsAt: number) {
  hider.nextLockdownCircleGeoJSON = forecastLockdownCircle(hider, game);
  hider.nextLockdownStartsAt = startsAt;
}

function forecastLockdownCircle(hider: HiderState, game: GameState) {
  const edgeDistance = Math.random() * game.config.lockdownForecastDistance;
  const centerDistance = game.config.lockdownRadius + edgeDistance;
  const bearing = Math.random() * 360;
  return circlePolygon(destinationCoordinate(hider.coords, centerDistance, bearing), game.config.lockdownRadius);
}

function destinationCoordinate(origin: LngLat, distanceMetersValue: number, bearingDegrees: number): LngLat {
  const bearing = bearingDegrees * Math.PI / 180;
  const north = Math.cos(bearing) * distanceMetersValue;
  const east = Math.sin(bearing) * distanceMetersValue;
  return offsetCoordinate(origin, north, east);
}

function offsetCoordinate([lon, lat]: LngLat, northMeters: number, eastMeters: number): LngLat {
  const nextLat = lat + northMeters / 111320;
  const nextLon = lon + eastMeters / (111320 * Math.cos(lat * Math.PI / 180));
  return [nextLon, nextLat];
}

function noop(_value?: unknown) {
  return undefined;
}

async function boot() {
  push.init();
  await db.migrate();
  await store.connect(process.env.REDIS_URL);
  state = await store.load();
  state.history = state.history?.length ? state.history : readHistoryFile();
  state.setup.config = normalizeConfig(state.setup.config);
  if (state.game) {
    state.game.config = normalizeConfig(state.game.config);
    state.game.endedAt ||= null;
    state.game.leaderboard ||= [];
    for (const hider of Object.values(state.game.hiders || {})) normalizeHiderState(hider);
  }
  for (const player of Object.values(state.players)) {
    player.sockets = [];
    player.online = false;
  }
  await store.save(state);

  // Start warming the objective cache for the configured play area so the first game starts hot.
  void overpass.getCached(state.setup.globalSafeZoneGeoJSON);

  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get("*", (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
  } else {
    app.get("*", (_req, res) => {
      res.status(503).send("Client build missing. Run npm run build, or use npm run client:dev during development.");
    });
  }

  setInterval(() => void boundaryTick(), 1000);
  setInterval(() => void seekerPingTick(), 1000);
  setInterval(() => void stalePlayerTick(), PLAYER_STALE_SWEEP_MS);

  server.listen(PORT, () => {
    console.log(`[urban-hunt] listening on http://localhost:${PORT}`);
  });
}

function normalizeConfig(config: Partial<typeof DEFAULT_CONFIG> = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    proximityThresholds: {
      ...DEFAULT_CONFIG.proximityThresholds,
      ...config.proximityThresholds
    }
  };
}

void boot();
