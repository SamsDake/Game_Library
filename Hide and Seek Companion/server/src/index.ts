import express from "express";
import type { Request, Response } from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { Server } from "socket.io";
import type {
  AdminConfigPayload,
  AppState,
  GameConfig,
  GameState,
  HiderRunState,
  JoinGamePayload,
  PlayerInternal,
  PlayerPublic,
  ProofRecord,
  SelectRolePayload,
  SetReadyPayload
} from "../../shared/types";
import { OBJECTIVE_CATEGORIES } from "../../shared/poi-categories";
import { distanceMeters } from "./geo";
import { StateStore } from "./state-store";
import { estimateAvailable, loadedRegions, loadRegions } from "./poi-index";
import { generateRoute } from "./route-gen";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || "data/uploads");
const STATE_FILE = path.resolve(ROOT, process.env.STATE_FILE || "data/state.json");
const CLIENT_DIST = path.resolve(ROOT, "client/dist");
const PUBLIC_BASE_PATH = normalizeBasePath(process.env.APP_BASE_PATH || "/hide-and-seek/");
const CLAIM_RADIUS_M = 40;
const PLAYER_STALE_SWEEP_MS = 10 * 1000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!process.env.ADMIN_PIN) console.warn("[hide-and-seek] ADMIN_PIN not set; using development PIN 1234.");

const DEFAULT_CONFIG: GameConfig = {
  centerLat: 51.5074,
  centerLng: -0.1278,
  radiusM: 1500,
  objectiveCount: 6,
  minDistanceM: 300,
  maxDistanceM: 900,
  totalMinutes: 30,
  categories: [...OBJECTIVE_CATEGORIES]
};

const initialState = (): AppState => ({
  phase: "lobby",
  config: DEFAULT_CONFIG,
  players: {},
  game: null
});

const store = new StateStore(initialState(), STATE_FILE);
let state: AppState = store.load();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 15 * 1024 * 1024, cors: { origin: true } });

let countdownInterval: NodeJS.Timeout | null = null;

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const gameId = state.game?.id || "pending";
    const dir = path.join(UPLOAD_DIR, gameId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    cb(null, `${id("proof")}${ext}`);
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
const uploadProofPhoto = upload.single("photo");

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
app.use((req, _res, next) => {
  if (PUBLIC_BASE_PATH && (req.url === PUBLIC_BASE_PATH || req.url.startsWith(`${PUBLIC_BASE_PATH}/`))) {
    req.url = req.url.slice(PUBLIC_BASE_PATH.length) || "/";
  }
  next();
});
app.use(express.json());
app.use("/uploads", express.static(UPLOAD_DIR));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, phase: state.phase, players: Object.keys(state.players).length, preloadedRegions: loadedRegions() });
});

app.get("/api/objectives/estimate", (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusM = Number(req.query.radiusM);
  const categories = String(req.query.categories || "").split(",").filter(c => (OBJECTIVE_CATEGORIES as string[]).includes(c));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusM) || !categories.length) {
    res.status(400).json({ ok: false, error: "invalid_params" });
    return;
  }
  const estimate = estimateAvailable([lng, lat], radiusM, categories as GameConfig["categories"]);
  res.json({ ok: true, estimate });
});

app.post("/api/proofs", (req, res) => {
  uploadProofPhoto(req, res, err => {
    if (err) {
      const error = err instanceof multer.MulterError
        ? (err.code === "LIMIT_FILE_SIZE" ? "photo_too_large" : "invalid_photo")
        : err instanceof Error && err.message === "invalid_photo_type"
          ? "invalid_photo_type"
          : "invalid_photo";
      res.status(400).json({ ok: false, error });
      return;
    }
    handleProof(req, res);
  });
});

function handleProof(req: Request, res: Response) {
  const { playerId, playerSecret, lat, lng } = req.body;
  const objectiveIndex = Number(req.body.objectiveIndex);
  const player = state.players[playerId];
  const game = state.game;
  const hider = game?.hiders[playerId];

  const fail = (status: number, error: string) => {
    if (req.file) fs.rm(req.file.path, { force: true }, () => undefined);
    res.status(status).json({ ok: false, error });
  };

  if (!game || game.phase !== "active") return fail(409, "game_not_active");
  if (!player || player.role !== "HIDE" || player.secret !== playerSecret) return fail(403, "invalid_player");
  if (!hider) return fail(404, "hider_not_found");
  if (hider.caughtAt) return fail(409, "hider_caught");
  if (!req.file) return fail(400, "photo_required");
  if (!Number.isFinite(objectiveIndex) || objectiveIndex !== hider.objectiveIndex) return fail(409, "objective_changed");
  const objective = game.route[objectiveIndex];
  if (!objective) return fail(409, "no_current_objective");
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return fail(422, "location_unavailable");
  const distance = distanceMeters([lngNum, latNum], objective.coordinates);
  if (distance > CLAIM_RADIUS_M) return fail(422, "too_far_from_objective");

  const proofId = path.basename(req.file.filename, path.extname(req.file.filename));
  const proof: ProofRecord = {
    id: proofId,
    hiderId: playerId,
    hiderName: player.name,
    objectiveIndex,
    objective,
    photoUrl: `/uploads/${game.id}/${req.file.filename}`,
    submittedAt: Date.now()
  };
  hider.proofs.push(proof);
  game.allProofs.push(proof);
  hider.objectiveIndex += 1;

  saveState();
  io.emit("proof_accepted", { proof, hiderId: playerId });
  res.json({ ok: true, proof, nextObjectiveIndex: hider.objectiveIndex, allDone: hider.objectiveIndex >= game.route.length });
}

