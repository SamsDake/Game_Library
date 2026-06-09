import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import { apiUrl, assetUrl, socketIoPath, socketServerUrl } from "./api";
import { setupPush } from "./push";
import { canUseNativeLocation, startNativeLocation } from "./native-location";
import type {
  AdminConfigPayload,
  AdminStatePayload,
  GameHistoryEntry,
  GameConfig,
  GameMode,
  HiderStatusPayload,
  JoinGamePayload,
  LeaderboardEntry,
  LngLat,
  LocationUpdatePayload,
  ObjectiveSlot,
  PlayerPublic,
  Role,
  Safehouse,
  SeekerPingPayload
} from "@shared/types";

type Screen = "lobby" | "waiting" | "admin" | "hider" | "seeker" | "gameover";

const socket: Socket = io(socketServerUrl(), { path: socketIoPath() });
const PENDING_LOCATION_KEY = "uh_pending_location";

const DEFAULT_CONFIG: GameConfig = {
  pingIntervalMinutes: 3,
  locationDelayMinutes: 3,
  lockdownIntervalCount: 3,
  globalSqueezePercentage: 10,
  lockdownRadius: 500,
  lockdownForecastDistance: 250,
  lockdownDurationSeconds: 120,
  shrinkIntervalSeconds: 120,
  gameDurationMinutes: 60,
  objectiveMinDistance: 150,
  objectiveMaxDistance: 1500,
  regularObjectivePoints: 1,
  lockdownObjectivePoints: 2,
  proximityThresholds: { near: 200, far: 1000 },
  claimRadius: 40,
  mode: "CLASSIC",
  vipObjectiveTarget: 5,
  safehouseRadius: 40,
  safehouseCaptureTargetSeconds: 600
};

const MODE_LABELS: Record<GameMode, string> = {
  CLASSIC: "Classic",
  VIP_ESCORT: "VIP Escort",
  SAFEHOUSES: "Safehouses"
};

const MODE_HINTS: Record<GameMode, string> = {
  CLASSIC: "Hiders complete objectives in a shrinking zone; seekers chase a delayed trail.",
  VIP_ESCORT: "One secret VIP; the rest are decoys. Only the VIP scores. Catch the VIP to win.",
  SAFEHOUSES: "Hold any of 3 safehouses uncontested to bank shared capture time and win."
};

type GameOverState = {
  winner: string;
  leaderboard: LeaderboardEntry[];
  durationSeconds: number;
  historyEntry?: GameHistoryEntry;
};

