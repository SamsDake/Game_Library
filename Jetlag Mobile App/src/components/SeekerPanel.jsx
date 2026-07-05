// SeekerPanel.jsx — seeker UI with Leaflet map integration
import { useState, useEffect } from 'react';
import { Icon, Btn, AnswerTimer, PhotoButton } from './ui.jsx';
import { Sheet, QuestionLog, Gallery } from './shared.jsx';
import { answerTone, requestLocation } from '../lib/ui-helpers.js';
import { parseKm, distanceKm, pt } from '../lib/geometry.js';
import { HideClock, FoundBox } from './HiderPanel.jsx';
import { AppHeader } from './screens.jsx';
import { SeekerMap, MapStrip } from './SeekerMap.jsx';
import { CATEGORIES, CAT_BY_ID, optionLabel } from '../lib/data.js';

function effectRemaining(eff, pausedTotal = 0) {
  if (!eff.duration) return 0;
  return Math.max(0, (eff.playedAtActiveTime ?? eff.playedAt) + eff.duration * 60000 - (Date.now() - pausedTotal));
}

function EffectRow({ eff, photos, actions, pausedTotal }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!eff.duration) return;
    const iv = setInterval(() => force(x => x + 1), 1000);
    return () => clearInterval(iv);
  }, [eff.duration]);
  const proof = eff.proofUid && photos.find(p => p.uid === eff.proofUid);
  const remaining = effectRemaining(eff, pausedTotal);
  const pct = eff.duration ? Math.max(0, Math.min(1, remaining / (eff.duration * 60000))) : 0;
  const tag = eff.block ? (proof ? 'cleared · whole run' : 'blocks questions') : eff.duration ? fmtRemaining(remaining) : eff.persist ? 'whole run' : null;
  const blocking = eff.block && !proof;
  const [open, setOpen] = useState(blocking);
  return (
    <div className={`effect-row effect-curse${blocking ? ' effect-blocking' : ''}${eff.duration ? ' effect-timed' : ''}`}>
      <button className="effect-head" onClick={() => setOpen(o => !o)}>
        <div className="effect-head-left">
          <span className="effect-type"><Icon name="curse" size={13} sw={2} /> Curse{tag && <span className="effect-tag"> · {tag}</span>}</span>
          <div className="effect-title">{eff.title}</div>
        </div>
        <Icon name="chevron" size={14} className={`effect-chevron${open ? ' is-open' : ''}`} />
      </button>
      {open && (
        <>
          <div className="effect-text">{eff.text}</div>
          {eff.block && (proof
            ? <div className="effect-proof"><img src={proof.dataUrl} alt="proof" /><span>Proof sent — questions unlocked ✓</span></div>
            : <PhotoButton className="btn btn-solid btn-accent btn-sm btn-full" onPhoto={(d) => actions.submitProof(eff.uid, d)}><Icon name="photo" size={14} /> Send proof to lift this curse</PhotoButton>)}
          {eff.duration && <div className="effect-timerbar"><div className="effect-timerbar-fill" style={{ width: `${pct * 100}%` }} /></div>}
        </>
      )}
    </div>
  );
}

