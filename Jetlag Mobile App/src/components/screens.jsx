// screens.jsx — Home, Lobby, Countdown, Found, Leaderboard, Relocate
import { useState } from 'react';
import { Icon, Btn, CircleTimer } from './ui.jsx';
import { Gallery } from './shared.jsx';
import { fmtClock, fmtMins } from '../lib/ui-helpers.js';
import { DECK_BY_ID } from '../lib/data.js';

export function AppHeader({ role, onAdmin, onHome, showHome, tools }) {
  return (
    <div className="ph-header">
      <div className="ph-brand">
        <span className="ph-brand-dot" />
        <span className="ph-brand-name">JET&nbsp;LAG</span>
        {role && <span className={`role-tag role-${role}`}>{role}</span>}
      </div>
      <div className="ph-header-actions">
        {tools}
        {showHome && <button className="icon-btn" onClick={onHome} title="Home"><Icon name="close" size={18} /></button>}
        <button className="icon-btn" onClick={onAdmin} title="Admin"><Icon name="admin" size={19} /></button>
      </div>
    </div>
  );
}

export function HomeScreen({ phone, state, actions, onAdmin, onLeaderboard }) {
  const role = state.roles[phone];
  const other = phone === 'A' ? 'B' : 'A';
  const otherRole = state.roles[other];
  return (
    <div className="screen home">
      <AppHeader role={null} onAdmin={onAdmin} />
      <div className="home-hero">
        <div className="home-kicker">HIDE &amp; SEEK CONTROL</div>
        <h1 className="home-title">Pick your<br/>side.</h1>
        <p className="home-sub">This device is <b>Phone {phone}</b>. Choose a role to join the round.</p>
      </div>
      <div className="role-grid">
        <button className={`role-card role-card-hider${role === 'hider' ? ' is-on' : ''}`} onClick={() => actions.pickRole(phone, 'hider')}>
          <span className="role-card-glyph"><Icon name="flag" size={26} sw={2} /></span>
          <span className="role-card-name">Hider</span>
          <span className="role-card-desc">Draw cards, answer questions, run the clock.</span>
        </button>
        <button className={`role-card role-card-seeker${role === 'seeker' ? ' is-on' : ''}`} onClick={() => actions.pickRole(phone, 'seeker')}>
          <span className="role-card-glyph"><Icon name="radar" size={26} sw={2} /></span>
          <span className="role-card-name">Seeker</span>
          <span className="role-card-desc">Ask questions, share GPS, close in.</span>
        </button>
      </div>
      <button className="ghost-row" onClick={onLeaderboard}>
        <Icon name="trophy" size={18} /> <span>Leaderboard</span>
        <span className="ghost-row-end"><Icon name="chevron" size={16} /></span>
      </button>
      {otherRole && <div className="home-peer">Phone {other} is the <b>{otherRole}</b>.</div>}
    </div>
  );
}