function App() {
  const [screen, setScreen] = useState<Screen>("lobby");
  const [role, setRole] = useState<Role | null>((localStorage.getItem("uh_role") as Role | null) || null);
  const [name, setName] = useState(localStorage.getItem("uh_name") || "");
  const [playerId, setPlayerId] = useState(localStorage.getItem("uh_player_id") || "");
  const [playerSecret, setPlayerSecret] = useState(localStorage.getItem("uh_player_secret") || "");
  const [admin, setAdmin] = useState<AdminStatePayload | null>(null);
  const [hider, setHider] = useState<HiderStatusPayload | null>(null);
  const [seeker, setSeeker] = useState<SeekerPingPayload | null>(null);
  const [liveRoster, setLiveRoster] = useState<PlayerPublic[]>([]);
  const [message, setMessage] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<ObjectiveSlot | null>(null);
  const [gameOver, setGameOver] = useState<GameOverState | null>(null);
  const [demoLocationEnabled, setDemoLocationEnabled] = useState(false);
  const geoWatch = useRef<number | null>(null);
  const demoTimer = useRef<number | null>(null);
  const nativeLocationStop = useRef<null | (() => Promise<void>)>(null);
  const locationRunId = useRef(0);
  const pendingLocation = useRef<LocationUpdatePayload | null>(readPendingLocation());
  const locationFlushInFlight = useRef(false);
  const locationRetryTimer = useRef<number | null>(null);
  const heartbeatTimer = useRef<number | null>(null);
  const roleRef = useRef<Role | null>(role);
  useEffect(() => { roleRef.current = role; }, [role]);
  const identityRef = useRef({ playerId, playerSecret });
  useEffect(() => { identityRef.current = { playerId, playerSecret }; }, [playerId, playerSecret]);
  const leaveRef = useRef<() => void>(() => {});
  const connectedOnceRef = useRef(false);

  useEffect(() => {
    fetch(apiUrl("/api/client-config"))
      .then(response => response.json())
      .then((config: { demoLocationEnabled?: boolean }) => setDemoLocationEnabled(!!config.demoLocationEnabled))
      .catch(() => setDemoLocationEnabled(false));
  }, []);

  // Register the service worker + Web Push subscription once we have an identity, so
  // hiders/seekers receive alerts even when the app is closed or the screen is locked.
  useEffect(() => {
    if (playerId && playerSecret) void setupPush(socket, playerId, playerSecret);
  }, [playerId, playerSecret]);

  useEffect(() => {
    let lastRosterSig = "";
    const applyRoster = (next: PlayerPublic[] | undefined) => {
      const list = next || [];
      const sig = JSON.stringify(list.map(p => [p.id, p.role, p.online, p.name]));
      if (sig === lastRosterSig) return;
      lastRosterSig = sig;
      setLiveRoster(list);
    };
    // Once the game has ended the phase stays "ended" until a new game starts. The
    // one-shot `game_over` event below shows the summary; these continuous handlers must
    // NOT keep forcing "gameover", or players who navigate back to the lobby to pick a
    // role get bounced back on the next server emit.
    const onStateAdmin = (payload: AdminStatePayload) => {
      setAdmin(payload);
      applyRoster(payload.roster);
      if (roleRef.current === "ADMIN" && payload.phase !== "ended") setScreen("admin");
    };
    const onStatusUpdate = (payload: HiderStatusPayload) => {
      setHider(payload);
      applyRoster(payload.roster);
      if (payload.phase === "active") setScreen("hider");
      else if (payload.phase === "setup") setScreen("waiting");
    };
    const onPingBroadcast = (payload: SeekerPingPayload) => {
      // Only seekers receive ping_broadcast; getting it as a HIDER means we were caught and
      // converted to a seeker server-side. Sync role + storage so a refresh rejoins as SEEKER.
      if (roleRef.current === "HIDER") {
        setRole("SEEKER");
        localStorage.setItem("uh_role", "SEEKER");
      }
      setSeeker(payload);
      applyRoster(payload.roster);
      if (payload.phase === "active") setScreen("seeker");
      else if (payload.phase === "setup") setScreen("waiting");
    };
    const onRosterUpdate = (roster: PlayerPublic[]) => applyRoster(roster);
    const onGameOver = (payload: GameOverState & { winner: string }) => {
      setGameOver({
        winner: `${payload.winner} win`,
        leaderboard: payload.leaderboard || [],
        durationSeconds: payload.durationSeconds || 0,
        historyEntry: payload.historyEntry
      });
      setMessage(`${payload.winner} win`);
      // Hiders/seekers see the summary; the admin stays on their console so they can
      // immediately start the next game.
      if (roleRef.current !== "ADMIN") setScreen("gameover");
    };
    const onConnect = () => {
      const { playerId: pid, playerSecret: secret } = identityRef.current;
      // On a *reconnect* (the initial join is handled by the mount effect), re-associate this
      // fresh socket with the existing player so location/heartbeat resume without a reload.
      // The server's join_game matches on playerId+secret. Admin can't auto-rejoin (no stored PIN).
      const storedRole = localStorage.getItem("uh_role") as Role | null;
      if (connectedOnceRef.current && pid && secret && storedRole && storedRole !== "ADMIN") {
        socket.emit("join_game", { role: storedRole, name: localStorage.getItem("uh_name") || storedRole, playerId: pid, playerSecret: secret }, (ack: { ok?: boolean }) => {
          if (ack?.ok) flushPendingLocation();
        });
      }
      connectedOnceRef.current = true;
      if (pid && secret) void setupPush(socket, pid, secret);
    };
    const onForceReset = () => {
      // Admin issued "Reset Everything" — send non-admin clients back to the home screen.
      if (roleRef.current !== "ADMIN") leaveRef.current();
    };
    const onGameAlert = (payload: { text?: string }) => {
      if (payload?.text) setMessage(payload.text);
    };
    socket.on("game_alert", onGameAlert);
    socket.on("force_reset", onForceReset);
    socket.on("state_admin", onStateAdmin);
    socket.on("status_update", onStatusUpdate);
    socket.on("ping_broadcast", onPingBroadcast);
    socket.on("roster_update", onRosterUpdate);
    socket.on("game_over", onGameOver);
    // If the socket already connected before this listener attached, the initial connect is
    // done — treat the next connect as a reconnect.
    if (socket.connected) connectedOnceRef.current = true;
    socket.on("connect", onConnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("game_alert", onGameAlert);
      socket.off("force_reset", onForceReset);
      socket.off("state_admin", onStateAdmin);
      socket.off("status_update", onStatusUpdate);
      socket.off("ping_broadcast", onPingBroadcast);
      socket.off("roster_update", onRosterUpdate);
      socket.off("game_over", onGameOver);
    };
  }, []);

  useEffect(() => {
    if (role && playerId && playerSecret) {
      join({ role, name, playerId, playerSecret });
    }
  }, []);

  const locationActive =
    (role === "HIDER" && hider?.phase === "active" && !!hider.me && !!hider.gameId) ||
    (role === "SEEKER" && seeker?.phase === "active");

  useEffect(() => {
    if (locationActive) startLocation();
    else {
      stopLocation();
      clearPendingLocation();
    }
    return stopLocation;
  }, [locationActive, role, hider?.gameId, demoLocationEnabled]);

  useEffect(() => {
    stopHeartbeat();
    if (!role || !playerId || !playerSecret) return;
    sendHeartbeat();
    heartbeatTimer.current = window.setInterval(sendHeartbeat, 30000);
    return stopHeartbeat;
  }, [role, playerId, playerSecret]);

  const roster = liveRoster.length ? liveRoster : admin?.roster || hider?.roster || seeker?.roster || [];

  function join(payload: Partial<JoinGamePayload>) {
    const finalRole = payload.role;
    if (!finalRole) return;
    socket.emit("join_game", {
      name: payload.name || name || finalRole,
      role: finalRole,
      adminPin: payload.adminPin,
      playerId: payload.playerId || null,
      playerSecret: payload.playerSecret || null
    }, (ack: { ok: boolean; error?: string; playerId?: string; playerSecret?: string; role?: Role }) => {
      if (!ack.ok || !ack.playerId || !ack.playerSecret || !ack.role) {
        setMessage(`Join failed: ${ack.error || "unknown"}`);
        return;
      }
      setRole(ack.role);
      setPlayerId(ack.playerId);
      setPlayerSecret(ack.playerSecret);
      localStorage.setItem("uh_role", ack.role);
      localStorage.setItem("uh_player_id", ack.playerId);
      localStorage.setItem("uh_player_secret", ack.playerSecret);
      localStorage.setItem("uh_name", payload.name || name || ack.role);
      setScreen(ack.role === "ADMIN" ? "admin" : "waiting");
      flushPendingLocation();
    });
  }

  function leave() {
    socket.emit("leave_game");
    stopLocation();
    stopHeartbeat();
    localStorage.removeItem("uh_role");
    localStorage.removeItem("uh_player_id");
    localStorage.removeItem("uh_player_secret");
    clearPendingLocation();
    setRole(null);
    setPlayerId("");
    setPlayerSecret("");
    setScreen("lobby");
  }
  leaveRef.current = leave;

  function startLocation() {
    if (geoWatch.current || demoTimer.current || nativeLocationStop.current) return;
    const send = (coords: LngLat, accuracy: number | null, timestamp = new Date().toISOString()) => {
      queueLocation({
        playerId,
        gameId: hider?.gameId || undefined,
        coordinates: coords,
        accuracy,
        timestamp
      });
    };
    if (canUseNativeLocation()) {
      const runId = ++locationRunId.current;
      void startNativeLocation({
        gameId: hider?.gameId || null,
        sendLocation: payload => queueLocation({ ...payload, playerId }),
        onError: reason => setMessage(`${reason}. Live GPS is required to play and claim objectives.`)
      }).then(stop => {
        if (locationRunId.current !== runId) {
          void stop().catch(() => undefined);
          return;
        }
        nativeLocationStop.current = stop;
      }).catch(() => {
        nativeLocationStop.current = null;
        setMessage("Native background GPS failed to start. Check location permissions.");
      });
      return;
    }
    if (navigator.geolocation && window.isSecureContext) {
      geoWatch.current = navigator.geolocation.watchPosition(
        pos => send([pos.coords.longitude, pos.coords.latitude], pos.coords.accuracy),
        () => handleLocationUnavailable(send, "GPS unavailable or permission denied"),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
      );
    } else {
      handleLocationUnavailable(send, window.isSecureContext ? "GPS is not supported on this device" : "GPS requires HTTPS or localhost");
    }
  }

  function handleLocationUnavailable(send: (coords: LngLat, accuracy: number | null) => void, reason: string) {
    if (demoLocationEnabled) {
      setMessage(`${reason}; demo location enabled`);
      startDemoLocation(send);
      return;
    }
    stopLocation();
    setMessage(`${reason}. Live GPS is required to play and claim objectives.`);
  }

  function startDemoLocation(send: (coords: LngLat, accuracy: number | null) => void) {
    if (geoWatch.current) navigator.geolocation.clearWatch(geoWatch.current);
    geoWatch.current = null;
    const seekerSelf = seeker?.seekers.find(s => s.playerId === playerId);
    let coords = hider?.me?.coordinates || seekerSelf?.coordinates || admin?.setup.center || [-0.0915, 51.5125] as LngLat;
    demoTimer.current = window.setInterval(() => {
      const target = role === "HIDER" ? hider?.me?.activeObjective.coordinates : seeker?.hiders[0]?.delayedCoordinates;
      if (target) coords = [coords[0] + (target[0] - coords[0]) * 0.04, coords[1] + (target[1] - coords[1]) * 0.04];
      send(coords, 999);
    }, 5000);
  }

  function stopLocation() {
    locationRunId.current += 1;
    if (geoWatch.current) navigator.geolocation.clearWatch(geoWatch.current);
    if (demoTimer.current) clearInterval(demoTimer.current);
    if (nativeLocationStop.current) void nativeLocationStop.current().catch(() => undefined);
    geoWatch.current = null;
    demoTimer.current = null;
    nativeLocationStop.current = null;
  }

  function queueLocation(payload: LocationUpdatePayload) {
    pendingLocation.current = payload;
    writePendingLocation(payload);
    flushPendingLocation();
  }

  function flushPendingLocation() {
    if (locationFlushInFlight.current || !pendingLocation.current || !socket.connected) return;
    const payload = pendingLocation.current;
    locationFlushInFlight.current = true;
    socket.timeout(8000).emit("location_update", payload, (err: Error | null, ack?: { ok?: boolean; error?: string }) => {
      locationFlushInFlight.current = false;
      if (!err && ack?.ok) {
        if (pendingLocation.current === payload) clearPendingLocation();
        else flushPendingLocation();
        return;
      }
      if (!err && pendingLocation.current === payload && (ack?.error === "not_active" || ack?.error === "invalid_coordinates")) {
        clearPendingLocation();
        return;
      }
      scheduleLocationFlush();
    });
  }

  function scheduleLocationFlush() {
    if (locationRetryTimer.current || !pendingLocation.current) return;
    locationRetryTimer.current = window.setTimeout(() => {
      locationRetryTimer.current = null;
      flushPendingLocation();
    }, 5000);
  }

  function clearPendingLocation() {
    pendingLocation.current = null;
    localStorage.removeItem(PENDING_LOCATION_KEY);
    if (locationRetryTimer.current) clearTimeout(locationRetryTimer.current);
    locationRetryTimer.current = null;
  }

  function sendHeartbeat() {
    socket.emit("client_heartbeat", { playerId, playerSecret });
  }

  function stopHeartbeat() {
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    heartbeatTimer.current = null;
  }

  async function submitClaim(slot: ObjectiveSlot) {
    if (!photo || !hider?.me) return;
    const form = new FormData();
    form.append("playerId", playerId);
    form.append("playerSecret", playerSecret);
    form.append("slotId", slot.slotId);
    form.append("objectiveId", slot.objective.id);
    form.append("lon", String(hider.me.coordinates[0]));
    form.append("lat", String(hider.me.coordinates[1]));
    form.append("photo", photo);
    try {
      const response = await fetch(apiUrl("/api/claims"), { method: "POST", body: form });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.ok) setMessage(`Claim failed: ${claimErrorText(json.error || String(response.status))}`);
      else {
        setMessage("Objective claimed");
        setPhoto(null);
        setClaimOpen(false);
        setSelectedSlot(null);
      }
    } catch {
      setMessage("Claim failed: network error");
    }
  }

  function openClaim(slot: ObjectiveSlot) {
    setSelectedSlot(slot);
    setClaimOpen(true);
  }

  function confirmCaught() {
    socket.emit("hider_caught", {}, (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) setMessage(`Caught failed: ${ack.error || "unknown"}`);
    });
  }

  if (screen === "lobby") return <Lobby name={name} setName={setName} message={message} onJoin={join} />;
  if (screen === "admin") return <AdminView payload={admin} roster={roster} message={message} setMessage={setMessage} onLeave={leave} />;
  if (screen === "hider") return <HiderView payload={hider} message={message} onLeave={leave} claimOpen={claimOpen} setClaimOpen={setClaimOpen} selectedSlot={selectedSlot} setSelectedSlot={setSelectedSlot} photo={photo} setPhoto={setPhoto} openClaim={openClaim} submitClaim={submitClaim} confirmCaught={confirmCaught} />;
  if (screen === "seeker") return <SeekerView payload={seeker} message={message} onLeave={leave} />;
  if (screen === "gameover") return <GameOver winner={admin?.winner ? `${admin.winner} win` : gameOver?.winner || message || "Mission"} claims={admin?.game?.claims || []} leaderboard={admin?.game?.leaderboard || gameOver?.leaderboard || []} durationSeconds={gameOver?.durationSeconds || (admin?.game?.endedAt && admin.game.startedAt ? Math.round((admin.game.endedAt - admin.game.startedAt) / 1000) : 0)} history={admin?.history || (gameOver?.historyEntry ? [gameOver.historyEntry] : [])} onLeave={leave} isAdmin={role === "ADMIN"} />;
  return <Waiting role={role} name={name} roster={roster} playerSecret={playerSecret} onLeave={leave} />;
}

