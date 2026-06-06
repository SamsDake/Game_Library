// AdminOverlay.jsx — code-locked admin panel
import { useState, useEffect, useMemo } from 'react';
import { Icon, Btn } from './ui.jsx';
import { DECK, CARD_TYPES, POWERUP_POOL, TIME_POOL, DEFAULT_DECK_CONFIG, ADMIN_CODE } from '../lib/data.js';
import { useCountries, countryId } from '../lib/useCountries.js';
import { unionAll } from '../lib/geometry.js';
import { fmtClock } from '../lib/ui-helpers.js';

export function AdminLock({ onUnlock, onClose, title = 'Admin locked', sub = 'Enter the 4-digit admin code.' }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState(false);
  const submit = (val) => { if (val === ADMIN_CODE) onUnlock(); else { setErr(true); setCode(''); } };
  const append = (d) => { setErr(false); const next = (code + d).slice(0, 4); setCode(next); if (next.length === 4) submit(next); };
  return (
    <div className="admin-panel admin-lock">
      <div className="admin-head">
        <div className="admin-title"><Icon name="lock" size={19} /> {title}</div>
        {onClose && <button className="icon-btn" onClick={onClose}><Icon name="close" size={20} /></button>}
      </div>
      <div className="lock-body">
        <p className="lock-sub">{sub}</p>
        <div className={`lock-dots${err ? ' is-err' : ''}`}>{[0, 1, 2, 3].map(i => <span key={i} className={`lock-dot${code.length > i ? ' is-on' : ''}`} />)}</div>
        {err && <div className="lock-err">Wrong code — try again.</div>}
        <div className="keypad">
          {['1','2','3','4','5','6','7','8','9'].map(d => <button key={d} className="key" onClick={() => append(d)}>{d}</button>)}
          <button className="key key-ghost" onClick={() => { setCode(''); setErr(false); }}>clr</button>
          <button className="key" onClick={() => append('0')}>0</button>
          <button className="key key-ghost" onClick={() => setCode(c => c.slice(0, -1))}>⌫</button>
        </div>
      </div>
    </div>
  );
}

function Stepper({ value, onLess, onMore, min = 0 }) {
  return (
    <div className="stepper">
      <button className="step-btn" disabled={value <= min} onClick={onLess}>−</button>
      <span className="step-val">{value}</span>
      <button className="step-btn" onClick={onMore}>+</button>
    </div>
  );
}

