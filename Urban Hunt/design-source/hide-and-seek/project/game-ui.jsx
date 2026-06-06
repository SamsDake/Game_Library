// game-ui.jsx — Shared components + Lobby (no game code) + WaitingRoom + GameOver
// Exports: GameNavBar, GameProximity, GameZoneTimer, GameZoneHealth,
//          GameObjective, GameLockdown, GameLobby, WaitingRoom, GameOver

const { useState } = React;

function GameNavBar({ title, role, subtitle, onBack }) {
  const roleCls = role === 'HIDER' ? 'badge-hider' : role === 'SEEKER' ? 'badge-seeker' : role === 'ADMIN' ? 'badge-admin' : '';
  return (
    <div className="navbar">
      {onBack && <button className="btn-back" onClick={onBack}>‹</button>}
      <span className="navbar-title">{title}</span>
      {role && <span className={`navbar-role-badge ${roleCls}`}>{role}</span>}
      {subtitle && <span className="navbar-badge">{subtitle}</span>}
    </div>
  );
}

function GameProximity({ status }) {
  const cls = status === 'Near' ? 'prox-near' : status === 'Far' ? 'prox-far' : 'prox-distant';
  return (
    <div className="proximity-display">
      <span className="proximity-label">proximity to nearest seeker</span>
      <span className={`proximity-value ${cls}`}>{status}</span>
    </div>
  );
}

function GameZoneTimer({ seconds, totalSeconds }) {
  const s  = Math.max(0, seconds);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const pct = totalSeconds > 0 ? (s / totalSeconds) * 100 : 0;
  return (
    <div className="zone-timer">
      <div className="zone-timer-info">
        <div className="zone-timer-label">zone shrinks in</div>
        <div className="zone-timer-bar">
          <div className="zone-timer-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="zone-timer-value">{mm}:{ss}</div>
    </div>
  );
}

function GameZoneHealth({ current, original }) {
  const pct = original > 0 ? Math.round((current / original) * 100) : 100;
  return (
    <div className="zone-health">
      <div className="zone-health-label">zone</div>
      <div className="zone-health-bar">
        <div className="zone-health-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="zone-health-val">{Math.round(current)}m</div>
    </div>
  );
}

function GameObjective({ objective, distance }) {
  if (!objective) return null;
  return (
    <div className="objective-card">
      <div className="objective-header">
        <span className="objective-tag">◎ active objective</span>
        {distance != null && <span className="objective-dist">{Math.round(distance)}m</span>}
      </div>
      <div className="objective-name">{objective.name}</div>
    </div>
  );
}