function Lobby({ name, setName, message, onJoin }: {
  name: string;
  setName: (name: string) => void;
  message: string;
  onJoin: (payload: Partial<JoinGamePayload>) => void;
}) {
  const [pin, setPin] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);
  const submitAdmin = () => onJoin({ role: "ADMIN", name: name || "CONTROL", adminPin: pin });
  return <div className="app"><div className="lobby">
    <div className="logo">HIDE &amp; SEEK</div>
    <div className="sub">Urban Hunt System</div>
    {message && <div className="notice">{message}</div>}
    <input className="input" placeholder="ENTER CALL SIGN" value={name} onChange={e => setName(e.target.value)} />
    <div className="roles">
      <button className="role-card hider" onClick={() => onJoin({ role: "HIDER", name })}><span className="glyph hider" /><span className="role-label">Hide</span><span className="role-desc">complete objectives</span></button>
      <button className="role-card seeker" onClick={() => onJoin({ role: "SEEKER", name })}><span className="glyph seeker" /><span className="role-label">Seek</span><span className="role-desc">close the net</span></button>
    </div>
    <button className="admin-link" onClick={() => setAdminOpen(true)}>... admin access ...</button>
    {adminOpen && <div className="overlay" onClick={() => setAdminOpen(false)}>
      <div className="overlay-card" onClick={e => e.stopPropagation()}>
        <div className="sheet-title">Admin Access</div>
        {message && <div className="notice">{message}</div>}
        <input className="input" placeholder="ADMIN PIN" type="password" value={pin} autoFocus
          onChange={e => setPin(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submitAdmin(); }} />
        <div className="controls" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button className="btn" onClick={() => setAdminOpen(false)}>Cancel</button>
          <button className="btn primary" onClick={submitAdmin}>Access</button>
        </div>
      </div>
    </div>}
  </div></div>;
}

function Waiting({ role, name, roster, playerSecret, onLeave }: { role: Role | null; name: string; roster: PlayerPublic[]; playerSecret: string; onLeave: () => void }) {
  return <Shell title="Hide & Seek" role={role || undefined} subtitle="WAITING" onBack={onLeave}>
    <div className="body">
      <div className="card soft text-center"><div className="kicker">your role</div><div className={`role-big role-${role}`}>{role}</div><div className="mono">{name}</div></div>
      <Roster roster={roster} />
      {playerSecret && <TraccarSetup playerSecret={playerSecret} />}
      <div className="card soft text-center"><div className="kicker">waiting for admin to start</div></div>
    </div>
  </Shell>;
}

// Helps a player point the Traccar Client app at this server for reliable background tracking.
// The player secret doubles as the Traccar "Device identifier" (the server ingests pings at
// /api/traccar and attributes them by matching this secret).
function TraccarSetup({ playerSecret }: { playerSecret: string }) {
  const serverUrl = new URL(apiUrl("/api/traccar"), window.location.origin).href;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, value: string) => {
    void navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(current => (current === key ? null : current)), 1500);
  };
  return <div className="card">
    <div className="card-title">Background tracking (Traccar)</div>
    <div className="mono">Install the free <strong>Traccar Client</strong> app and enter these so your location keeps sharing while Urban Hunt is closed or your phone is locked.</div>
    <div className="kicker" style={{ marginTop: 12 }}>Server URL</div>
    <div className="mono" style={{ wordBreak: "break-all" }}>{serverUrl}</div>
    <button className="btn" onClick={() => copy("url", serverUrl)}>{copied === "url" ? "Copied" : "Copy URL"}</button>
    <div className="kicker" style={{ marginTop: 12 }}>Device identifier</div>
    <div className="mono" style={{ wordBreak: "break-all" }}>{playerSecret}</div>
    <button className="btn" onClick={() => copy("id", playerSecret)}>{copied === "id" ? "Copied" : "Copy identifier"}</button>
    <div className="mono" style={{ marginTop: 12 }}>Set Frequency to 30s, then enable the toggle. Set this up now and stay joined so your identifier doesn't change.</div>
  </div>;
}