io.on("connection", socket => {
  socket.emit("lobby_update", lobbyPayload());

  socket.on("join_game", (payload: JoinGamePayload, ack = noop) => {
    const role = payload.role ?? null;
    if (role && !["HIDE", "SEEK", "ADMIN"].includes(role)) return ack({ ok: false, error: "invalid_role" });
    if (role === "ADMIN" && String(payload.adminPin || "") !== ADMIN_PIN) {
      return ack({ ok: false, error: "invalid_admin_pin" });
    }

    const existing = payload.playerId && state.players[payload.playerId]?.secret === payload.playerSecret
      ? state.players[payload.playerId]
      : null;

    // A socket maps to a single active identity. If this socket was previously attached to a
    // different player (e.g. switching from HIDE to ADMIN in the same tab), drop that stale
    // association so it doesn't linger as a ghost roster entry.
    const previousPlayerId = socket.data.playerId;
    if (previousPlayerId && previousPlayerId !== existing?.id) {
      const previous = state.players[previousPlayerId];
      if (previous) {
        previous.sockets = previous.sockets.filter(socketId => socketId !== socket.id);
        if (previous.sockets.length) previous.online = true;
        else delete state.players[previousPlayerId];
      }
    }

    const player: PlayerInternal = existing || {
      id: id("p"),
      secret: id("secret"),
      joinedAt: Date.now(),
      sockets: [],
      online: false,
      role: null,
      ready: false,
      name: "Player"
    };
    player.name = cleanName(payload.name || player.name);
    if (role) player.role = role;
    player.online = true;
    player.sockets = Array.from(new Set([...(player.sockets || []), socket.id]));
    state.players[player.id] = player;
    socket.data.playerId = player.id;
    socket.data.isAdmin = player.role === "ADMIN";
    if (player.role === "ADMIN") socket.join("admins");

    saveState();
    broadcastLobby();
    ack({ ok: true, playerId: player.id, playerSecret: player.secret, role: player.role });
  });

  socket.on("select_role", (payload: SelectRolePayload, ack = noop) => {
    const player = state.players[socket.data.playerId];
    if (!player) return ack({ ok: false, error: "not_joined" });
    if (state.phase !== "lobby") return ack({ ok: false, error: "game_in_progress" });
    if (!["HIDE", "SEEK"].includes(payload.role)) return ack({ ok: false, error: "invalid_role" });
    player.role = payload.role;
    player.ready = false;
    saveState();
    broadcastLobby();
    ack({ ok: true });
  });

  socket.on("set_ready", (payload: SetReadyPayload, ack = noop) => {
    const player = state.players[socket.data.playerId];
    if (!player) return ack({ ok: false, error: "not_joined" });
    if (!player.role || player.role === "ADMIN") return ack({ ok: false, error: "role_required" });
    player.ready = !!payload.ready;
    saveState();
    broadcastLobby();
    ack({ ok: true });
  });

  socket.on("admin_update_config", (payload: AdminConfigPayload, ack = noop) => {
    if (!requireAdmin(socket, ack)) return;
    state.config = applyConfig(state.config, payload);
    saveState();
    const estimate = estimateAvailable([state.config.centerLng, state.config.centerLat], state.config.radiusM, state.config.categories);
    broadcastLobby();
    ack({ ok: true, config: state.config, estimate });
  });

  socket.on("admin_start_game", (_payload = {}, ack = noop) => {
    if (!requireAdmin(socket, ack)) return;
    if (state.phase !== "lobby") return ack({ ok: false, error: "game_already_active" });
    removeOfflinePlayers();
    const hiders = Object.values(state.players).filter(p => p.role === "HIDE");
    const seekers = Object.values(state.players).filter(p => p.role === "SEEK");
    if (!hiders.length || !seekers.length) return ack({ ok: false, error: "need_hider_and_seeker" });
    const connectedNonAdmins = Object.values(state.players).filter(p => p.role !== "ADMIN" && p.online);
    const notReady = connectedNonAdmins.some(p => !p.role || !p.ready);
    if (notReady) return ack({ ok: false, error: "not_all_ready" });
    if (!loadedRegions().length) return ack({ ok: false, error: "no_poi_data_for_region" });

    const result = generateRoute(state.config);
    if ("error" in result) return ack({ ok: false, error: result.error });

    const gameHiders: Record<string, HiderRunState> = {};
    for (const player of hiders) {
      gameHiders[player.id] = { playerId: player.id, name: player.name, objectiveIndex: 0, caughtAt: null, proofs: [] };
    }
    const game: GameState = {
      id: id("game"),
      phase: "countdown",
      route: result.route,
      config: { ...state.config },
      startedAt: null,
      countdownStartedAt: Date.now(),
      endsAt: null,
      endedAt: null,
      endReason: null,
      hiders: gameHiders,
      seekerIds: seekers.map(p => p.id),
      allProofs: []
    };
    state.phase = "countdown";
    state.game = game;
    saveState();
    startCountdown();
    ack({ ok: true });
  });

  socket.on("hider_caught", (_payload = {}, ack = noop) => {
    const playerId = socket.data.playerId;
    const player = state.players[playerId];
    const game = state.game;
    const hider = game?.hiders[playerId];
    if (!player || !game || game.phase !== "active" || !hider) return ack({ ok: false, error: "not_active" });
    if (player.role !== "HIDE" || hider.caughtAt) return ack({ ok: false, error: "not_hider" });

    hider.caughtAt = Date.now();
    saveState();
    io.emit("player_caught", { playerId, name: player.name });
    if (Object.values(game.hiders).every(h => h.caughtAt)) finishGame("caught");
    ack({ ok: true });
  });

  socket.on("admin_reset", (_payload = {}, ack = noop) => {
    if (!requireAdmin(socket, ack)) return;
    stopCountdown();
    state.phase = "lobby";
    state.game = null;
    for (const player of Object.values(state.players)) {
      if (player.role === "ADMIN") continue;
      player.role = null;
      player.ready = false;
    }
    saveState();
    io.emit("force_reset");
    broadcastLobby();
    ack({ ok: true });
  });

  socket.on("disconnect", () => {
    const player = state.players[socket.data.playerId];
    if (!player) return;
    player.sockets = player.sockets.filter(socketId => socketId !== socket.id);
    player.online = player.sockets.length > 0;
    saveState();
    broadcastLobby();
  });
});

