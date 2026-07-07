import type { PlayerPublic, Role } from "@shared/types";

export function Lobby({ name, onNameChange, roster, myPlayerId, myRole, myReady, isAdmin, gameInProgress, canResume, message, onSelectRole, onToggleReady, onStartGame, onOpenAdmin, onResumeGame, onClaimPlayer }: {
  name: string;
  onNameChange: (name: string) => void;
  roster: PlayerPublic[];
  myPlayerId: string;
  myRole: Role | null;
  myReady: boolean;
  isAdmin: boolean;
  gameInProgress: boolean;
  canResume: boolean;
  message: string;
  onSelectRole: (role: "HIDE" | "SEEK") => void;
  onToggleReady: () => void;
  onStartGame: () => void;
  onOpenAdmin: () => void;
  onResumeGame: () => void;
  onClaimPlayer: (playerId: string) => void;
}) {
  const hiderCount = roster.filter(p => p.role === "HIDE").length;
  const seekerCount = roster.filter(p => p.role === "SEEK").length;
  return <div className="app">
    <div className="glow" />
    <div className="screen center-wrap">
      <div className="brand"><span>HIDE</span><span className="dot">&#8942;</span><span>SEEK</span></div>
      <div className="lobby-hero">
        <h1 className="lobby-title">Pick a side.</h1>
        <p className="lobby-sub">Choose your role, ready up, and wait for the countdown.</p>
      </div>
      {message && <div className="notice">{message}</div>}
      {gameInProgress && <div className="notice">A game is in progress. Tap a player's name below to open their terminal.</div>}
      <input className="name-input" type="text" placeholder="Your name" maxLength={18} value={name}
        onChange={e => onNameChange(e.target.value)} />
      {!gameInProgress && <div className="role-picker">
        <button className={`role-card teal${myRole === "HIDE" ? " selected" : ""}`} onClick={() => onSelectRole("HIDE")}>
          <div className="role-icon role-icon-hide" />
          <div className="role-name">HIDE</div>
          <div className="role-desc">Get to your objectives. Don't get caught.</div>
        </button>
        <button className={`role-card orange${myRole === "SEEK" ? " selected" : ""}`} onClick={() => onSelectRole("SEEK")}>
          <div className="role-icon role-icon-seek" />
          <div className="role-name">SEEK</div>
          <div className="role-desc">Track the route. Find the hiders.</div>
        </button>
      </div>}
      <div className="roster">
        <div className="roster-title">Lobby <span className="mono">({roster.length})</span></div>
        {roster.map(p => {
          const isMe = p.id === myPlayerId;
          const hasTerminal = p.role === "HIDE" || p.role === "SEEK";
          const resumable = isMe && canResume;
          const claimable = !isMe && gameInProgress && hasTerminal;
          return <div className={`roster-row${p.online ? "" : " offline"}${resumable || claimable ? " clickable" : ""}`} key={p.id} onClick={resumable ? onResumeGame : claimable ? () => onClaimPlayer(p.id) : undefined}>
            <div className={`roster-avatar ${p.role === "HIDE" ? "teal" : p.role === "SEEK" ? "orange" : "grey"}`}>{p.name[0]?.toUpperCase() || "?"}</div>
            <div className="roster-name">{p.name}{isMe ? " (you)" : ""}</div>
            {!p.online && <div className="roster-badge offline">OFFLINE</div>}
            {p.role && <div className={`roster-badge ${p.role === "HIDE" ? "hide" : "seek"}`}>{p.role === "HIDE" ? "HIDE" : "SEEK"}</div>}
            {resumable && <div className="roster-badge resume">RESUME</div>}
            {claimable && <div className="roster-badge resume">OPEN</div>}
            <div className={`ready-dot ${p.ready ? "on" : ""}`} />
          </div>;
        })}
      </div>
      {!gameInProgress && <div className="lobby-footer">
        <div className="counts-pill mono">{hiderCount} hiding &middot; {seekerCount} seeking</div>
        <div className="footer-btns">
          <button className={`ready-toggle${myReady ? " active" : ""}`} onClick={onToggleReady} disabled={!myRole}>
            {myReady ? "Ready ✓" : "Ready Up"}
          </button>
          {isAdmin && <button className="btn btn-primary" onClick={onStartGame}>Start Game</button>}
        </div>
      </div>}
      {!isAdmin && <button className="admin-link" onClick={onOpenAdmin}>Admin</button>}
    </div>
  </div>;
}