function AdminView({ payload, roster, message, setMessage, onLeave }: {
  payload: AdminStatePayload | null;
  roster: PlayerPublic[];
  message: string;
  setMessage: (message: string) => void;
  onLeave: () => void;
}) {
  const setup = payload?.setup;
  const game = payload?.game;
  const config = game?.config || setup?.config || DEFAULT_CONFIG;
  const [draft, setDraft] = useState<AdminConfigPayload>({});
  const [mapPickMode, setMapPickMode] = useState<"center" | "radius">("radius");
  useEffect(() => setDraft({}), [payload?.phase]);
  const emitAdmin = (event: string, payload: unknown, successMessage?: string) => {
    socket.emit(event, payload, (ack: { ok: boolean; error?: string }) => {
      if (!ack?.ok) setMessage(`Admin action failed: ${ack?.error || "unknown"}`);
      else if (successMessage) setMessage(successMessage);
    });
  };
  const update = (next: AdminConfigPayload) => {
    const merged = { ...draft, ...next };
    setDraft(merged);
    emitAdmin("update_variables", merged);
  };
  const isSetup = payload?.phase !== "active";
  return <Shell title="Admin" role="ADMIN" subtitle={payload?.phase === "active" ? "CONTROL" : "SETUP"} onBack={onLeave}>
    <div className="body">
      {message && <div className="notice">{message}</div>}
      {isSetup && setup && <div className="card">
        <div className="card-title">Starting Zone</div>
        <NumberField label="Longitude" value={draft.center?.[0] ?? setup.center[0]} step={0.0001} onChange={v => update({ center: [v, draft.center?.[1] ?? setup.center[1]] })} />
        <NumberField label="Latitude" value={draft.center?.[1] ?? setup.center[1]} step={0.0001} onChange={v => update({ center: [draft.center?.[0] ?? setup.center[0], v] })} />
        <Range label="Initial radius" value={draft.radius ?? setup.radius} min={100} max={20000} step={50} unit="m" onChange={v => update({ radius: v })} />
        <div className="controls" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button className={`btn${mapPickMode === "center" ? " primary" : ""}`} onClick={() => setMapPickMode("center")}>Pin Origin</button>
          <button className={`btn${mapPickMode === "radius" ? " primary" : ""}`} onClick={() => setMapPickMode("radius")}>Set Radius</button>
        </div>
        <div className="mono">{mapPickMode === "center" ? "Tap the map to place the zone origin pin." : "Tap the map to set the radius from the current origin."}</div>
      </div>}
      {isSetup && <div className="card">
        <div className="card-title">Game Mode</div>
        <div className="controls" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          {(Object.keys(MODE_LABELS) as GameMode[]).map(m => (
            <button key={m} className={`btn${(config.mode || "CLASSIC") === m ? " primary" : ""}`} onClick={() => update({ mode: m })}>{MODE_LABELS[m]}</button>
          ))}
        </div>
        <div className="mono">{MODE_HINTS[config.mode || "CLASSIC"]}</div>
      </div>}
      <Settings config={config} onChange={update} />
      <Roster roster={roster} />
      {payload?.phase === "active" && game ? <Controls setMessage={setMessage} /> : <div className="controls">
        <button className="btn primary" onClick={() => emitAdmin("admin_start_game", {}, "Game started")}>Start Game</button>
        <button className="btn danger" onClick={() => { if (confirm("Disconnect everyone before the game starts?")) emitAdmin("admin_disconnect_all", {}, "Disconnected waiting players"); }}>Disconnect All</button>
      </div>}
      <button className="btn danger" onClick={() => { if (confirm("Reset EVERYTHING? This ends any game in progress, clears all players, wipes game history, and returns every device to the home screen.")) emitAdmin("admin_game_control", { action: "reset", clearHistory: true }, "Game reset"); }}>Reset Everything</button>
      <GameMap
        mode="admin"
        admin={payload}
        hider={null}
        seeker={null}
        onSetupCenterPick={isSetup && mapPickMode === "center" ? (center) => { update({ center }); setMapPickMode("radius"); } : undefined}
        onSetupRadiusPick={isSetup && mapPickMode === "radius" ? (radius) => update({ radius }) : undefined}
      />
      {payload?.game?.claims?.length ? <Claims claims={payload.game.claims} setMessage={setMessage} /> : null}
      {payload?.history?.length ? <HistoryList history={payload.history} /> : null}
    </div>
  </Shell>;
}