function fmtRemaining(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function ActiveQuestion({ aq, actions, pausedTotal }) {
  const cat = CAT_BY_ID[aq.catId];
  const [busy, setBusy] = useState(false);
  const share = async (which) => {
    setBusy(true);
    try {
      const loc = await requestLocation();
      if (which === 'p2' && aq.catId === 'thermometer' && aq.gps?.p1) {
        const required = parseKm(aq.optStr);
        if (required != null) {
          const traveled = distanceKm(pt(aq.gps.p1.lng, aq.gps.p1.lat), pt(loc.lng, loc.lat));
          if (traveled < required) {
            const fmtD = (km) => km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
            alert(`You need to travel ${aq.optStr} before sharing your 2nd GPS, but you've only gone ~${fmtD(traveled)} so far.`);
            return;
          }
        }
      }
      actions.sendGps(which, loc);
    } catch {
      alert('Could not get GPS. Check location permissions.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="active-q">
      <div className="sk-section-label">Your active question</div>
      <div className="active-q-card">
        <div className="aq-cat"><Icon name={cat.glyph} size={15} /> {cat.name}{aq.randomized && <span className="aq-rand">randomized</span>}</div>
        <div className="aq-text">{aq.text}</div>
        {aq.instruction && <div className="aq-instruction">{aq.instruction}</div>}
        {aq.gpsMode !== 'none' && (
          <div className="gps-controls">
            {aq.gps?.p1
              ? <a href={`https://www.google.com/maps/search/?api=1&query=${aq.gps.p1.lat},${aq.gps.p1.lng}`} target="_blank" rel="noopener noreferrer" className="gps-pill" style={{textDecoration: 'none'}}><Icon name="pin" size={13} /> {aq.gpsMode === 'double' ? 'Start: ' : 'Shared: '}{aq.gps.p1.label}{aq.gps.p1.mock ? ' (sim)' : ''}</a>
              : <Btn full variant="outline" size="sm" onClick={() => share('p1')} disabled={busy}>{busy ? 'Locating…' : (aq.gpsMode === 'double' ? 'Share start GPS' : 'Share my GPS with hider')}</Btn>}
            {aq.gpsMode === 'double' && (aq.gps?.p2
              ? <a href={`https://www.google.com/maps/search/?api=1&query=${aq.gps.p2.lat},${aq.gps.p2.lng}`} target="_blank" rel="noopener noreferrer" className="gps-pill" style={{textDecoration: 'none'}}><Icon name="pin" size={13} /> After: {aq.gps.p2.label}{aq.gps.p2.mock ? ' (sim)' : ''}</a>
              : <>
                  <Btn full variant="outline" size="sm" onClick={() => share('p2')} disabled={busy || !aq.gps?.p1}>{busy ? 'Locating…' : 'Share GPS after travel'}</Btn>
                  {aq.gps?.p1 && <p className="map-hint" style={{ fontSize: 11 }}>Travel {aq.optStr} from your start point, then share your GPS.</p>}
                </>)}
          </div>
        )}
        <div className="active-q-status">
          <span className="aqs-wait"><span className="aqs-dot" /> Waiting for the hider to answer…</span>
        </div>
        <AnswerTimer endsAt={aq.timerEndsAt} totalSec={cat.timerSec} tone="var(--c-seeker)" waitingLabel={aq.gpsMode === 'double' ? 'Timer starts when you share your 2nd GPS' : aq.gpsMode === 'single' ? 'Timer starts when you share your GPS' : undefined} pausedTotal={pausedTotal} />
      </div>
    </div>
  );
}

function LastAnswer({ state }) {
  const [zoom, setZoom] = useState(false);
  const last = state.questionLog[0]; if (!last || !last.answer) return null;
  const cat = CAT_BY_ID[last.catId];
  const photo = last.answer.photoUid && state.photos.find(p => p.uid === last.answer.photoUid);
  return (
    <div className="last-answer">
      <div className="sk-section-label">Latest answer</div>
      <div className="last-answer-card" style={{ '--at': answerTone(last.answer.value) }}>
        <div className="la-q"><span className="aq-cat"><Icon name={cat.glyph} size={14} /> {cat.name}</span> {last.text}</div>
        <div className="la-value"><span className="la-dot" /> {last.answer.value}</div>
        {photo && (
          <div className="la-photo-row">
            <img className="la-photo-thumb" src={photo.dataUrl} alt="" onClick={() => setZoom(true)} />
            <span className="la-photo-hint">Tap to view full size</span>
          </div>
        )}
      </div>
      {zoom && photo && (
        <div className="lightbox" onClick={() => setZoom(false)}>
          <img src={photo.dataUrl} alt="" onClick={e => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setZoom(false)}><Icon name="close" size={22} /></button>
        </div>
      )}
    </div>
  );
}

export function SeekerPanel({ role, state, actions, hideElapsed, drawOverride, onAdmin, pausedTotal }) {
  const [cat, setCat] = useState('matching');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(null);
  const C = CAT_BY_ID[cat];
  const aq = state.activeQuestion;
  const blocked = state.effects.some(e => e.block && !e.proofUid);
  const spottyMemoryCat = state.spottyMemoryCat;
  const spottyMemoryName = spottyMemoryCat ? CAT_BY_ID[spottyMemoryCat]?.name : null;
  const categoryDisabled = cat === spottyMemoryCat;

  if (sheet === 'log') return <Sheet title="Question log" icon="list" onClose={() => setSheet(null)}><QuestionLog state={state} /></Sheet>;
  if (sheet === 'gallery') return <Sheet title="Photo gallery" icon="gallery" onClose={() => setSheet(null)}><Gallery state={state} /></Sheet>;
  if (sheet === 'map') return <SeekerMap state={state} actions={actions} onClose={() => setSheet(null)} />;

  const ask = async (idx) => {
    if (aq || blocked || categoryDisabled) return;
    setBusy(true);
    try {
      const loc = C.gps !== 'none' ? await requestLocation() : null;
      actions.askQuestion(cat, idx, cat === 'radar' && C.options[idx] === 'CUSTOM' ? custom.trim() : null, loc);
    } catch {
      alert('Could not get GPS. Check location permissions.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen panel seeker-panel">
      <AppHeader role={role} onAdmin={onAdmin} tools={
        <div className="panel-tools-inline">
          <button className="icon-btn" onClick={() => setSheet('map')} title="Tactical map"><Icon name="map" size={18} /></button>
          <button className="icon-btn" onClick={() => setSheet('log')} title="Question log"><Icon name="list" size={18} /></button>
          <button className="icon-btn" onClick={() => setSheet('gallery')} title="Gallery">
            <Icon name="gallery" size={18} />
            {state.photos.length > 0 && <span className="icon-badge">{state.photos.length}</span>}
          </button>
        </div>
      } />
      <HideClock hideElapsed={hideElapsed} sub="the hider is loose" paused={state.paused} />
      <MapStrip state={state} onOpen={() => setSheet('map')} />

      {state.effects.length > 0 && (
        <div className="effects">
          <div className="sk-section-label">Active on you · {state.effects.length}</div>
          {state.effects.map(e => <EffectRow key={e.uid} eff={e} photos={state.photos} actions={actions} pausedTotal={pausedTotal} />)}
        </div>
      )}

      {aq ? <ActiveQuestion aq={aq} actions={actions} pausedTotal={pausedTotal} /> : <LastAnswer state={state} />}

      {!aq && (
        <>
          {blocked && <div className="block-banner"><Icon name="lock" size={16} /> Questions locked — clear the curse above by sending proof.</div>}
          {spottyMemoryName && <div className="block-banner"><Icon name="lock" size={16} /> Spotty Memory - {spottyMemoryName} questions are disabled.</div>}
          <div className="sk-section-label">Question category</div>
          <div className="cat-rail">
            {CATEGORIES.map(c => (
              <button key={c.id} className={`cat-chip${cat === c.id ? ' is-on' : ''}`} disabled={c.id === spottyMemoryCat} onClick={() => setCat(c.id)}>
                <Icon name={c.glyph} size={18} /> <span>{c.name}</span>
              </button>
            ))}
          </div>
          <div className="sk-section-label">{C.blurb} · draw {drawOverride || C.draw}, keep {C.keep}</div>
          {cat === 'radar' && (
            <input className="text-in custom-in" placeholder="Custom range for CUSTOM (e.g. 3.5 km)" value={custom} onChange={e => setCustom(e.target.value)} />
          )}
          <div className="q-list">
            {C.options.map((o, i) => {
              const isCustom = o === 'CUSTOM';
              const asked = !isCustom && state.asked[`${cat}:${i}`];
              return (
                <button key={i} className={`q-item${asked ? ' is-asked' : ''}`} disabled={busy || blocked || categoryDisabled || asked || (isCustom && !custom.trim())} onClick={() => ask(i)}>
                  <span className="q-text">{isCustom ? `Custom: ${custom.trim() || '—'}` : optionLabel(C, o)}</span>
                  <span className="q-draw">{categoryDisabled ? 'disabled' : asked ? 'asked' : busy ? '…' : 'ask'}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="panel-spacer" />
      <FoundBox role={role} state={state} actions={actions} />
    </div>
  );
}
