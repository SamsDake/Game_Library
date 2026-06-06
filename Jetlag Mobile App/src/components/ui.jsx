// ui.jsx — shared UI primitives
import { useState, useEffect, useRef } from 'react';
import { DECK_BY_ID, CARD_TYPES } from '../lib/data.js';
import { fileToDataUrl, fmtClock } from '../lib/ui-helpers.js';

export function PhotoButton({ onPhoto, children, className = 'btn btn-solid btn-accent btn-md btn-full' }) {
  const ref = useRef(null);
  const onChange = async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try { onPhoto(await fileToDataUrl(f)); } catch { /* invalid image input is ignored */ }
    e.target.value = '';
  };
  return (
    <>
      <input ref={ref} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onChange} />
      <button className={className} onClick={() => ref.current && ref.current.click()}>{children}</button>
    </>
  );
}

export function Icon({ name, size = 22, stroke = 'currentColor', sw = 1.8 }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke, strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const paths = {
    radar: <g><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="7.5" opacity="0.5" /><path d="M12 12L18 7" /></g>,
    matching: <g><circle cx="8.5" cy="12" r="4.5" /><circle cx="15.5" cy="12" r="4.5" /></g>,
    measuring: <g><path d="M4 16h16" /><path d="M7 16V11" /><path d="M12 16V7" /><path d="M17 16v-3" /></g>,
    thermo: <g><path d="M12 4v9" /><circle cx="12" cy="16.5" r="3" /><path d="M12 9h3" /></g>,
    photo: <g><rect x="3.5" y="6.5" width="17" height="12" rx="2.5" /><circle cx="12" cy="12.5" r="3" /><path d="M8 6.5l1.5-2h5L16 6.5" /></g>,
    tentacles: <g><circle cx="12" cy="6" r="2" /><path d="M12 8v3" /><path d="M12 11l-5 6M12 11l5 6M12 11v6" opacity="0.85" /></g>,
    powerup: <g><path d="M13 3L5 13h6l-1 8 8-10h-6z" /></g>,
    curse: <g><circle cx="12" cy="10" r="6" /><path d="M9.5 9h.01M14.5 9h.01" /><path d="M8 18l2-2 2 2 2-2 2 2" /></g>,
    time: <g><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></g>,
    veto: <g><circle cx="12" cy="12" r="8" /><path d="M7 7l10 10" /></g>,
    admin: <g><circle cx="12" cy="8" r="3.2" /><path d="M5.5 19c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /></g>,
    lock: <g><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></g>,
    pin: <g><path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></g>,
    map: <g><path d="M9 4L3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4z" /><path d="M9 4v14M15 6v14" /></g>,
    chevron: <path d="M9 6l6 6-6 6" />,
    back: <path d="M15 6l-6 6 6 6" />,
    check: <path d="M5 12.5l4.5 4.5L19 7" />,
    close: <path d="M6 6l12 12M18 6L6 18" />,
    deck: <g><rect x="6" y="4" width="12" height="16" rx="2" /><path d="M9 8h6M9 12h6" opacity="0.6" /></g>,
    flag: <g><path d="M6 21V4" /><path d="M6 4h11l-2 3.5L17 11H6" /></g>,
    trophy: <g><path d="M7 4h10v4a5 5 0 01-10 0z" /><path d="M7 5H4v1a3 3 0 003 3M17 5h3v1a3 3 0 01-3 3" /><path d="M12 13v4M9 20h6M10 20v-3h4v3" /></g>,
    list: <g><path d="M8 6h12M8 12h12M8 18h12" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></g>,
    gallery: <g><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M5 17l4.5-4 3 2.5L16 11l3 3.5" /></g>,
    pause: <g><rect x="7" y="5" width="3.5" height="14" rx="1" /><rect x="13.5" y="5" width="3.5" height="14" rx="1" /></g>,
    play: <path d="M7 5l11 7-11 7z" />,
    download: <g><path d="M12 4v11" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></g>,
    globe: <g><circle cx="12" cy="12" r="8" /><path d="M12 4a10 10 0 010 16M4 12h16" /><path d="M12 4c-2.5 3-4 5.5-4 8s1.5 5 4 8M12 4c2.5 3 4 5.5 4 8s-1.5 5-4 8" /></g>,
  };
  return <svg {...p}>{paths[name] || null}</svg>;
}

export function Btn({ children, onClick, variant = 'solid', tone = 'accent', size = 'md', full, disabled, style }) {
  return <button className={`btn btn-${variant} btn-${tone} btn-${size}${full ? ' btn-full' : ''}`} onClick={onClick} disabled={disabled} style={style}>{children}</button>;
}