function HiderView({ payload, message, onLeave, claimOpen, setClaimOpen, selectedSlot, setSelectedSlot, photo, setPhoto, openClaim, submitClaim, confirmCaught }: {
  payload: HiderStatusPayload | null;
  message: string;
  onLeave: () => void;
  claimOpen: boolean;
  setClaimOpen: (open: boolean) => void;
  selectedSlot: ObjectiveSlot | null;
  setSelectedSlot: (slot: ObjectiveSlot | null) => void;
  photo: File | null;
  setPhoto: (file: File | null) => void;
  openClaim: (slot: ObjectiveSlot) => void;
  submitClaim: (slot: ObjectiveSlot) => void;
  confirmCaught: () => void;
}) {
  const me = payload?.me;
  const mode = me?.mode || "CLASSIC";
  const isVip = mode === "VIP_ESCORT";
  const isBodyguard = isVip && me?.hiderRole === "BODYGUARD";
  const isSafehouse = mode === "SAFEHOUSES";
  const [caughtUntil, setCaughtUntil] = useState(0);
  const selectedDistance = me && selectedSlot ? distanceMeters(me.coordinates, selectedSlot.objective.coordinates) : Infinity;
  const selectedInRange = !!me && selectedDistance <= me.config.claimRadius;
  const now = Date.now();
  const caughtArmed = caughtUntil > now;
  const caughtText = caughtArmed ? "Tap Again To Confirm" : "I Have Been Caught";
  const lockdownTimer = me ? lockdownTimerState(me, now) : null;
  const objectives = me?.activeObjectives?.length ? me.activeObjectives : me ? [{
    slotId: "legacy",
    kind: "regular" as const,
    objective: me.activeObjective,
    scoreValue: 1,
    createdAt: Date.now(),
    expiresAt: null
  }] : [];
  function caughtClick() {
    if (caughtArmed) {
      setCaughtUntil(0);
      confirmCaught();
    } else {
      setCaughtUntil(Date.now() + 5000);
      window.setTimeout(() => setCaughtUntil(current => current > Date.now() ? 0 : current), 5000);
    }
  }
  return <Shell title="Hide & Seek" role="HIDER" subtitle={payload?.gameId || "ACTIVE"} onBack={onLeave}>
    <div className="screen-body">
      <div className="map-pane"><GameMap mode="hider" admin={null} hider={payload} seeker={null} /></div>
      <div className="panel">
        {message && <div className="notice">{message}</div>}
        {me && <><div className="proximity"><div className="kicker">proximity to nearest seeker</div><div className={`prox-value ${me.proximityStatus}`}>{me.proximityStatus}</div></div>
        {me.gameSecondsRemaining !== null && <div className="row"><span className="kicker">survive for</span><span className="time">{formatTime(me.gameSecondsRemaining)}</span></div>}
        {me.isOutOfBounds && <div className="notice">Out of bounds - return now (objectives locked)</div>}
        <div className="score-card row"><span className="kicker">score</span><strong>{me.score}</strong></div>
        {lockdownTimer && <Timer label={lockdownTimer.label} seconds={lockdownTimer.seconds} total={lockdownTimer.total} />}
        {me.nextLockdownCircleGeoJSON && <div className="lockdown row"><span className="kicker">next lockdown</span><span className="mono">{me.nextLockdownStartsAt ? formatTime((me.nextLockdownStartsAt - now) / 1000) : "forecast"}</span></div>}
        {isVip && <div className={`card soft text-center role-banner role-${me.hiderRole}`}>
          <div className="kicker">your assignment</div>
          <div className="role-big">{me.hiderRole === "VIP" ? "VIP" : "BODYGUARD"}</div>
          <div className="mono">{me.hiderRole === "VIP" ? "Clear objectives. Stay alive." : "Escort the VIP and draw the seekers away."}</div>
        </div>}
        {isSafehouse && <SafehousePanel safehouses={me.safehouses} />}
        {isSafehouse && <CaptureCounter seconds={me.totalCaptureSeconds} target={me.captureTargetSeconds} />}
        {!isSafehouse && objectives.map(slot => {
          const dist = distanceMeters(me.coordinates, slot.objective.coordinates);
          const inRange = dist <= me.config.claimRadius && !me.isOutOfBounds && !isBodyguard;
          return <div key={slot.slotId} className={`objective ${slot.kind}`}>
            <div className="row"><span className="kicker">{isBodyguard ? "vip target" : slot.kind === "lockdown" ? "lockdown objective" : "active objective"}</span><span className="mono">{Math.round(dist)}m / {slot.scoreValue}pt</span></div>
            <div className="player-name">{slot.objective.name}</div>
            <div className="row"><span className="mono">{slot.objective.category}</span>{slot.expiresAt && <span className="mono">{formatTime((slot.expiresAt - Date.now()) / 1000)}</span>}</div>
            {isBodyguard
              ? <button className="btn" disabled>Escort the VIP</button>
              : <button className={`btn ${inRange ? "primary" : ""}`} disabled={!inRange} onClick={() => openClaim(slot)}>{me.isOutOfBounds ? "Out Of Bounds" : inRange ? "Claim Objective" : "Move Closer"}</button>}
          </div>;
        })}
        <button className={`btn danger ${caughtArmed ? "armed" : ""}`} onClick={caughtClick}>{caughtText}</button>
        {!isSafehouse && <Timer label="zone shrink" seconds={me.shrinkCountdown} total={me.config.shrinkIntervalSeconds} />}</>}
      </div>
      {claimOpen && me && selectedSlot && <div className="claim-sheet">
        <div className="row"><div><div className="sheet-title">Claim Objective</div><div className="mono">{selectedSlot.objective.name}</div></div><button className="close" onClick={() => { setClaimOpen(false); setSelectedSlot(null); }}>x</button></div>
        <div className="checks"><div className={`check ${selectedInRange ? "ok" : ""}`}>GPS {selectedInRange ? "ready" : `${Math.round(selectedDistance)}m away`}</div><div className={`check ${photo ? "ok" : ""}`}>Photo {photo ? "captured" : "required"}</div></div>
        <input type="file" accept="image/*" capture="environment" onChange={e => setPhoto(e.target.files?.[0] || null)} />
        <button className="btn primary" disabled={!selectedInRange || !photo} onClick={() => submitClaim(selectedSlot)}>Confirm Claim</button>
      </div>}
    </div>
  </Shell>;
}

function SeekerView({ payload, message, onLeave }: { payload: SeekerPingPayload | null; message: string; onLeave: () => void }) {
  return <Shell title="Hide & Seek" role="SEEKER" subtitle="ACTIVE" onBack={onLeave}>
    <div className="screen-body">
      <div className="map-pane"><GameMap mode="seeker" admin={null} hider={null} seeker={payload} /></div>
      <div className="panel">
        {message && <div className="notice">{message}</div>}
        {payload && payload.gameSecondsRemaining != null && <div className="row"><span className="kicker">time left</span><span className="time">{formatTime(payload.gameSecondsRemaining)}</span></div>}
        {payload?.mode === "SAFEHOUSES" && <SafehousePanel safehouses={payload.safehouses} />}
        {payload?.mode === "SAFEHOUSES" && <CaptureCounter seconds={payload.totalCaptureSeconds} target={payload.captureTargetSeconds} />}
        <div className="kicker">hider signals</div>
        {payload?.hiders.map(h => <div key={h.hiderId} className="ping"><div><div className="player-name">{h.name}</div><div className="mono">captured {new Date(h.timestampOfCapture).toLocaleTimeString()}</div></div>{payload?.mode !== "SAFEHOUSES" && <div className="mono">{(h.activeObjectives || []).map(slot => `${slot.objective.name} ${slot.scoreValue}pt`).join(" / ") || h.activeObjective.name}</div>}</div>)}
      </div>
    </div>
  </Shell>;
}