function GameLockdown({ active, radius }) {
  if (!active) return null;
  return (
    <div className="lockdown-badge">
      <div className="lockdown-dot" />
      <span className="lockdown-text">lockdown active — {radius}m radius</span>
    </div>
  );
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function GameLobby({ onJoin }) {
  const [name,     setName]     = useState('');
  const [tapCount, setTapCount] = useState(0);
  const timerRef = React.useRef(null);

  const handleLogoTap = () => {
    const next = tapCount + 1;
    setTapCount(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (next >= 3) { onJoin('ADMIN', 'CONTROL'); setTapCount(0); return; }
    timerRef.current = setTimeout(() => setTapCount(0), 1200);
  };

  return (
    <div className="lobby">
      <div style={{ textAlign: 'center', cursor: 'pointer', userSelect: 'none' }} onClick={handleLogoTap}>
        <div className="lobby-logo">HIDE &amp; SEEK</div>
        <div className="lobby-sub">Urban Hunt System · v1.0</div>
      </div>

      <input
        className="lobby-input"
        placeholder="ENTER CALL SIGN"
        value={name}
        onChange={e => setName(e.target.value)}
        maxLength={20}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="characters"
      />

      <div className="role-cards">
        <div className="role-card hider-card" onClick={() => onJoin('HIDER', name || 'Ghost')}>
          <div className="role-card-glyph hider-glyph">◈</div>
          <div className="role-card-label">HIDE</div>
          <div className="role-card-desc">evade detection.<br />complete objectives.</div>
        </div>
        <div className="role-card seeker-card" onClick={() => onJoin('SEEKER', name || 'Alpha')}>
          <div className="role-card-glyph seeker-glyph">◉</div>
          <div className="role-card-label">SEEK</div>
          <div className="role-card-desc">hunt the hider.<br />close the net.</div>
        </div>
      </div>

      <button className="admin-link" onClick={() => onJoin('ADMIN', 'CONTROL')}>
        · · · admin access · · ·
      </button>
    </div>
  );
}

// ── Waiting Room ──────────────────────────────────────────────────────────────
function WaitingRoom({ roster, myRole, myName }) {
  const hiders  = roster.filter(p => p.role === 'HIDER');
  const seekers = roster.filter(p => p.role === 'SEEKER');
  const roleColor = myRole === 'HIDER' ? 'var(--secondary)' : 'var(--danger)';

  return (
    <div className="waiting-room">
      <GameNavBar title="HIDE &amp; SEEK" subtitle="WAITING" />

      <div className="waiting-body">
        {/* Role confirmation */}
        <div className="my-role-display">
          <div className="my-role-label">your role</div>
          <div className="my-role-value" style={{ color: roleColor, textShadow: `0 0 20px ${roleColor}88` }}>
            {myRole}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text2)', letterSpacing: 2 }}>
            {myName}
          </div>
        </div>

        {/* Roster */}
        <div className="acard">
          <div className="acard-title">◆ Connected Devices</div>
          <div className="roster-list">
            {roster.map(p => (
              <div key={p.id} className="roster-item">
                <span className="roster-glyph" style={{ color: p.role === 'HIDER' ? 'var(--secondary)' : 'var(--danger)' }}>
                  {p.role === 'HIDER' ? '◈' : '◉'}
                </span>
                <span className="roster-name">{p.name}</span>
                {p.id === 'me' && <span className="you-tag">you</span>}
                <span className={`roster-role ${p.role === 'HIDER' ? 'badge-hider' : 'badge-seeker'}`}>
                  {p.role}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Counts */}
        <div className="stats-row">
          <div className="stat-box">
            <div className="stat-val" style={{ color: 'var(--secondary)' }}>{hiders.length}</div>
            <div className="stat-label">hiders</div>
          </div>
          <div className="stat-box">
            <div className="stat-val" style={{ color: 'var(--danger)' }}>{seekers.length}</div>
            <div className="stat-label">seekers</div>
          </div>
          <div className="stat-box">
            <div className="stat-val">{roster.length}</div>
            <div className="stat-label">total</div>
          </div>
        </div>

        {/* Waiting indicator */}
        <div className="waiting-notice">
          <div className="waiting-dots">
            <div className="wd" /><div className="wd" /><div className="wd" />
          </div>
          <div className="waiting-notice-text">waiting for admin to start</div>
        </div>
      </div>
    </div>
  );
}

// ── Game Over ─────────────────────────────────────────────────────────────────
function GameOver({ winner, stats, onRestart }) {
  const winColor = winner === 'SEEKERS' ? 'var(--danger)' : 'var(--secondary)';
  const winSub   = winner === 'SEEKERS' ? 'target located & neutralised' : 'all objectives cleared · extraction complete';
  return (
    <div className="gameover">
      <div className="go-sup">mission terminated</div>
      <div className="go-title" style={{ color: winColor, textShadow: `0 0 40px ${winColor}88` }}>
        {winner}<br />WIN
      </div>
      <div className="go-sub">{winSub}</div>
      <div className="go-stats">
        <div className="go-stat">
          <div className="go-stat-val">{stats.duration}</div>
          <div className="go-stat-label">duration</div>
        </div>
        <div className="go-stat">
          <div className="go-stat-val">{stats.objectives}</div>
          <div className="go-stat-label">objectives</div>
        </div>
        <div className="go-stat">
          <div className="go-stat-val">{stats.zoneSize}%</div>
          <div className="go-stat-label">zone remaining</div>
        </div>
        <div className="go-stat">
          <div className="go-stat-val">{stats.oobCount}</div>
          <div className="go-stat-label">oob events</div>
        </div>
      </div>
      <button className="go-btn" onClick={onRestart}>NEW MISSION</button>
    </div>
  );
}

Object.assign(window, {
  GameNavBar, GameProximity, GameZoneTimer, GameZoneHealth,
  GameObjective, GameLockdown, GameLobby, WaitingRoom, GameOver,
});