function Section({ title, badge, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="admin-block">
      <button className="admin-label" style={{ width: '100%', display: 'flex', alignItems: 'center', cursor: 'pointer', background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
        onClick={() => setOpen(o => !o)}>
        <span style={{ flex: 1 }}>{title}{badge && <span className="admin-val">{badge}</span>}</span>
        <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 8 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && children}
    </div>
  );
}

function DeckConfigBlock({ state, actions }) {
  const cfg = state.deckConfig || DEFAULT_DECK_CONFIG;
  const set = (next) => actions.setDeckConfig(next);
  const total = cfg.curses + Object.values(cfg.powerups || {}).reduce((a, b) => a + b, 0) + Object.values(cfg.time || {}).reduce((a, b) => a + b, 0);
  return (
    <Section title="Hider deck" badge={`${total} cards${state.phase !== 'lobby' ? ' · live' : ''}`}>
      <div className="deckcfg">
        <div className="deckcfg-row deckcfg-curse">
          <span className="deckcfg-name"><Icon name="curse" size={14} sw={2} /> Curses (random draw)</span>
          <Stepper value={cfg.curses} onLess={() => set({ ...cfg, curses: Math.max(0, cfg.curses - 1) })} onMore={() => set({ ...cfg, curses: cfg.curses + 1 })} />
        </div>
        <div className="deckcfg-sub">Powerups</div>
        {POWERUP_POOL.map(c => (
          <div className="deckcfg-row" key={c.id}>
            <span className="deckcfg-name deckcfg-pow">{c.title}</span>
            <Stepper value={cfg.powerups?.[c.id] || 0} onLess={() => set({ ...cfg, powerups: { ...cfg.powerups, [c.id]: Math.max(0, (cfg.powerups?.[c.id] || 0) - 1) } })} onMore={() => set({ ...cfg, powerups: { ...cfg.powerups, [c.id]: (cfg.powerups?.[c.id] || 0) + 1 } })} />
          </div>
        ))}
        <div className="deckcfg-sub">Time bonuses</div>
        {TIME_POOL.map(c => (
          <div className="deckcfg-row" key={c.id}>
            <span className="deckcfg-name deckcfg-time">{c.title}</span>
            <Stepper value={cfg.time?.[c.id] || 0} onLess={() => set({ ...cfg, time: { ...cfg.time, [c.id]: Math.max(0, (cfg.time?.[c.id] || 0) - 1) } })} onMore={() => set({ ...cfg, time: { ...cfg.time, [c.id]: (cfg.time?.[c.id] || 0) + 1 } })} />
          </div>
        ))}
      </div>
      <p className="deckcfg-hint">Set the deck before the game. Changing it reshuffles the draw pile.</p>
    </Section>
  );
}

// ── Game area: searchable country picker (admin-only) ─────────────
function GameAreaBlock({ state, actions }) {
  const { countries, loading } = useCountries();
  const current = state.map.selectedCountryIds;
  const [sel, setSel] = useState(() => new Set(current));
  const [search, setSearch] = useState('');

  // Stay in sync if the selection changes elsewhere (other device / reset).
  // Keyed on a stable string — `current` is a fresh array on every WS sync, so
  // depending on it directly would reset the admin's in-progress picks each sync.
  const currentKey = current.join(',');
  useEffect(() => { setSel(new Set(current)); }, [currentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const idOf = countryId;
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return countries
      .filter(f => (f.properties?.NAME || '').toLowerCase().includes(needle))
      .sort((a, b) => (a.properties?.NAME || '').localeCompare(b.properties?.NAME || ''));
  }, [countries, search]);

  const toggle = (id) => setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const dirty = sel.size !== current.length || current.some(id => !sel.has(id));

  const apply = () => {
    const feats = countries.filter(f => sel.has(idOf(f)));
    actions.mapSetCountries([...sel], feats.length ? unionAll(feats) : null);
  };

  return (
    <Section title="Game area" badge={`${current.length} in play`}>
      <p className="map-hint" style={{ marginBottom: 10 }}>Pick the countries in play. The seeker's zone starts as the union of all selected countries.</p>
      <input className="text-in" style={{ marginBottom: 8 }} placeholder="Search countries…" value={search} onChange={e => setSearch(e.target.value)} />
      {loading && <p className="map-hint">Loading country data…</p>}
      <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {filtered.map(f => {
          const id = idOf(f); const name = f.properties?.NAME || id; const on = sel.has(id);
          return (
            <button key={id} className={`q-item${on ? ' is-asked' : ''}`} style={{ opacity: 1 }} onClick={() => toggle(id)}>
              <span className="q-text">{name}</span>
              {on && <span className="q-draw" style={{ color: 'var(--c-found)' }}>✓</span>}
            </button>
          );
        })}
      </div>
      <Btn full size="sm" disabled={!dirty} onClick={apply} style={{ marginTop: 10 }}>{sel.size} selected · Set game area</Btn>
      {state.map.baseZone && <button className="admin-text-btn" onClick={actions.mapResetAll}>Reset map (clear area & reveals)</button>}
    </Section>
  );
}

function AdminBody({ onClose, state, actions, countdownRemaining, hideElapsed, relocateRemaining, device, onSwitchDevice, syncConnected, onKickAll }) {
  const phases = ['lobby', 'countdown', 'hunt', 'found', 'leaderboard'];
  const cdMins = Math.round((state.countdownMs || 0) / 60000);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmKick, setConfirmKick] = useState(false);
  return (
    <div className="admin-panel">
      <div className="admin-head">
        <div className="admin-title"><Icon name="admin" size={20} /> Admin</div>
        <button className="icon-btn" onClick={onClose}><Icon name="close" size={20} /></button>
      </div>
      <div className="admin-scroll">
        {syncConnected !== null && (
          <div className="admin-block">
            <div className="admin-label">
              Sync
              <span className="admin-val" style={{ color: syncConnected ? '#22c55e' : '#f97316' }}>
                {syncConnected ? 'connected' : 'reconnecting…'}
              </span>
            </div>
          </div>
        )}
        {onSwitchDevice && (
          <div className="admin-block">
            <div className="admin-label">This device <span className="admin-val">Phone {device}</span></div>
            <button className="adj adj-wide" style={{ width: '100%' }} onClick={onSwitchDevice}>Switch device (Phone A / B) →</button>
          </div>
        )}
        <Section title="Game state" defaultOpen>
          <div className="admin-seg">{phases.map(p => <button key={p} className={`seg-btn${state.phase === p ? ' is-on' : ''}`} onClick={() => actions.setPhase(p)}>{p}</button>)}</div>
        </Section>
        <GameAreaBlock state={state} actions={actions} />
        {state.relocateEndsAt && (
          <div className="admin-block">
            <div className="admin-label">Relocation (Move) <span className="admin-val">{fmtClock(relocateRemaining)}</span></div>
            <button className="adj adj-wide" style={{ width: '100%' }} onClick={actions.endRelocate}>End relocation now →</button>
          </div>
        )}
        <Section title="Head-start duration" badge={`${fmtClock(countdownRemaining)} left`} defaultOpen>
          <div className="cd-input-row">
            <input className="cd-input" type="number" min="1" max="600" value={cdMins} onChange={e => actions.setCountdownMins(parseInt(e.target.value || '0', 10))} />
            <span className="cd-input-unit">minutes</span>
          </div>
          <div className="admin-btn-row">
            <button className="adj" onClick={() => actions.adjustCountdown(-5)}>−5m</button>
            <button className="adj" onClick={() => actions.adjustCountdown(-1)}>−1m</button>
            <button className="adj" onClick={() => actions.adjustCountdown(1)}>+1m</button>
            <button className="adj" onClick={() => actions.adjustCountdown(5)}>+5m</button>
            <button className="adj adj-wide" onClick={() => actions.skipCountdown()}>Skip →</button>
          </div>
        </Section>
        <Section title="Hiding time" badge={`${fmtClock(hideElapsed)}${state.paused ? ' · paused' : ''}`}>
          <button className={`pause-btn${state.paused ? ' is-paused' : ''}`} onClick={actions.togglePause}>
            <Icon name={state.paused ? 'play' : 'pause'} size={16} /> {state.paused ? 'Resume hiding time' : 'Pause hiding time'}
          </button>
          <div className="admin-btn-row">
            <button className="adj" onClick={() => actions.adjustHide(-15)}>−15m</button>
            <button className="adj" onClick={() => actions.adjustHide(-5)}>−5m</button>
            <button className="adj" onClick={() => actions.adjustHide(5)}>+5m</button>
            <button className="adj" onClick={() => actions.adjustHide(15)}>+15m</button>
          </div>
        </Section>
        <DeckConfigBlock state={state} actions={actions} />
        <Section title="Give a card" badge={`hand ${state.hand.length}`}>
          <div className="admin-give">
            {['powerup', 'curse', 'time'].map(type => {
              const pool = DECK.filter(c => c.type === type);
              return <button key={type} className={`give-btn give-${type}`} onClick={() => actions.giveCard(pool[Math.floor(Math.random() * pool.length)].id)}><Icon name={type} size={15} sw={2} /> {CARD_TYPES[type].label}</button>;
            })}
          </div>
          <button className="admin-text-btn" onClick={actions.clearHand}>Clear hand</button>
        </Section>
        <Section title="Leaderboard">
          <div className="admin-lb">
            {state.leaderboard.length === 0 && <div className="admin-lb-empty">empty</div>}
            {state.leaderboard.map((r, i) => (
              <div className="admin-lb-row" key={i}>
                <span>{r.names}</span>
                <span className="admin-lb-ms">{fmtClock(r.ms)}</span>
                <button className="icon-btn sm" onClick={() => actions.removeLeader(i)}><Icon name="close" size={14} /></button>
              </div>
            ))}
          </div>
          {state.leaderboard.length > 0 && <button className="admin-text-btn" onClick={actions.clearLeaderboard}>Clear leaderboard</button>}
        </Section>
        {onKickAll && (
          <div className="admin-block"><button className="admin-reset" onClick={() => {
            if (confirmKick) { onKickAll(); onClose(); }
            else { setConfirmKick(true); setTimeout(() => setConfirmKick(false), 3000); }
          }}>{confirmKick ? 'Tap again to kick all devices' : 'Kick all devices off'}</button></div>
        )}
        <div className="admin-block"><button className="admin-reset" onClick={() => {
          if (confirmReset) { actions.reset(); onClose(); }
          else { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 3000); }
        }}>{confirmReset ? 'Tap again to confirm reset' : 'Reset entire game'}</button></div>
      </div>
    </div>
  );
}

export function AdminOverlay({ open, onClose, state, actions, countdownRemaining, hideElapsed, relocateRemaining, device, onSwitchDevice, syncConnected, onKickAll }) {
  const [authed, setAuthed] = useState(false);
  if (!open) return null;
  return (
    <div className="admin-scrim" onClick={() => { onClose(); setAuthed(false); }}>
      <div onClick={e => e.stopPropagation()}>
        {authed
          ? <AdminBody onClose={() => { onClose(); setAuthed(false); }} state={state} actions={actions} countdownRemaining={countdownRemaining} hideElapsed={hideElapsed} relocateRemaining={relocateRemaining} device={device} onSwitchDevice={onSwitchDevice ? () => { setAuthed(false); onSwitchDevice(); } : null} syncConnected={syncConnected} onKickAll={onKickAll} />
          : <AdminLock onUnlock={() => setAuthed(true)} onClose={onClose} />}
      </div>
    </div>
  );
}