function GameMap({ mode, admin, hider, seeker, onSetupCenterPick, onSetupRadiusPick }: {
  mode: "admin" | "hider" | "seeker";
  admin: AdminStatePayload | null;
  hider: HiderStatusPayload | null;
  seeker: SeekerPingPayload | null;
  onSetupCenterPick?: (center: LngLat) => void;
  onSetupRadiusPick?: (radiusMeters: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const userChangedViewport = useRef(false);
  const autoFraming = useRef(false);
  const lastViewportKey = useRef("");
  const lastDrawSignature = useRef("");
  useEffect(() => {
    if (!ref.current) return;
    const map = L.map(ref.current, { zoomControl: false, scrollWheelZoom: true, touchZoom: true });
    mapRef.current = map;
    const markUserViewportChange = () => {
      if (!autoFraming.current) userChangedViewport.current = true;
    };
    map.on("zoomstart", markUserViewportChange);
    map.on("dragstart", markUserViewportChange);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    }).addTo(map);
    layers.current = L.layerGroup().addTo(map);
    return () => {
      map.off("zoomstart", markUserViewportChange);
      map.off("dragstart", markUserViewportChange);
      map.remove();
    };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    const group = layers.current;
    if (!map || !group) return;
    const viewportKey = mapViewportKey(mode, admin, hider, seeker);
    if (lastViewportKey.current !== viewportKey) {
      lastViewportKey.current = viewportKey;
      userChangedViewport.current = false;
    }
    // Skip the expensive layer teardown/redraw when nothing drawable changed (the server
    // broadcasts state ~1x/sec for the shrink timer even when geometry is identical).
    const signature = viewportKey + "|" + mapContentSignature(mode, admin, hider, seeker);
    if (lastDrawSignature.current === signature) return;
    lastDrawSignature.current = signature;
    group.clearLayers();
    const bounds: L.LatLngBounds[] = [];
    const addGeo = (geo: GeoJSON.Feature | null | undefined, color: string, options: { fillOpacity?: number; dashArray?: string } = {}) => {
      if (!geo) return;
      const layer = L.geoJSON(geo, { style: { color, weight: 2, fillOpacity: options.fillOpacity ?? 0.06, dashArray: options.dashArray ?? "6 4" } }).addTo(group);
      bounds.push(layer.getBounds());
    };
    const addMarker = (coord: LngLat | undefined, color: string, label: string) => {
      if (!coord) return;
      L.circleMarker([coord[1], coord[0]], { radius: 7, color, fillColor: color, fillOpacity: 0.9 }).addTo(group).bindTooltip(label);
      bounds.push(L.latLngBounds([coord[1], coord[0]], [coord[1], coord[0]]));
    };
    const addLine = (coords: LngLat[] | undefined, color: string) => {
      if (!coords || coords.length < 2) return;
      const latLngs = coords.map(([lon, lat]) => [lat, lon] as [number, number]);
      const line = L.polyline(latLngs, { color, weight: 3, opacity: 0.78 }).addTo(group);
      bounds.push(line.getBounds());
    };
    const addObjectiveSlots = (slots: ObjectiveSlot[] | undefined, fallback: { coordinates: LngLat; name: string } | undefined) => {
      const list = slots?.length ? slots : fallback ? [{ slotId: "legacy", kind: "regular" as const, objective: fallback, scoreValue: 1, createdAt: 0, expiresAt: null }] : [];
      list.forEach(slot => addMarker(
        slot.objective.coordinates,
        slot.kind === "lockdown" ? "#d9a520" : "#a7c24d",
        `${slot.objective.name} (${slot.scoreValue}pt)`
      ));
    };
    const SAFEHOUSE_COLORS: Record<string, string> = { idle: "#6f7d54", breached: "#c0473a", contested: "#d9a520" };
    const addSafehouses = (list: Safehouse[] | undefined) => {
      (list || []).forEach(s => {
        const color = SAFEHOUSE_COLORS[s.state] || "#6f7d54";
        const layer = L.geoJSON(s.circleGeoJSON, { style: { color, weight: 2, fillColor: color, fillOpacity: s.state === "idle" ? 0.1 : 0.3, dashArray: s.state === "breached" ? undefined : "6 4" } }).addTo(group);
        layer.bindTooltip(`Safehouse ${s.label} — ${s.state}`);
        bounds.push(layer.getBounds());
      });
    };
    if (mode === "admin") {
      addGeo(admin?.game?.globalSafeZoneGeoJSON || admin?.setup.globalSafeZoneGeoJSON, "#c2b280");
      if (!admin?.game && admin?.setup) {
        const c = admin.setup.center;
        L.marker([c[1], c[0]], {
          icon: L.divIcon({ className: "", html: '<div style="width:18px;height:18px;border:3px solid #a7c24d;border-radius:50%;background:rgba(167,194,77,0.25);box-shadow:0 0 8px rgba(167,194,77,0.6);margin:-9px 0 0 -9px"></div>', iconSize: [0, 0] })
        }).addTo(group).bindTooltip("Zone origin");
        bounds.push(L.latLngBounds([c[1], c[0]], [c[1], c[0]]));
      }
      addSafehouses(admin?.game?.safehouses);
      const adminHasObjectives = admin?.game?.config.mode !== "SAFEHOUSES";
      admin?.game?.hiders.forEach(h => {
        addGeo(h.nextLockdownCircleGeoJSON, "#4da3c7", { fillOpacity: 0.03, dashArray: "2 8" });
        addGeo(h.lockdownCircleGeoJSON, "#d9a520");
        const isVip = h.hiderRole === "VIP";
        addMarker(h.coords, isVip ? "#d9a520" : "#c2b280", isVip ? `${h.name} (VIP)` : h.hiderRole === "BODYGUARD" ? `${h.name} (decoy)` : h.name);
        if (adminHasObjectives) addObjectiveSlots(h.activeObjectives, h.activeObjective);
      });
      admin?.game?.seekers.forEach(s => addMarker(s.coords, "#c0473a", s.name));
    }
    if (mode === "hider" && hider?.me) {
      addGeo(hider.me.globalSafeZoneGeoJSON, "#c2b280");
      addGeo(hider.me.nextLockdownCircleGeoJSON, "#4da3c7", { fillOpacity: 0.03, dashArray: "2 8" });
      addGeo(hider.me.myLockdownCircleGeoJSON, "#d9a520");
      addGeo(hider.me.legalAreaGeoJSON, "#a7c24d");
      addSafehouses(hider.me.safehouses);
      (hider.me.teammates || []).forEach(t => addMarker(t.coordinates, t.hiderRole === "VIP" ? "#d9a520" : "#4da3c7", t.hiderRole === "VIP" ? `${t.name} (VIP)` : t.name));
      addMarker(hider.me.coordinates, "#c2b280", "you");
      if (!hider.me.safehouses?.length) addObjectiveSlots(hider.me.activeObjectives, hider.me.activeObjective);
    }
    if (mode === "seeker" && seeker) {
      addGeo(seeker.globalSafeZoneGeoJSON, "#c2b280");
      addSafehouses(seeker.safehouses);
      seeker.seekers.forEach(s => addMarker(s.coordinates, "#c0473a", s.name));
      seeker.hiders.forEach(h => { addGeo(h.lockdownCircleGeoJSON, "#d9a520"); addLine(h.delayedTrail, "#c2b280"); addMarker(h.delayedCoordinates, "#c2b280", h.name); if (seeker.mode !== "SAFEHOUSES") addObjectiveSlots(h.activeObjectives, h.activeObjective); });
    }
    const combined = bounds.reduce<L.LatLngBounds | null>((acc, b) => acc ? acc.extend(b) : b, null);
    if (!userChangedViewport.current) {
      autoFraming.current = true;
      if (combined?.isValid()) map.fitBounds(combined, { padding: [24, 24], maxZoom: 16, animate: false });
      else map.setView([51.5125, -0.0915], 13, { animate: false });
      window.setTimeout(() => { autoFraming.current = false; }, 0);
    }
  }, [mode, admin, hider, seeker]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== "admin" || admin?.phase === "active" || !admin?.setup) return;
    const handler = (event: L.LeafletMouseEvent) => {
      const lngLat: LngLat = [event.latlng.lng, event.latlng.lat];
      if (onSetupCenterPick) {
        onSetupCenterPick(lngLat);
      } else if (onSetupRadiusPick) {
        const radius = Math.max(100, Math.round(distanceMeters(admin.setup.center, lngLat)));
        onSetupRadiusPick(radius);
      }
    };
    map.on("click", handler);
    return () => {
      map.off("click", handler);
    };
  }, [mode, admin?.phase, admin?.setup?.center, onSetupCenterPick, onSetupRadiusPick]);
  return <div ref={ref} className="map" />;
}

function mapViewportKey(
  mode: "admin" | "hider" | "seeker",
  admin: AdminStatePayload | null,
  hider: HiderStatusPayload | null,
  seeker: SeekerPingPayload | null
) {
  if (mode === "admin") {
    const game = admin?.game;
    return game
      ? `admin:${game.id}:${game.phase}`
      : `admin-setup:${admin?.setup.center.join(",")}:${admin?.setup.radius}`;
  }
  if (mode === "hider") {
    return `hider:${hider?.gameId || "none"}`;
  }
  const hiders = seeker?.hiders.map(h => h.hiderId).sort().join(",") || "none";
  return `seeker:${seeker?.phase || "none"}:${hiders}`;
}