// Manual lat/lng entry to move the seeker pin on the map.
export function CoordEntry({ onSet }) {
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const valid = lat.trim() !== '' && lng.trim() !== '' && !isNaN(+lat) && !isNaN(+lng) && Math.abs(+lat) <= 90 && Math.abs(+lng) <= 180;
  const set = () => { if (valid) { onSet({ lat: +lat, lng: +lng }); setLat(''); setLng(''); } };
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
      <input className="text-in" style={{ flex: 1, minWidth: 0, padding: '8px 10px', fontSize: 13 }} inputMode="decimal" placeholder="lat" value={lat} onChange={e => setLat(e.target.value)} />
      <input className="text-in" style={{ flex: 1, minWidth: 0, padding: '8px 10px', fontSize: 13 }} inputMode="decimal" placeholder="lng" value={lng} onChange={e => setLng(e.target.value)} />
      <Btn variant="outline" size="sm" disabled={!valid} onClick={set}>Set pin</Btn>
    </div>
  );
}

export function GameCard({ cardId, size = 'md', selected, dimmed, onClick }) {
  const card = DECK_BY_ID?.[cardId]; if (!card) return null;
  const meta = CARD_TYPES?.[card.type];
  return (
    <div className={`gcard gcard-${size} gcard-${card.type}${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`} onClick={onClick} style={{ '--ct': meta?.color }}>
      <div className="gcard-top">
        <span className="gcard-type"><Icon name={card.type} size={size === 'sm' ? 13 : 15} sw={2} /> {meta?.label}</span>
        {selected && <span className="gcard-tick"><Icon name="check" size={13} sw={2.6} /></span>}
      </div>
      <div className="gcard-title">{card.title}</div>
      {size !== 'sm' && <div className="gcard-text">{card.text}</div>}
    </div>
  );
}

export function CircleTimer({ remaining, total, label, accent = 'var(--accent)' }) {
  const R = 132, C = 2 * Math.PI * R;
  const pct = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  return (
    <div className="circ-wrap">
      <svg width="300" height="300" viewBox="0 0 300 300">
        <circle cx="150" cy="150" r={R} className="circ-track" />
        <circle cx="150" cy="150" r={R} className="circ-prog" stroke={accent} strokeDasharray={C} strokeDashoffset={C * (1 - pct)} transform="rotate(-90 150 150)" />
      </svg>
      <div className="circ-center"><div className="circ-time">{fmtClock(remaining)}</div><div className="circ-label">{label}</div></div>
    </div>
  );
}

export function AnswerTimer({ endsAt, totalSec, tone = 'var(--accent)', waitingLabel, pausedTotal = 0 }) {
  const [, force] = useState(0);
  useEffect(() => { const iv = setInterval(() => force(x => x + 1), 500); return () => clearInterval(iv); }, []);
  // Timer not started yet (e.g. Thermometer awaiting the 2nd GPS share).
  if (!endsAt) {
    return (
      <div className="atimer">
        <div className="atimer-row">
          <span className="atimer-label">{waitingLabel || 'Timer not started'}</span>
          <span className="atimer-time" style={{ color: 'var(--text-faint)' }}>—:—</span>
        </div>
        <div className="atimer-track"><div className="atimer-fill" style={{ width: '0%' }} /></div>
      </div>
    );
  }
  const remaining = Math.max(0, endsAt + pausedTotal - Date.now());
  const pct = Math.max(0, Math.min(1, remaining / (totalSec * 1000)));
  const expired = remaining <= 0;
  return (
    <div className="atimer">
      <div className="atimer-row">
        <span className="atimer-label">{expired ? 'Time up' : 'Time to answer'}</span>
        <span className="atimer-time" style={{ color: expired ? 'var(--c-curse)' : tone }}>{fmtClock(remaining)}</span>
      </div>
      <div className="atimer-track"><div className="atimer-fill" style={{ width: `${pct * 100}%`, background: expired ? 'var(--c-curse)' : tone }} /></div>
    </div>
  );
}

function Toast({ n, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(n.uid), 5200);
    return () => clearTimeout(t);
  }, [n.uid, onDismiss]);
  return (
    <button className="toast" onClick={() => onDismiss(n.uid)}>
      <span className="toast-dot" />
      <span className="toast-body"><span className="toast-title">{n.title}</span><span className="toast-text">{n.text}</span></span>
    </button>
  );
}

export function Toasts({ items, onDismiss }) {
  if (!items.length) return null;
  return (
    <div className="toasts">
      {items.slice(0, 3).map(n => <Toast key={n.uid} n={n} onDismiss={onDismiss} />)}
    </div>
  );
}