export function LobbyScreen({ phone, state, actions, onAdmin, onHome }) {
  const role = state.roles[phone];
  const bothSet = !!(state.roles.A && state.roles.B);
  const bothReady = bothSet && state.roles.A !== state.roles.B;
  return (
    <div className="screen lobby">
      <AppHeader role={role} onAdmin={onAdmin} onHome={onHome} showHome />
      <div className="lobby-body">
        <div className={`lobby-badge role-${role}`}><Icon name={role === 'hider' ? 'flag' : 'radar'} size={34} sw={2} /></div>
        <h2 className="lobby-role">You are the {role}.</h2>
        <p className="lobby-note">When the round starts, a <b>{fmtMins(state.countdownMs)}</b> head start runs before {role === 'hider' ? 'your panel unlocks — use it to hide.' : 'the seeker panel unlocks.'}</p>
        <div className="lobby-peers"><PeerDot label="Phone A" role={state.roles.A} /><PeerDot label="Phone B" role={state.roles.B} /></div>
        <div className="lobby-actions">
          <Btn full size="lg" onClick={actions.startGame} disabled={!bothReady}>Start head start</Btn>
          {!bothReady && (
            <p className="lobby-hint">
              {bothSet
                ? 'Both phones picked the same role — one must be hider, one seeker.'
                : 'Waiting for the other phone to pick a side…'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function PeerDot({ label, role }) {
  return (
    <div className={`peer-dot${role ? ' is-ready' : ''}`}>
      <span className={`peer-ring role-${role || 'none'}`} />
      <span className="peer-label">{label}</span>
      <span className="peer-role">{role || 'choosing…'}</span>
    </div>
  );
}

export function CountdownScreen({ role, state, countdownRemaining, onAdmin }) {
  const isHider = role === 'hider';
  return (
    <div className="screen countdown">
      <AppHeader role={role} onAdmin={onAdmin} />
      <div className="cd-kicker">{isHider ? 'GO HIDE' : 'HOLD POSITION'}</div>
      <CircleTimer remaining={countdownRemaining} total={state.countdownMs} label={isHider ? 'until panel unlocks' : 'until you can seek'} accent={isHider ? 'var(--accent)' : 'var(--c-veto)'} />
      <p className="cd-note">{isHider ? 'Get as far as you can. Your card hand and question feed open when the timer hits zero.' : "No seeking yet. Sit tight — your question deck arms when the head start ends."}</p>
      <div className="cd-bottom"><span className="cd-feed">{state.feed[0]?.text}</span></div>
    </div>
  );
}

export function RelocateScreen({ role, state, relocateRemaining, onAdmin }) {
  const isHider = role === 'hider';
  return (
    <div className="screen countdown">
      <AppHeader role={role} onAdmin={onAdmin} />
      <div className="cd-kicker">{isHider ? 'MOVE — RELOCATE' : 'SEEKERS FROZEN'}</div>
      <CircleTimer remaining={relocateRemaining} total={60 * 60000} label={isHider ? 'to reach your new zone' : 'until the hunt resumes'} accent={isHider ? 'var(--accent)' : 'var(--c-veto)'} />
      <p className="cd-note">{isHider ? 'Your hiding timer is paused. Get to a new hiding zone before the clock runs out — the seekers are frozen in place.' : 'The hider has played Move. Hold position — your panel re-arms when the relocation window closes.'}</p>
      <div className="cd-bottom"><span className="cd-feed">{state.feed[0]?.text}</span></div>
    </div>
  );
}

export function FoundScreen({ role, state, actions, hideElapsed, onAdmin }) {
  const [names, setNames] = useState('');
  const isHider = role === 'hider';
  const bonuses = state.conditionalBonuses || [];
  const allVerified = bonuses.every(b => b.applies !== null);
  const totalExtraMin = bonuses.filter(b => b.applies === true).reduce((a, b) => a + b.min, 0);

  const timeCards = (state.hand || []).filter(h => DECK_BY_ID[h.cardId]?.type === 'time');
  const [redeemUids, setRedeemUids] = useState(() => new Set(timeCards.map(h => h.uid)));
  const toggleRedeem = (uid) => setRedeemUids(prev => { const n = new Set(prev); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });
  const redeemBonusMin = timeCards.filter(h => redeemUids.has(h.uid)).reduce((a, h) => a + (DECK_BY_ID[h.cardId]?.bonusMin || 0), 0);

  return (
    <div className="screen found">
      <AppHeader role={role} onAdmin={onAdmin} />
      <div className="found-mark"><Icon name="check" size={30} sw={3} /></div>
      <div className="found-kicker">HIDER FOUND</div>
      <div className="found-time">{fmtClock(hideElapsed)}</div>
      <div className="found-time-label">total time hidden</div>

      {bonuses.length > 0 && (
        <div className="found-bonuses">
          <div className="found-bonuses-label">
            {isHider ? 'Awaiting seeker verification…' : 'Verify bonus time conditions'}
          </div>
          {bonuses.map(b => (
            <div key={b.uid} className={`found-bonus-row${b.applies === true ? ' is-yes' : b.applies === false ? ' is-no' : ''}`}>
              <div className="found-bonus-head">
                <span className="found-bonus-title">{b.title}</span>
                <span className="found-bonus-min">+{b.min} min</span>
              </div>
              <div className="found-bonus-q">{b.question}</div>
              {!isHider && (
                <div className="found-bonus-btns">
                  <button
                    className={`found-bonus-btn${b.applies === true ? ' active-yes' : ''}`}
                    onClick={() => actions.toggleConditionalBonus(b.uid, true)}
                  >Yes — apply bonus</button>
                  <button
                    className={`found-bonus-btn${b.applies === false ? ' active-no' : ''}`}
                    onClick={() => actions.toggleConditionalBonus(b.uid, false)}
                  >No — skip</button>
                </div>
              )}
            </div>
          ))}
          {allVerified && totalExtraMin > 0 && (
            <div className="found-bonus-total">+{totalExtraMin} min bonus time confirmed</div>
          )}
        </div>
      )}

      {isHider && timeCards.length > 0 && (
        <div className="found-bonuses">
          <div className="found-bonuses-label">Redeem unplayed time cards</div>
          {timeCards.map(h => {
            const card = DECK_BY_ID[h.cardId];
            const on = redeemUids.has(h.uid);
            return (
              <div key={h.uid} className={`found-bonus-row${on ? ' is-yes' : ' is-no'}`}>
                <div className="found-bonus-head">
                  <span className="found-bonus-title">{card.title}</span>
                  <span className="found-bonus-min">+{card.bonusMin} min</span>
                </div>
                <div className="found-bonus-btns">
                  <button className={`found-bonus-btn${on ? ' active-yes' : ''}`} onClick={() => !on && toggleRedeem(h.uid)}>Redeem</button>
                  <button className={`found-bonus-btn${!on ? ' active-no' : ''}`} onClick={() => on && toggleRedeem(h.uid)}>Skip</button>
                </div>
              </div>
            );
          })}
          {redeemBonusMin > 0 && <div className="found-bonus-total">+{redeemBonusMin} min from time cards</div>}
        </div>
      )}

      {isHider ? (
        <div className="found-form">
          <label className="found-label">Sign the leaderboard</label>
          <input className="text-in" placeholder="Your name(s)" value={names} onChange={e => setNames(e.target.value)} maxLength={28} />
          <Btn full size="lg"
            onClick={() => names.trim() && actions.submitNames(names.trim(), [...redeemUids])}
            disabled={!names.trim() || (bonuses.length > 0 && !allVerified)}
          >
            {bonuses.length > 0 && !allVerified ? 'Waiting for seeker verification…' : 'Post time'}
          </Btn>
        </div>
      ) : <p className="found-wait">Nice hunt. Waiting for the hiders to sign the leaderboard…</p>}
    </div>
  );
}

export function LeaderboardScreen({ role, state, actions, onHome, onAdmin }) {
  const [view, setView] = useState(null);
  const rows = state.leaderboard.slice().sort((a, b) => b.ms - a.ms);
  if (view === 'gallery') return (
    <div className="screen">
      <div className="ph-header">
        <button className="icon-btn" onClick={() => setView(null)}><Icon name="back" size={20} /></button>
        <div className="sheet-title"><Icon name="gallery" size={18} /> Gallery</div>
        <span style={{ width: 36 }} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}><Gallery state={state} /></div>
    </div>
  );
  return (
    <div className="screen leaderboard">
      <AppHeader role={role} onAdmin={onAdmin} onHome={onHome} showHome={!!onHome} />
      <div className="lb-head">
        <span className="lb-trophy"><Icon name="trophy" size={22} sw={2} /></span>
        <h2 className="lb-title">Leaderboard</h2>
        <p className="lb-sub">Longest time hidden</p>
      </div>
      <div className="lb-list">
        {rows.length === 0 && <div className="lb-empty">No times yet.</div>}
        {rows.map((r, i) => (
          <div className={`lb-row${i === 0 ? ' is-top' : ''}`} key={i}>
            <span className="lb-rank">{i + 1}</span>
            <span className="lb-name">{r.names}</span>
            <span className="lb-ms">{fmtClock(r.ms)}</span>
          </div>
        ))}
      </div>
      {state.phase === 'leaderboard' && (
        <div className="lb-foot">
          <Btn full variant="outline" onClick={() => setView('gallery')}><Icon name="gallery" size={16} /> View &amp; download gallery</Btn>
          <Btn full onClick={actions.reset} style={{ marginTop: 10 }}>New game</Btn>
        </div>
      )}
    </div>
  );
}