// Serialize exactly what the draw effect renders, so identical payloads (the per-second
// shrink-timer broadcasts) don't trigger a full Leaflet layer rebuild.
function mapContentSignature(
  mode: "admin" | "hider" | "seeker",
  admin: AdminStatePayload | null,
  hider: HiderStatusPayload | null,
  seeker: SeekerPingPayload | null
) {
  const slots = (list: ObjectiveSlot[] | undefined, fallbackId?: string, fallbackCoord?: LngLat) =>
    (list?.length ? list.map(s => [s.objective.id, s.objective.coordinates, s.scoreValue, s.kind]) : [[fallbackId, fallbackCoord]]);
  if (mode === "admin") {
    const game = admin?.game;
    if (game) {
      return JSON.stringify([
        "admin-game",
        game.globalSafeZoneGeoJSON,
        game.hiders.map(h => [h.coords, h.lockdownCircleGeoJSON, h.nextLockdownCircleGeoJSON, h.hiderRole, slots(h.activeObjectives, h.activeObjective?.id, h.activeObjective?.coordinates)]),
        game.seekers.map(s => s.coords),
        game.safehouses?.map(s => [s.id, s.state])
      ]);
    }
    return JSON.stringify(["admin-setup", admin?.setup.center, admin?.setup.globalSafeZoneGeoJSON]);
  }
  if (mode === "hider") {
    const me = hider?.me;
    return JSON.stringify(me ? [
      "hider", me.coordinates, me.globalSafeZoneGeoJSON, me.myLockdownCircleGeoJSON, me.nextLockdownCircleGeoJSON, me.legalAreaGeoJSON,
      me.hiderRole, me.safehouses?.map(s => [s.id, s.state]), (me.teammates || []).map(t => [t.coordinates, t.hiderRole]),
      slots(me.activeObjectives, me.activeObjective?.id, me.activeObjective?.coordinates)
    ] : ["hider-empty"]);
  }
  return JSON.stringify([
    "seeker",
    seeker?.mode,
    seeker?.globalSafeZoneGeoJSON,
    (seeker?.safehouses || []).map(s => [s.id, s.state]),
    (seeker?.seekers || []).map(s => s.coordinates),
    (seeker?.hiders || []).map(h => [h.delayedCoordinates, h.delayedTrail, h.lockdownCircleGeoJSON, slots(h.activeObjectives, h.activeObjective?.id, h.activeObjective?.coordinates)])
  ]);
}

function Settings({ config, onChange }: { config: GameConfig; onChange: (payload: AdminConfigPayload) => void }) {
  return <div className="card"><div className="card-title">Game Settings</div>
    <DualRange label="Objective spawn distance" low={config.objectiveMinDistance} high={config.objectiveMaxDistance} min={0} max={3000} step={50} unit="m" onChange={(objectiveMinDistance, objectiveMaxDistance) => onChange({ objectiveMinDistance, objectiveMaxDistance })} />
    <Range label="Game length (0 = no limit)" value={config.gameDurationMinutes} min={0} max={600} step={5} unit="m" onChange={gameDurationMinutes => onChange({ gameDurationMinutes })} />
    <Range label="Shrink" value={config.globalSqueezePercentage} min={1} max={50} step={1} unit="%" onChange={globalSqueezePercentage => onChange({ globalSqueezePercentage })} />
    <Range label="Shrink interval" value={config.shrinkIntervalSeconds} min={10} max={3600} step={10} unit="s" onChange={shrinkIntervalSeconds => onChange({ shrinkIntervalSeconds })} />
    <Range label="Ping interval" value={config.pingIntervalMinutes} min={0.1} max={30} step={0.1} unit="m" onChange={pingIntervalMinutes => onChange({ pingIntervalMinutes })} />
    <Range label="Delay" value={config.locationDelayMinutes} min={0} max={30} step={0.5} unit="m" onChange={locationDelayMinutes => onChange({ locationDelayMinutes })} />
    <Range label="Lockdown every" value={config.lockdownIntervalCount} min={1} max={20} step={1} unit="pings" onChange={lockdownIntervalCount => onChange({ lockdownIntervalCount })} />
    <Range label="Lockdown radius" value={config.lockdownRadius} min={50} max={2000} step={25} unit="m" onChange={lockdownRadius => onChange({ lockdownRadius })} />
    <Range label="Lockdown edge distance" value={config.lockdownForecastDistance} min={0} max={3000} step={25} unit="m" onChange={lockdownForecastDistance => onChange({ lockdownForecastDistance })} />
    <Range label="Lockdown duration" value={config.lockdownDurationSeconds} min={10} max={3600} step={10} unit="s" onChange={lockdownDurationSeconds => onChange({ lockdownDurationSeconds })} />
    <Range label="Regular objective points" value={config.regularObjectivePoints} min={1} max={20} step={1} unit="pt" onChange={regularObjectivePoints => onChange({ regularObjectivePoints })} />
    <Range label="Lockdown objective points" value={config.lockdownObjectivePoints} min={1} max={40} step={1} unit="pt" onChange={lockdownObjectivePoints => onChange({ lockdownObjectivePoints })} />
    {config.mode === "VIP_ESCORT" && <Range label="VIP objectives to win" value={config.vipObjectiveTarget} min={1} max={20} step={1} unit="" onChange={vipObjectiveTarget => onChange({ vipObjectiveTarget })} />}
    {config.mode === "SAFEHOUSES" && <Range label="Safehouse radius" value={config.safehouseRadius} min={10} max={500} step={5} unit="m" onChange={safehouseRadius => onChange({ safehouseRadius })} />}
    {config.mode === "SAFEHOUSES" && <Range label="Capture time to win" value={config.safehouseCaptureTargetSeconds} min={30} max={3600} step={30} unit="s" onChange={safehouseCaptureTargetSeconds => onChange({ safehouseCaptureTargetSeconds })} />}
  </div>;
}

function SafehousePanel({ safehouses }: { safehouses: Safehouse[] | undefined }) {
  if (!safehouses?.length) return null;
  return <div className="card"><div className="card-title">Safehouses</div>
    <div className="roster">
      {safehouses.map(s => <div key={s.id} className={`safehouse-row sh-${s.state}`}>
        <span className="player-name">{s.label}</span>
        <span className="mono">{s.objective.name}</span>
        <span className={`sh-state sh-${s.state}`}>{s.state}</span>
      </div>)}
    </div>
  </div>;
}

function CaptureCounter({ seconds, target }: { seconds: number | undefined; target: number | undefined }) {
  if (seconds == null || !target) return null;
  const pct = Math.min(100, Math.max(0, (seconds / target) * 100));
  return <div className="timer timer-stack capture-counter">
    <div className="row"><span className="kicker">group capture time</span><span className="time">{formatTime(seconds)} / {formatTime(target)}</span></div>
    <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
  </div>;
}

function Shell({ title, role, subtitle, onBack, children }: { title: string; role?: Role; subtitle?: string; onBack?: () => void; children: React.ReactNode }) {
  return <div className="app"><div className="screen"><div className="nav">{onBack && <button className="back" onClick={onBack}>&lt;</button>}<div className="title">{title}</div>{role && <div className={`badge ${role}`}>{role}</div>}{subtitle && <div className="badge">{subtitle}</div>}</div>{children}</div></div>;
}

function Roster({ roster }: { roster: PlayerPublic[] }) {
  return <div className="card"><div className="card-title">Connected Devices</div><div className="roster">{roster.map(p => <div className="player" key={p.id}><span className={`role-pill role-${p.role}`}>{p.role}</span><span className="player-name">{p.name}</span><span className="mono">{p.online ? "online" : "offline"}</span></div>)}</div></div>;
}

function Controls({ setMessage }: { setMessage: (message: string) => void }) {
  const control = (action: "resume" | "pause" | "end") => {
    socket.emit("admin_game_control", { action }, (ack: { ok: boolean; error?: string }) => {
      if (!ack?.ok) setMessage(`Admin action failed: ${ack?.error || "unknown"}`);
      else setMessage(action === "resume" ? "Game resumed" : action === "pause" ? "Game paused" : "Game ended");
    });
  };
  return <div className="card"><div className="card-title">Game Control</div><div className="controls"><button className="btn" onClick={() => control("resume")}>Start</button><button className="btn" onClick={() => control("pause")}>Pause</button><button className="btn danger" onClick={() => control("end")}>End</button></div></div>;
}