function applyConfig(current: GameConfig, payload: AdminConfigPayload): GameConfig {
  const centerLat = clampNumber(payload.centerLat, current.centerLat, -90, 90);
  const centerLng = clampNumber(payload.centerLng, current.centerLng, -180, 180);
  const radiusM = clampNumber(payload.radiusM, current.radiusM, 500, 5000);
  const minDistanceM = clampNumber(payload.minDistanceM, current.minDistanceM, 100, 2000);
  const maxDistanceM = Math.max(clampNumber(payload.maxDistanceM, current.maxDistanceM, 150, 3000), minDistanceM + 50);
  const totalMinutes = clampNumber(payload.totalMinutes, current.totalMinutes, 10, 120);
  const categories = payload.categories?.length ? payload.categories.filter(c => (OBJECTIVE_CATEGORIES as string[]).includes(c)) : current.categories;
  const objectiveCount = Math.round(clampNumber(payload.objectiveCount, current.objectiveCount, 3, 15));
  return { centerLat, centerLng, radiusM, minDistanceM, maxDistanceM, totalMinutes, categories, objectiveCount };
}

function startCountdown() {
  stopCountdown();
  let secondsRemaining = 3;
  io.emit("countdown_tick", { secondsRemaining });
  countdownInterval = setInterval(() => {
    secondsRemaining -= 1;
    if (secondsRemaining < 0) {
      stopCountdown();
      beginActive();
      return;
    }
    io.emit("countdown_tick", { secondsRemaining });
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
}

function beginActive() {
  const game = state.game;
  if (!game) return;
  const startedAt = Date.now();
  game.phase = "active";
  game.startedAt = startedAt;
  game.endsAt = startedAt + game.config.totalMinutes * 60 * 1000;
  state.phase = "active";
  saveState();
  io.emit("game_started", { game: { id: game.id, route: game.route, config: game.config, startedAt, endsAt: game.endsAt } });
  gameTick();
}

function secondsRemainingFor(game: GameState): number {
  if (!game.endsAt) return 0;
  return Math.max(0, Math.round((game.endsAt - Date.now()) / 1000));
}

function gameTick() {
  const game = state.game;
  if (!game || game.phase !== "active") return;
  const secondsRemaining = secondsRemainingFor(game);
  if (secondsRemaining <= 0) {
    finishGame("time_up");
    return;
  }
  for (const player of Object.values(state.players)) {
    if (player.role === "HIDE") {
      const hider = game.hiders[player.id];
      if (!hider || hider.caughtAt) continue;
      const objective = game.route[hider.objectiveIndex] || null;
      const payload = {
        objectiveIndex: hider.objectiveIndex,
        objective,
        totalObjectives: game.route.length,
        secondsRemaining,
        allDone: hider.objectiveIndex >= game.route.length,
        caughtAt: hider.caughtAt
      };
      for (const socketId of player.sockets) io.to(socketId).emit("hider_status", payload);
    }
  }
  const seekerPayload = {
    route: game.route,
    progress: game.route.map((_o, index) => ({
      index,
      status: routeStatus(game, index),
      completedAt: completedAtFor(game, index)
    })),
    secondsRemaining
  };
  for (const player of Object.values(state.players)) {
    if (player.role === "SEEK" || player.role === "ADMIN") {
      for (const socketId of player.sockets) io.to(socketId).emit("seeker_status", seekerPayload);
    }
  }
}

function routeStatus(game: GameState, index: number): "upcoming" | "in_progress" | "completed" {
  const completedByAny = Object.values(game.hiders).some(h => h.objectiveIndex > index);
  if (completedByAny) return "completed";
  const currentForAny = Object.values(game.hiders).some(h => !h.caughtAt && h.objectiveIndex === index);
  return currentForAny ? "in_progress" : "upcoming";
}

// Seconds elapsed since game start when this objective's proof was submitted (not an epoch time).
function completedAtFor(game: GameState, index: number): number | null {
  const proof = game.allProofs.find(p => p.objectiveIndex === index);
  if (!proof || !game.startedAt) return null;
  return Math.round((proof.submittedAt - game.startedAt) / 1000);
}

function finishGame(endReason: "caught" | "time_up") {
  const game = state.game;
  if (!game || game.phase === "ended") return;
  game.phase = "ended";
  game.endedAt = Date.now();
  game.endReason = endReason;
  state.phase = "ended";
  const stats = {
    hiders: Object.values(game.hiders).map(h => ({ playerId: h.playerId, name: h.name, objectivesCompleted: h.objectiveIndex, caughtAt: h.caughtAt })),
    totalObjectives: game.route.length,
    elapsedSeconds: Math.max(0, Math.round(((game.endedAt || Date.now()) - (game.startedAt || game.endedAt || Date.now())) / 1000))
  };
  saveState();
  io.emit("game_over", { endReason, stats, gallery: game.allProofs });
}

function lobbyPayload() {
  return {
    phase: state.phase,
    roster: roster(),
    config: state.config,
    estimate: estimateAvailable([state.config.centerLng, state.config.centerLat], state.config.radiusM, state.config.categories)
  };
}

function broadcastLobby() {
  if (state.phase !== "lobby") return;
  io.emit("lobby_update", lobbyPayload());
}

function roster(): PlayerPublic[] {
  return Object.values(state.players).map(player => ({
    id: player.id,
    name: player.name,
    role: player.role,
    ready: player.ready,
    online: player.online,
    joinedAt: player.joinedAt
  }));
}

function removeOfflinePlayers() {
  for (const player of Object.values(state.players)) {
    if (player.role === "ADMIN") continue;
    if ((player.sockets?.length || 0) > 0) continue;
    delete state.players[player.id];
  }
}

function stalePlayerTick() {
  let changed = false;
  for (const player of Object.values(state.players)) {
    const liveSockets = player.sockets.filter(socketId => io.sockets.sockets.has(socketId));
    if (liveSockets.length !== player.sockets.length) {
      player.sockets = liveSockets;
      changed = true;
    }
    const online = player.sockets.length > 0;
    if (player.online !== online) {
      player.online = online;
      changed = true;
    }
  }
  if (changed) {
    saveState();
    broadcastLobby();
  }
}

function saveState() {
  store.save(state);
}

function requireAdmin(socket: { data: { isAdmin?: boolean } }, ack: (value: unknown) => void) {
  if (socket.data.isAdmin) return true;
  ack({ ok: false, error: "admin_required" });
  return false;
}

function cleanName(name: string) {
  return String(name || "Player").trim().slice(0, 18) || "Player";
}

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function noop(_value?: unknown) {
  return undefined;
}

function normalizeBasePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function boot() {
  loadRegions();
  for (const player of Object.values(state.players)) {
    player.sockets = [];
    player.online = false;
  }
  saveState();

  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get("*", (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
  } else {
    app.get("*", (_req, res) => {
      res.status(503).send("Client build missing. Run npm run build, or use npm run client:dev during development.");
    });
  }

  setInterval(gameTick, 1000);
  setInterval(stalePlayerTick, PLAYER_STALE_SWEEP_MS);

  server.listen(PORT, () => {
    console.log(`[hide-and-seek] listening on http://localhost:${PORT}`);
  });
}

boot();
