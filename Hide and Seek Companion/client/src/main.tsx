import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
import "./styles.css";
import { apiUrl, socketIoPath, socketServerUrl } from "./api";
import type {
  CountdownTickPayload,
  GameConfig,
  GameOverPayload,
  GamePhase,
  GameStartedPayload,
  HiderStatusPayload,
  JoinGamePayload,
  LobbyUpdatePayload,
  PlayerCaughtPayload,
  PlayerPublic,
  ProofAcceptedPayload,
  ProofRecord,
  Role,
  SeekerStatusPayload
} from "@shared/types";
import { Lobby } from "./screens/Lobby";
import { AdminLock } from "./screens/AdminLock";
import { AdminPanel } from "./screens/AdminPanel";
import { Countdown } from "./screens/Countdown";
import { HiderTerminal } from "./screens/HiderTerminal";
import { SeekerTerminal } from "./screens/SeekerTerminal";
import { GameEnd } from "./screens/GameEnd";

type Screen = "lobby" | "admin-lock" | "admin-panel" | "countdown" | "hider" | "seeker" | "end";

const socket: Socket = io(socketServerUrl(), { path: socketIoPath() });

function App() {
  const [screen, setScreen] = useState<Screen>("lobby");
  const [name, setName] = useState(localStorage.getItem("hs_name") || "");
  const [playerId, setPlayerId] = useState(localStorage.getItem("hs_player_id") || "");
  const [playerSecret, setPlayerSecret] = useState(localStorage.getItem("hs_player_secret") || "");
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [amAdmin, setAmAdmin] = useState(false);
  const [myReady, setMyReady] = useState(false);
  const [gameInProgress, setGameInProgress] = useState(false);
  const [phase, setPhase] = useState<GamePhase>("lobby");
  const [roster, setRoster] = useState<PlayerPublic[]>([]);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [estimate, setEstimate] = useState(0);
  const [message, setMessage] = useState("");
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [hiderStatus, setHiderStatus] = useState<HiderStatusPayload | null>(null);
  const [seekerStatus, setSeekerStatus] = useState<SeekerStatusPayload | null>(null);
  const [gameOverPayload, setGameOverPayload] = useState<GameOverPayload | null>(null);
  const [adminReturnScreen, setAdminReturnScreen] = useState<Screen>("lobby");
  // Gated on "active" specifically (not just gameInProgress, which also covers "countdown"/"ended")
  // because that's the only phase gameTick actually delivers hider_status/seeker_status in — opening
  // a terminal during any other phase would be a dead click that never renders.
  const gameActive = phase === "active";
  const canResume = gameActive && ((myRole === "HIDE" && !!hiderStatus) || (myRole === "SEEK" && !!seekerStatus));

  const identityRef = useRef({ playerId, playerSecret });
  useEffect(() => { identityRef.current = { playerId, playerSecret }; }, [playerId, playerSecret]);
  const roleRef = useRef<Role | null>(myRole);
  useEffect(() => { roleRef.current = myRole; }, [myRole]);
  const hiderStatusRef = useRef<HiderStatusPayload | null>(null);
  useEffect(() => { hiderStatusRef.current = hiderStatus; }, [hiderStatus]);
  const gameStartedAtRef = useRef<number | null>(null);
  const myProofsRef = useRef<ProofRecord[]>([]);
  const connectedOnceRef = useRef(false);
  // lobby_update now also broadcasts mid-game (so the roster stays live for anyone browsing the
  // Lobby), which would otherwise re-trigger the auto-restore below on every unrelated roster
  // change and yank the player back into their terminal. Only run it once per connection.
  const autoRestorePendingRef = useRef(true);

  useEffect(() => {
    const onLobbyUpdate = (payload: LobbyUpdatePayload) => {
      setRoster(payload.roster);
      setConfig(payload.config);
      setEstimate(payload.estimate);
      setGameInProgress(payload.phase !== "lobby");
      setPhase(payload.phase);
      const me = payload.roster.find(p => p.id === identityRef.current.playerId);
      if (me) {
        setMyRole(me.role);
        setMyReady(me.ready);
      }
      // Restores the right terminal after a page refresh mid-game — this event fires immediately
      // on every new socket connection (including a fresh page load), before join_game even resolves,
      // so `me` may still be unresolved on that first event. Keep waiting until it resolves instead
      // of spending the one-shot on an event where our own identity isn't known yet.
      if (autoRestorePendingRef.current && me) {
        autoRestorePendingRef.current = false;
        if (me.role === "HIDE" || me.role === "SEEK") {
          if (payload.phase === "countdown") setScreen("countdown");
          else if (payload.phase === "active") setScreen(me.role === "HIDE" ? "hider" : "seeker");
        }
      }
    };
    const onCountdownTick = (payload: CountdownTickPayload) => {
      setCountdownSeconds(payload.secondsRemaining);
      setScreen("countdown");
    };
    const onGameStarted = (payload: GameStartedPayload) => {
      gameStartedAtRef.current = payload.game.startedAt;
      myProofsRef.current = [];
      setGameOverPayload(null);
      setScreen(roleRef.current === "HIDE" ? "hider" : "seeker");
    };
    const onHiderStatus = (payload: HiderStatusPayload) => setHiderStatus(payload);
    const onSeekerStatus = (payload: SeekerStatusPayload) => setSeekerStatus(payload);
    const onProofAccepted = (payload: ProofAcceptedPayload) => {
      if (payload.hiderId === identityRef.current.playerId) myProofsRef.current = [...myProofsRef.current, payload.proof];
    };
    const onPlayerCaught = (payload: PlayerCaughtPayload) => {
      if (payload.playerId !== identityRef.current.playerId) return;
      if (payload.becameSeeker) {
        setMyRole("SEEK");
        setHiderStatus(null);
        setMessage("You were caught! You're now a Seeker.");
        setScreen("seeker");
        return;
      }
      const status = hiderStatusRef.current;
      const elapsedSeconds = gameStartedAtRef.current ? Math.round((Date.now() - gameStartedAtRef.current) / 1000) : 0;
      setGameOverPayload({
        endReason: "caught",
        stats: {
          hiders: [{ playerId: payload.playerId, name: payload.name, objectivesCompleted: status?.objectiveIndex ?? 0, totalObjectives: status?.totalObjectives ?? 0, caughtAt: Date.now() }],
          totalObjectives: status?.totalObjectives ?? 0,
          elapsedSeconds
        },
        gallery: myProofsRef.current
      });
      setScreen("end");
    };
    const onGameOver = (payload: GameOverPayload) => {
      setGameOverPayload(payload);
      setScreen("end");
    };
    const onForceReset = () => {
      setGameOverPayload(null);
      setHiderStatus(null);
      setSeekerStatus(null);
      setCountdownSeconds(null);
      setScreen(roleRef.current === "ADMIN" ? "admin-panel" : "lobby");
    };
    const onConnect = () => {
      autoRestorePendingRef.current = true;
      const { playerId: pid, playerSecret: secret } = identityRef.current;
      if (connectedOnceRef.current && pid && secret && roleRef.current !== "ADMIN") {
        socket.emit("join_game", { name: localStorage.getItem("hs_name") || "Player", role: roleRef.current, playerId: pid, playerSecret: secret });
      }
      connectedOnceRef.current = true;
    };
    socket.on("lobby_update", onLobbyUpdate);
    socket.on("countdown_tick", onCountdownTick);
    socket.on("game_started", onGameStarted);
    socket.on("hider_status", onHiderStatus);
    socket.on("seeker_status", onSeekerStatus);
    socket.on("proof_accepted", onProofAccepted);
    socket.on("player_caught", onPlayerCaught);
    socket.on("game_over", onGameOver);
    socket.on("force_reset", onForceReset);
    if (socket.connected) connectedOnceRef.current = true;
    socket.on("connect", onConnect);
    return () => {
      socket.off("lobby_update", onLobbyUpdate);
      socket.off("countdown_tick", onCountdownTick);
      socket.off("game_started", onGameStarted);
      socket.off("hider_status", onHiderStatus);
      socket.off("seeker_status", onSeekerStatus);
      socket.off("proof_accepted", onProofAccepted);
      socket.off("player_caught", onPlayerCaught);
      socket.off("game_over", onGameOver);
      socket.off("force_reset", onForceReset);
      socket.off("connect", onConnect);
    };
  }, []);

  useEffect(() => {
    const storedRole = localStorage.getItem("hs_role") as Role | null;
    join({ name: name || "Player", role: storedRole === "ADMIN" ? null : storedRole, playerId, playerSecret });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function join(payload: Partial<JoinGamePayload>) {
    socket.emit("join_game", {
      name: payload.name || name || "Player",
      role: payload.role ?? null,
      adminPin: payload.adminPin,
      playerId: payload.playerId || null,
      playerSecret: payload.playerSecret || null
    }, (ack: { ok: boolean; error?: string; playerId?: string; playerSecret?: string; role?: Role | null }) => {
      if (!ack.ok || !ack.playerId || !ack.playerSecret) {
        setMessage(`Join failed: ${ack.error || "unknown"}`);
        return;
      }
      setPlayerId(ack.playerId);
      setPlayerSecret(ack.playerSecret);
      setMyRole(ack.role ?? null);
      localStorage.setItem("hs_player_id", ack.playerId);
      localStorage.setItem("hs_player_secret", ack.playerSecret);
      localStorage.setItem("hs_name", payload.name || name || "Player");
      if (ack.role) localStorage.setItem("hs_role", ack.role); else localStorage.removeItem("hs_role");
      if (ack.role === "ADMIN") { setAmAdmin(true); setAdminReturnScreen("lobby"); setScreen("admin-panel"); }
    });
  }

  function onNameChange(next: string) {
    setName(next);
    join({ name: next, role: myRole, playerId, playerSecret });
  }

  function selectRole(role: "HIDE" | "SEEK") {
    socket.emit("select_role", { role }, (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) setMessage(`Could not select role: ${ack.error || "unknown"}`);
      else { setMyRole(role); setMyReady(false); }
    });
  }

  function toggleReady() {
    const next = !myReady;
    socket.emit("set_ready", { ready: next }, (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) setMessage(`Could not update ready state: ${ack.error || "unknown"}`);
      else setMyReady(next);
    });
  }

  function resumeGame() {
    setScreen(myRole === "HIDE" ? "hider" : "seeker");
  }

  function claimPlayer(targetPlayerId: string) {
    socket.emit("claim_player", { playerId: targetPlayerId }, (ack: { ok: boolean; error?: string; playerId?: string; playerSecret?: string; role?: Role | null; name?: string; hiderStatus?: HiderStatusPayload; seekerStatus?: SeekerStatusPayload }) => {
      if (!ack.ok || !ack.playerId || !ack.playerSecret) {
        setMessage(`Could not open that player's terminal: ${claimErrorText(ack.error || "unknown")}`);
        return;
      }
      setPlayerId(ack.playerId);
      setPlayerSecret(ack.playerSecret);
      setMyRole(ack.role ?? null);
      localStorage.setItem("hs_player_id", ack.playerId);
      localStorage.setItem("hs_player_secret", ack.playerSecret);
      if (ack.name) { setName(ack.name); localStorage.setItem("hs_name", ack.name); }
      if (ack.role) localStorage.setItem("hs_role", ack.role); else localStorage.removeItem("hs_role");
      // The ack carries the terminal's current state, so the switch renders immediately — without
      // this, the terminal's render guard fails until the next server tick and the click looks dead.
      if (ack.role === "HIDE" && ack.hiderStatus) {
        setHiderStatus(ack.hiderStatus);
        setSeekerStatus(null);
        setScreen("hider");
      } else if (ack.role === "SEEK" && ack.seekerStatus) {
        setSeekerStatus(ack.seekerStatus);
        setHiderStatus(null);
        setScreen("seeker");
      }
    });
  }

  function backToLobby() {
    setScreen("lobby");
  }

  function updateConfig(partial: Partial<GameConfig>) {
    socket.emit("admin_update_config", partial, (ack: { ok: boolean; error?: string; config?: GameConfig; estimate?: number }) => {
      if (!ack.ok) { setMessage(`Config update failed: ${ack.error || "unknown"}`); return; }
      if (ack.config) setConfig(ack.config);
      if (ack.estimate != null) setEstimate(ack.estimate);
    });
  }

  function startGame() {
    socket.emit("admin_start_game", {}, (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) setMessage(`Could not start game: ${startErrorText(ack.error || "unknown")}`);
    });
  }

  async function submitProof(objectiveIndex: number, photo: File): Promise<{ ok: boolean; error?: string }> {
    const form = new FormData();
    form.append("playerId", playerId);
    form.append("playerSecret", playerSecret);
    form.append("objectiveIndex", String(objectiveIndex));
    form.append("photo", photo);
    try {
      const response = await fetch(apiUrl("/api/proofs"), { method: "POST", body: form });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.ok) {
        setMessage(`Proof failed: ${proofErrorText(json.error || String(response.status))}`);
        return { ok: false, error: json.error };
      }
      return { ok: true };
    } catch {
      setMessage("Proof failed: network error");
      return { ok: false, error: "network_error" };
    }
  }

  function confirmCaught() {
    socket.emit("hider_caught", {}, (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) setMessage(`Could not confirm caught: ${ack.error || "unknown"}`);
    });
  }

  function submitAdminPin(pin: string) {
    join({ name: name || "Admin", role: "ADMIN", adminPin: pin });
  }

  function playAgain() {
    socket.emit("admin_reset", {}, (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) setMessage(`Reset failed: ${ack.error || "unknown"}`);
    });
  }

  function openAdminPanel() {
    setAdminReturnScreen(screen);
    setScreen("admin-panel");
  }

  function endGame() {
    socket.emit("admin_end_game", {}, (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) setMessage(`Could not end game: ${ack.error || "unknown"}`);
    });
  }

  function removeInactive() {
    socket.emit("admin_remove_inactive", {}, (ack: { ok: boolean; error?: string; removed?: number }) => {
      if (!ack.ok) setMessage(`Could not remove inactive players: ${ack.error || "unknown"}`);
      else setMessage(ack.removed ? `Removed ${ack.removed} inactive player${ack.removed === 1 ? "" : "s"}.` : "No inactive players to remove.");
    });
  }

  if (screen === "admin-lock") return <AdminLock message={message} onSubmit={submitAdminPin} onBack={() => setScreen("lobby")} />;
  if (screen === "admin-panel" && config) return <AdminPanel config={config} estimate={estimate} roster={roster} message={message} onUpdateConfig={updateConfig} onStartGame={startGame} onBack={() => setScreen(adminReturnScreen)} onResetAll={playAgain} onRemoveInactive={removeInactive} />;
  if (screen === "countdown") return <Countdown secondsRemaining={countdownSeconds} />;
  if (screen === "hider" && hiderStatus) return <HiderTerminal name={name} status={hiderStatus} message={message} isAdmin={amAdmin} onSubmitProof={submitProof} onCaught={confirmCaught} onEndGame={endGame} onOpenAdmin={openAdminPanel} onBackToLobby={backToLobby} />;
  if (screen === "seeker" && seekerStatus) return <SeekerTerminal name={name} status={seekerStatus} message={message} isAdmin={amAdmin} onEndGame={endGame} onOpenAdmin={openAdminPanel} onBackToLobby={backToLobby} />;
  if (screen === "end" && gameOverPayload) return <GameEnd endReason={gameOverPayload.endReason} stats={gameOverPayload.stats} gallery={gameOverPayload.gallery} isAdmin={amAdmin} onPlayAgain={playAgain} />;
  return <Lobby
    name={name}
    onNameChange={onNameChange}
    roster={roster}
    myPlayerId={playerId}
    myRole={myRole}
    myReady={myReady}
    isAdmin={amAdmin}
    gameInProgress={gameInProgress}
    gameActive={gameActive}
    canResume={canResume}
    message={message}
    onSelectRole={selectRole}
    onToggleReady={toggleReady}
    onStartGame={startGame}
    onOpenAdmin={() => setScreen("admin-lock")}
    onResumeGame={resumeGame}
    onClaimPlayer={claimPlayer}
  />;
}

function startErrorText(error: string) {
  const labels: Record<string, string> = {
    need_hider_and_seeker: "need at least one HIDE and one SEEK player",
    not_all_ready: "every connected player must pick a role and ready up",
    no_poi_data_for_region: "no preloaded map data for this location (only United Kingdom is preloaded)",
    not_enough_objectives: "not enough real places nearby for the requested objective count",
    route_generation_failed: "could not build a route from the available places",
    admin_required: "admin access required"
  };
  return labels[error] || error;
}

function claimErrorText(error: string) {
  const labels: Record<string, string> = {
    game_not_active: "no game is currently running",
    player_not_found: "that player no longer exists",
    no_terminal: "their run has already ended"
  };
  return labels[error] || error;
}

function proofErrorText(error: string) {
  const labels: Record<string, string> = {
    invalid_photo_type: "photo must be a JPG, PNG, WebP, HEIC, or HEIF image",
    photo_too_large: "photo is too large (max 50MB)",
    objective_changed: "objective changed; reload and try again",
    hider_caught: "your run has already ended"
  };
  return labels[error] || error;
}

createRoot(document.getElementById("root")!).render(<App />);