function Claims({ claims, setMessage }: { claims: NonNullable<AdminStatePayload["game"]>["claims"]; setMessage: (message: string) => void }) {
  const disallow = (claimId: string) => {
    socket.emit("admin_disallow_claim", { claimId, reason: prompt("Reason?") || "manual review" }, (ack: { ok: boolean; error?: string }) => {
      if (!ack?.ok) setMessage(`Claim disallow failed: ${ack?.error || "unknown"}`);
      else setMessage("Claim disallowed");
    });
  };
  return <div className="card"><div className="card-title">Claim Evidence</div>{claims.map(c => <div key={c.id} className="card soft"><div className="row"><strong>{c.hiderName}</strong><span className="mono">{c.status} / {c.scoreValue}pt</span></div><div className="mono">{c.objective.name} / {c.objectiveKind} / {Math.round(c.distanceMeters)}m</div><a href={assetUrl(c.photoUrl)} target="_blank"><img className="claim-img" src={assetUrl(c.photoUrl)} /></a>{c.status === "accepted" && <button className="btn danger" onClick={() => disallow(c.id)}>Disallow</button>}</div>)}</div>;
}

function GameOver({ winner, claims, leaderboard, durationSeconds, history, onLeave, isAdmin }: {
  winner: string;
  claims: NonNullable<AdminStatePayload["game"]>["claims"];
  leaderboard: LeaderboardEntry[];
  durationSeconds: number;
  history: GameHistoryEntry[];
  onLeave: () => void;
  isAdmin: boolean;
}) {
  return <Shell title="Mission Complete" subtitle="GAME OVER" onBack={onLeave}><div className="body"><div className="card soft text-center"><div className="role-big">{winner}</div><div className="mono">game time {formatDuration(durationSeconds)}</div></div><Leaderboard entries={leaderboard} />{isAdmin && claims.length ? <Claims claims={claims} setMessage={() => undefined} /> : null}{history.length ? <HistoryList history={history} /> : null}</div></Shell>;
}

function Leaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  return <div className="card"><div className="card-title">Leaderboard</div><div className="roster">{entries.map((entry, index) => <div className="player" key={entry.playerId}><span className="role-pill">{index + 1}</span><span className="player-name">{entry.name}</span><span className="mono">{entry.score}pt</span></div>)}</div></div>;
}

function HistoryList({ history }: { history: GameHistoryEntry[] }) {
  return <div className="card"><div className="card-title">Game History</div>{history.slice(0, 8).map(game => <div key={game.id} className="history-row"><div className="row"><strong>{game.id}</strong><span className="mono">{formatDuration(game.durationSeconds)}</span></div><div className="mono">hiding: {game.hiders.map(h => `${h.name} ${h.score}pt`).join(", ") || "none"}</div><div className="mono">seeking: {game.seekers.map(s => s.name).join(", ") || "none"}</div></div>)}</div>;
}

function Range({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  return <div className="field"><div className="field-label">{label}<strong>{value}{unit}</strong></div><input className="range" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /></div>;
}

// Two-handle slider — `low`/`high` are kept at least one `step` apart.
function DualRange({ label, low, high, min, max, step, unit, onChange }: { label: string; low: number; high: number; min: number; max: number; step: number; unit: string; onChange: (low: number, high: number) => void }) {
  const span = max - min || 1;
  const lowPct = ((low - min) / span) * 100;
  const highPct = ((high - min) / span) * 100;
  return <div className="field">
    <div className="field-label">{label}<strong>{low}{unit} – {high}{unit}</strong></div>
    <div className="dual-range">
      <div className="dual-track" />
      <div className="dual-fill" style={{ left: `${lowPct}%`, right: `${100 - highPct}%` }} />
      <input type="range" min={min} max={max} step={step} value={low} onChange={e => onChange(Math.min(Number(e.target.value), high - step), high)} />
      <input type="range" min={min} max={max} step={step} value={high} onChange={e => onChange(low, Math.max(Number(e.target.value), low + step))} />
    </div>
  </div>;
}

function NumberField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (value: number) => void }) {
  return <div className="field"><div className="field-label">{label}</div><input className="coord" type="number" step={step} value={value} onChange={e => onChange(Number(e.target.value))} /></div>;
}

function Timer({ seconds, total, label }: { seconds: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, seconds / total * 100)) : 0;
  if (label) {
    return <div className="timer timer-stack"><div className="row"><span className="kicker">{label}</span><span className="time">{formatTime(seconds)}</span></div><div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div></div>;
  }
  return <div className="timer row"><div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div><div className="time">{formatTime(seconds)}</div></div>;
}

function lockdownTimerState(me: NonNullable<HiderStatusPayload["me"]>, now: number) {
  if (me.lockdownExpiresAt && me.lockdownExpiresAt > now) {
    return {
      label: "current lockdown",
      seconds: (me.lockdownExpiresAt - now) / 1000,
      total: me.config.lockdownDurationSeconds
    };
  }
  if (me.nextLockdownStartsAt && me.nextLockdownStartsAt > now) {
    const startedAt = me.lockdownTravelStartedAt || Math.max(now, me.nextLockdownStartsAt - me.config.pingIntervalMinutes * 60 * me.config.lockdownIntervalCount * 1000);
    return {
      label: "reach next lockdown",
      seconds: (me.nextLockdownStartsAt - now) / 1000,
      total: Math.max(1, (me.nextLockdownStartsAt - startedAt) / 1000)
    };
  }
  return null;
}

function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return hours ? `${hours}h ${minutes}m ${rest}s` : `${minutes}m ${rest}s`;
}

function claimErrorText(error: string) {
  const labels: Record<string, string> = {
    location_unavailable: "live GPS location unavailable",
    location_stale: "live GPS location is too old",
    invalid_photo_type: "photo must be a JPG, PNG, WebP, HEIC, or HEIF image",
    photo_too_large: "photo is too large",
    too_far_from_objective: "you are too far from the objective",
    out_of_bounds: "return inside the play zone before claiming",
    objective_changed: "objective changed; reopen the claim sheet",
    not_vip: "only the VIP can claim objectives in this mode",
    no_objectives: "this mode has no claimable objectives"
  };
  return labels[error] || error;
}

function readPendingLocation(): LocationUpdatePayload | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_LOCATION_KEY) || "null") as Partial<LocationUpdatePayload> | null;
    if (!parsed || !Array.isArray(parsed.coordinates) || parsed.coordinates.length !== 2) return null;
    if (!Number.isFinite(parsed.coordinates[0]) || !Number.isFinite(parsed.coordinates[1])) return null;
    return {
      gameId: parsed.gameId,
      playerId: parsed.playerId,
      coordinates: parsed.coordinates as LngLat,
      accuracy: parsed.accuracy ?? null,
      timestamp: String(parsed.timestamp || new Date().toISOString())
    };
  } catch {
    return null;
  }
}

function writePendingLocation(payload: LocationUpdatePayload) {
  try {
    localStorage.setItem(PENDING_LOCATION_KEY, JSON.stringify(payload));
  } catch {
    // If storage is unavailable, the in-memory pending location still retries.
  }
}

function distanceMeters(a: LngLat, b: LngLat) {
  const R = 6371000;
  const toR = Math.PI / 180;
  const p1 = a[1] * toR;
  const p2 = b[1] * toR;
  const dp = (b[1] - a[1]) * toR;
  const dl = (b[0] - a[0]) * toR;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

createRoot(document.getElementById("root")!).render(<App />);
