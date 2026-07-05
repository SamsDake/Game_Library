// HiderPanel.jsx — hider UI: answer flow, draw modal, card play
import { useState, useEffect } from 'react';
import { Icon, Btn, AnswerTimer, PhotoButton } from './ui.jsx';
import { Sheet, QuestionLog, Gallery } from './shared.jsx';
import { CAT_BY_ID, DECK_BY_ID, CARD_TYPES } from '../lib/data.js';
import { AppHeader } from './screens.jsx';
import { useCountries } from '../lib/useCountries.js';
import { autoAnswer, tentacleCandidates, tentacleNearest, tentacleOutsideLabel } from '../lib/deduce.js';
import { distanceKm, pt } from '../lib/geometry.js';
import { fmtClock, requestLocation } from '../lib/ui-helpers.js';

export function HideClock({ hideElapsed, sub, paused }) {
  return (
    <div className={`hideclock${paused ? ' is-paused' : ''}`}>
      <span className="hideclock-dot" />
      <span className="hideclock-time">{fmtClock(hideElapsed)}</span>
      <span className="hideclock-sub">{paused ? 'paused' : sub}</span>
    </div>
  );
}

export function FoundBox({ role, state, actions }) {
  const mine = state.found[role];
  const otherRole = role === 'hider' ? 'seeker' : 'hider';
  const otherSet = state.found[otherRole];
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);

  if (mine) {
    return (
      <div className="foundbox is-on">
        <div className="foundbox-toggle" style={{ cursor: 'default' }}>
          <span className="foundbox-check is-on"><Icon name="check" size={15} sw={3} /></span>
          <span className="foundbox-label">You've confirmed: found</span>
        </div>
        <div className="foundbox-peer">{otherSet ? 'Both sides agree — ending…' : `Waiting for the ${otherRole} to confirm`} · <button className="undo-link" onClick={() => actions.unrequestFound(role)}>undo</button></div>
      </div>
    );
  }
  return (
    <div className={`foundbox${armed ? ' is-armed' : ''}`}>
      <button className="foundbox-toggle" onClick={() => { if (armed) { actions.requestFound(role); setArmed(false); } else setArmed(true); }}>
        <span className={`foundbox-check${armed ? ' is-armed' : ''}`}>{armed && <Icon name="check" size={15} sw={3} />}</span>
        <span className="foundbox-label">{armed ? 'Tap again to confirm' : 'Mark hider as found'}</span>
      </button>
      <div className="foundbox-peer">{armed ? 'This ends the round once both sides confirm.' : (otherSet ? `${otherRole === 'hider' ? 'Hider' : 'Seeker'} is waiting on you ✓` : 'Both sides must confirm to end')}</div>
    </div>
  );
}

function DrawModal({ pendingDraw, hand, maxHand, actions }) {
  const need = pendingDraw.keep;
  const [step, setStep] = useState('pick');
  const [keep, setKeep] = useState(() => new Set());
  const [discard, setDiscard] = useState(() => new Set());
  const kept = pendingDraw.cards.filter(c => keep.has(c.uid));
  const combined = [...hand, ...kept];
  const overflow = combined.length - maxHand;
  const toggleKeep = (u) => { const n = new Set(keep); if (n.has(u)) { n.delete(u); } else { if (n.size >= need) n.clear(); n.add(u); } setKeep(n); };
  const toggleDiscard = (u) => { const n = new Set(discard); n.has(u) ? n.delete(u) : n.add(u); setDiscard(n); };
  const confirmPick = () => { if (combined.length > maxHand) { setStep('trim'); return; } actions.resolveDraw(combined, keep.size); };
  const confirmTrim = () => actions.resolveDraw(combined.filter(c => !discard.has(c.uid)), keep.size);
  return (
    <div className="modal-scrim">
      <div className="modal draw-modal">
        {step === 'pick' ? (
          <>
            <div className="modal-kicker">YOU DREW {pendingDraw.cards.length} · KEEP {need}</div>
            <h3 className="modal-title">Choose {need} to keep</h3>
            {pendingDraw.penalty > 0
              ? <p className="modal-sub penalty">⚠ Late answer — your draw was cut by {pendingDraw.penalty}. Tap to keep {need}.</p>
              : <p className="modal-sub">Tap to select. The rest are discarded.</p>}
            <div className="draw-cards">
              {pendingDraw.cards.map(c => <CardTile key={c.uid} cardId={c.cardId} size="md" selected={keep.has(c.uid)} dimmed={keep.size >= need && !keep.has(c.uid)} onClick={() => toggleKeep(c.uid)} />)}
            </div>
            <div className="modal-foot">
              <span className="modal-count">Selected {keep.size} / {need}</span>
              <Btn full size="lg" disabled={keep.size !== need} onClick={confirmPick}>{combined.length > maxHand ? 'Next: trim hand' : 'Add to hand'}</Btn>
            </div>
          </>
        ) : (
          <>
            <div className="modal-kicker">OVER THE LIMIT</div>
            <h3 className="modal-title">Discard down to {maxHand}</h3>
            <p className="modal-sub">Select {overflow} card{overflow === 1 ? '' : 's'} to discard.</p>
            <div className="draw-cards draw-cards-grid">{combined.map(c => <CardTile key={c.uid} cardId={c.cardId} size="sm" selected={discard.has(c.uid)} dimmed={discard.has(c.uid)} onClick={() => toggleDiscard(c.uid)} />)}</div>
            <div className="modal-foot">
              <span className="modal-count">Discarding {discard.size} / {overflow}</span>
              <Btn full size="lg" disabled={discard.size !== overflow} onClick={confirmTrim}>Confirm hand</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DiscardDrawModal({ card, cardUid, hand, actions, onClose }) {
  const need = card.discardN;
  const [sel, setSel] = useState(() => new Set());
  const others = hand.filter(h => h.uid !== cardUid);
  const toggle = (u) => { const n = new Set(sel); n.has(u) ? n.delete(u) : (n.size < need && n.add(u)); setSel(n); };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-kicker">{card.title.toUpperCase()}</div>
        <h3 className="modal-title">Discard {need}, draw {card.drawN}</h3>
        <p className="modal-sub">{others.length >= need ? `Select ${need} card${need === 1 ? '' : 's'} to discard.` : `You need ${need} other cards to play this.`}</p>
        <div className="draw-cards draw-cards-grid">{others.map(c => <CardTile key={c.uid} cardId={c.cardId} size="sm" selected={sel.has(c.uid)} dimmed={sel.has(c.uid)} onClick={() => toggle(c.uid)} />)}</div>
        <div className="modal-foot">
          <span className="modal-count">{sel.size} / {need}</span>
          <Btn full size="lg" disabled={sel.size !== need} onClick={() => { actions.discardThenDraw(cardUid, [...sel]); onClose(); }}>Discard &amp; draw {card.drawN}</Btn>
        </div>
      </div>
    </div>
  );
}

function DuplicateModal({ cardUid, hand, actions, onClose }) {
  const others = hand.filter(h => h.uid !== cardUid);
  const [pick, setPick] = useState(null);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-kicker">DUPLICATE</div>
        <h3 className="modal-title">Copy a card</h3>
        <p className="modal-sub">{others.length ? 'Pick a card in your hand to copy.' : 'No other cards to duplicate.'}</p>
        <div className="draw-cards draw-cards-grid">{others.map(c => <CardTile key={c.uid} cardId={c.cardId} size="sm" selected={pick === c.uid} dimmed={pick && pick !== c.uid} onClick={() => setPick(c.uid)} />)}</div>
        <div className="modal-foot">
          <Btn full size="lg" disabled={!pick} onClick={() => { actions.duplicateCard(cardUid, pick); onClose(); }}>Make a copy</Btn>
        </div>
      </div>
    </div>
  );
}

function costInfo(card, hand, cardUid) {
  const cd = card && card.costDiscard;
  if (!cd) return { has: false, ok: true };
  const others = hand.filter(h => h.uid !== cardUid);
  if (cd.all) return { has: true, ok: true, all: true, pool: others, need: others.length, label: 'Discard your whole hand' };
  const pool = cd.type ? others.filter(h => DECK_BY_ID[h.cardId]?.type === cd.type) : others;
  const need = cd.count;
  const label = cd.type ? `Discard ${need} ${CARD_TYPES[cd.type].label}${need > 1 ? 's' : ''}` : `Discard ${need} card${need > 1 ? 's' : ''}`;
  return { has: true, ok: pool.length >= need, pool, need, label, type: cd.type };
}

function PayCostModal({ card, cardUid, hand, actions, onClose }) {
  const info = costInfo(card, hand, cardUid);
  const [sel, setSel] = useState(() => info.all ? new Set(info.pool.map(o => o.uid)) : new Set());
  const toggle = (u) => { if (info.all) return; const n = new Set(sel); n.has(u) ? n.delete(u) : (n.size < info.need && n.add(u)); setSel(n); };
  const done = info.all ? true : sel.size === info.need;
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-kicker">CASTING COST</div>
        <h3 className="modal-title">{info.label}</h3>
        <p className="modal-sub">{info.all ? 'Playing this discards everything else in your hand.' : `Select ${info.need} ${info.type ? CARD_TYPES[info.type].label.toLowerCase() : 'card'}${info.need > 1 ? 's' : ''} to discard, then play ${card.title}.`}</p>
        {info.pool.length === 0
          ? <p className="modal-sub" style={{ color: 'var(--text-faint)' }}>Nothing to discard — playing is free here.</p>
          : <div className="draw-cards draw-cards-grid">{info.pool.map(c => <CardTile key={c.uid} cardId={c.cardId} size="sm" selected={sel.has(c.uid)} dimmed={info.all || sel.has(c.uid)} onClick={() => toggle(c.uid)} />)}</div>}
        <div className="modal-foot">
          {!info.all && info.pool.length > 0 && <span className="modal-count">{sel.size} / {info.need}</span>}
          <Btn full size="lg" disabled={!done} onClick={() => { actions.playCard(cardUid, info.all ? info.pool.map(o => o.uid) : [...sel]); onClose(); }}>Pay cost &amp; play</Btn>
        </div>
      </div>
    </div>
  );
}

function CardTile({ cardId, size, selected, dimmed, onClick }) {
  const card = DECK_BY_ID[cardId]; if (!card) return null;
  const meta = CARD_TYPES[card.type];
  return (
    <div className={`gcard gcard-${size} gcard-${card.type}${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`} onClick={onClick} style={{ '--ct': meta.color }}>
      <div className="gcard-top">
        <span className="gcard-type"><Icon name={card.type} size={size === 'sm' ? 13 : 15} sw={2} /> {meta.label}</span>
        {selected && <span className="gcard-tick"><Icon name="check" size={13} sw={2.6} /></span>}
      </div>
      <div className="gcard-title">{card.title}</div>
      {size !== 'sm' && <div className="gcard-text">{card.text}</div>}
    </div>
  );
}

function AnswerBlock({ aq, hand, actions, pausedTotal, state }) {
  const cat = CAT_BY_ID[aq.catId];
  const [text, setText] = useState('');
  const cfg = aq.answerCfg;
  const vetoCard = hand.find(h => DECK_BY_ID[h.cardId]?.power === 'veto');
  const randCard = hand.find(h => DECK_BY_ID[h.cardId]?.power === 'randomize');

  const isTentacles = aq.catId === 'tentacles';
  const tOpt = isTentacles ? cat.options[aq.optIndex] : null;
  const { countries } = useCountries();
  const ctx = { currentZone: state.map.currentZone, baseZone: state.map.baseZone, countries, selectedIds: state.map.selectedCountryIds };

  const [autoBusy, setAutoBusy] = useState(false);
  const [autoErr, setAutoErr] = useState(null);

  // Tentacles candidate list (features within the seeker's radius).
  const [tCands, setTCands] = useState(null);   // FeatureCollection of NAMED candidates
  const [tMeta, setTMeta] = useState(null);     // { radiusKm, origin }
  const [tLoading, setTLoading] = useState(false);
  const [tErr, setTErr] = useState(null);
  useEffect(() => {
    if (!isTentacles) return;
    let cancelled = false;
    setTLoading(true); setTErr(null); setTCands(null); setTMeta(null);
    (async () => {
      try {
        const r = await tentacleCandidates(aq, ctx);
        if (cancelled) return;
        if (r.error) { setTErr(r.error); return; }
        const named = { type: 'FeatureCollection', features: r.candidates.features.filter(f => f.properties?.name) };
        setTCands(named); setTMeta({ radiusKm: r.radiusKm, origin: r.origin });
      } catch (e) { if (!cancelled) setTErr(e.message || 'Could not load nearby places.'); }
      finally { if (!cancelled) setTLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [aq.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoReady = aq.catId === 'thermometer' ? !!aq.gps?.p2 : isTentacles ? !!tCands : true;
  // Hiders can't answer until the seeker's required GPS has arrived.
  const gpsReady = aq.gpsMode === 'none' ? true : aq.gpsMode === 'double' ? !!aq.gps?.p2 : !!aq.gps?.p1;

  const runAuto = async () => {
    setAutoErr(null); setAutoBusy(true);
    try {
      const loc = await requestLocation();
      if (isTentacles) {
        if (tMeta && distanceKm(pt(loc.lng, loc.lat), pt(tMeta.origin.lng, tMeta.origin.lat)) > tMeta.radiusKm) {
          actions.answerQuestion(tentacleOutsideLabel(aq)); return;
        }
        const name = tentacleNearest(tCands, loc);
        if (name) actions.answerQuestion(name);
        else setAutoErr('No named place near you to pick.');
      } else {
        const r = await autoAnswer(aq, loc, ctx);
        if (r.value) actions.answerQuestion(r.value);
        else setAutoErr(r.error || 'Could not auto-answer.');
      }
    } catch (e) { setAutoErr(e.message || 'Location unavailable.'); }
    finally { setAutoBusy(false); }
  };

  const showTextFallback = isTentacles && !tLoading && (tErr || (tCands && tCands.features.length === 0));

  return (
    <div className="answer-block">
      <div className="aq-cat"><Icon name={cat.glyph} size={15} /> {cat.name}{aq.randomized && <span className="aq-rand">randomized</span>}</div>
      <div className="aq-text">{aq.text}</div>
      {aq.instruction && <div className="aq-instruction">{aq.instruction}</div>}
      {aq.gpsMode !== 'none' && (
        <div className="gps-strip">
          {aq.gps?.p1 ? <a href={`https://www.google.com/maps/search/?api=1&query=${aq.gps.p1.lat},${aq.gps.p1.lng}`} target="_blank" rel="noopener noreferrer" className="gps-pill" style={{textDecoration: 'none'}}><Icon name="pin" size={13} /> {aq.gpsMode === 'double' ? 'Start ' : ''}{aq.gps.p1.label}</a> : <span className="gps-pill gps-wait">waiting for seeker's GPS…</span>}
          {aq.gpsMode === 'double' && (aq.gps?.p2 ? <a href={`https://www.google.com/maps/search/?api=1&query=${aq.gps.p2.lat},${aq.gps.p2.lng}`} target="_blank" rel="noopener noreferrer" className="gps-pill" style={{textDecoration: 'none'}}><Icon name="pin" size={13} /> After {aq.gps.p2.label}</a> : <span className="gps-pill gps-wait">awaiting 2nd point…</span>)}
        </div>
      )}
      {cfg.kind === 'choice' && <div className="answer-choices">{cfg.options.map(o => <button key={o} className={`answer-choice ac-${o.toLowerCase()}`} disabled={!gpsReady} onClick={() => actions.answerQuestion(o)}>{o}</button>)}</div>}
      {cfg.kind === 'choice' && !gpsReady && <p className="map-hint" style={{ fontSize: 11, marginTop: -2 }}>Waiting for the seeker to share their {aq.gpsMode === 'double' ? '2nd ' : ''}GPS before you can answer…</p>}

      {isTentacles && (
        <div className="answer-tentacles">
          {tLoading && <p className="map-hint">Finding nearby {tOpt?.feature?.toLowerCase()}…</p>}
          {!tLoading && tCands && tCands.features.length > 0 && (
            <>
              <p className="map-hint" style={{ marginBottom: 6 }}>Tap the one closest to you:</p>
              <div className="tentacle-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                {tCands.features.map((f, i) => (
                  <button key={i} className="q-item" style={{ opacity: 1 }} onClick={() => actions.answerQuestion(f.properties.name)}>
                    <span className="q-text">{f.properties.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {!tLoading && tCands && (
            <Btn full variant="outline" tone="muted" style={{ marginTop: 8 }} onClick={() => actions.answerQuestion(tentacleOutsideLabel(aq))}>
              I'm not within {tOpt?.radius} of the seeker
            </Btn>
          )}
          {showTextFallback && (
            <div className="answer-text">
              {tErr && <p className="map-hint" style={{ color: 'var(--c-curse)' }}>{tErr}</p>}
              <input className="text-in" placeholder={cfg.placeholder} value={text} onChange={e => setText(e.target.value)} />
              <Btn full onClick={() => text.trim() && actions.answerQuestion(text.trim())} disabled={!text.trim()}>Send answer</Btn>
            </div>
          )}
        </div>
      )}

      {cfg.kind === 'text' && !isTentacles && <div className="answer-text"><input className="text-in" placeholder={cfg.placeholder} value={text} onChange={e => setText(e.target.value)} /><Btn full onClick={() => text.trim() && actions.answerQuestion(text.trim())} disabled={!text.trim()}>Send answer</Btn></div>}
      {cfg.kind === 'photo' && <div className="answer-photo"><PhotoButton onPhoto={(d) => actions.answerQuestion(null, d)}><Icon name="photo" size={17} /> Take / upload photo</PhotoButton></div>}

      {cfg.kind !== 'photo' && (
        <div className="answer-auto" style={{ marginTop: 8 }}>
          <Btn full variant="outline" disabled={autoBusy || !autoReady || !gpsReady} onClick={runAuto}>
            <Icon name="pin" size={14} /> {autoBusy ? 'Locating…' : 'Auto — answer from my location'}
          </Btn>
          {aq.catId === 'thermometer' && !autoReady && <p className="map-hint" style={{ fontSize: 10, marginTop: 4 }}>Auto unlocks once the seeker shares their 2nd GPS.</p>}
          {autoErr && <p className="map-hint" style={{ fontSize: 10, marginTop: 4, color: 'var(--c-curse)' }}>{autoErr}</p>}
        </div>
      )}

      {(vetoCard || randCard) && (
        <div className="answer-instead">
          <span className="answer-instead-label">Play instead of answering</span>
          <div className="answer-instead-row">
            {randCard && <button className="instead-btn" onClick={() => actions.randomizeQuestion(randCard.uid)}><Icon name="powerup" size={13} sw={2} /> Randomize</button>}
            {vetoCard && <button className="instead-btn" onClick={() => actions.vetoQuestion(vetoCard.uid)}><Icon name="veto" size={13} sw={2} /> Veto</button>}
          </div>
        </div>
      )}
      <AnswerTimer endsAt={aq.timerEndsAt} totalSec={cat.timerSec} waitingLabel={aq.gpsMode === 'double' ? "Timer starts when the seeker shares their 2nd GPS" : aq.gpsMode === 'single' ? "Timer starts when the seeker shares their GPS" : undefined} pausedTotal={pausedTotal} />
    </div>
  );
}

export function HiderPanel({ role, state, actions, hideElapsed, maxHand, onAdmin, pausedTotal }) {
  const [open, setOpen] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [cardModal, setCardModal] = useState(null);
  const aq = state.activeQuestion;
  const slots = Array.from({ length: maxHand }, (_, i) => state.hand[i] || null);

  if (sheet === 'log') return <Sheet title="Question log" icon="list" onClose={() => setSheet(null)}><QuestionLog state={state} /></Sheet>;
  if (sheet === 'gallery') return <Sheet title="Photo gallery" icon="gallery" onClose={() => setSheet(null)}><Gallery state={state} /></Sheet>;

  const openItem = open && state.hand.find(h => h.uid === open);
  const openCard = openItem && DECK_BY_ID[openItem.cardId];
  const cost = openCard ? costInfo(openCard, state.hand, open) : { has: false, ok: true };

  const playOpen = () => {
    if (!openCard) return;
    if (openCard.power === 'discardDraw') { setCardModal({ kind: 'discardDraw', uid: open }); setOpen(null); return; }
    if (openCard.power === 'duplicate') { setCardModal({ kind: 'duplicate', uid: open }); setOpen(null); return; }
    if (cost.has) {
      if (cost.all && cost.pool.length === 0) { actions.playCard(open, []); setOpen(null); return; }
      setCardModal({ kind: 'cost', uid: open }); setOpen(null); return;
    }
    actions.playCard(open); setOpen(null);
  };

  const needsActiveQ = openCard?.needsActiveQ;
  const playDisabled = (needsActiveQ && !aq) || (cost.has && !cost.ok);
  const modalItem = cardModal && state.hand.find(h => h.uid === cardModal.uid);
  const modalCard = modalItem && DECK_BY_ID[modalItem.cardId];

  return (
    <div className="screen panel hider-panel">
      <AppHeader role={role} onAdmin={onAdmin} tools={
        <div className="panel-tools-inline">
          <button className="icon-btn" onClick={() => setSheet('log')} title="Question log"><Icon name="list" size={18} /></button>
          <button className="icon-btn" onClick={() => setSheet('gallery')} title="Gallery"><Icon name="gallery" size={18} />{state.photos.length > 0 && <span className="icon-badge">{state.photos.length}</span>}</button>
        </div>
      } />
      <HideClock hideElapsed={hideElapsed} sub="you've been hiding" paused={state.paused} />
      {state.drawBonus > 0 && <div className="bonus-strip"><Icon name="time" size={14} sw={2} /> <span>Overflowing Chalice · +1 draw for {state.drawBonus} more {state.drawBonus === 1 ? 'question' : 'questions'}</span></div>}
      {aq ? <AnswerBlock aq={aq} hand={state.hand} actions={actions} pausedTotal={pausedTotal} state={state} />
        : <div className="aq-banner aq-idle">{state.pendingDraw ? 'Resolve your draw below.' : 'No active question. Stay hidden.'}</div>}
      <div className="hand-head"><span><Icon name="deck" size={16} /> Your hand</span><span className="hand-count">{state.hand.length}/{maxHand}</span></div>
      <div className="hand-grid">
        {slots.map((item, i) => item
          ? <CardTile key={item.uid} cardId={item.cardId} size="sm" onClick={() => setOpen(open === item.uid ? null : item.uid)} selected={open === item.uid} />
          : <div className="hand-slot" key={`e${i}`}><span>empty</span></div>)}
      </div>
      {openCard && (() => {
        const meta = CARD_TYPES[openCard.type];
        return (
          <div className="card-actions" style={{ '--ct': meta.color }}>
            <div className="card-actions-top"><span className="gcard-type"><Icon name={openCard.type} size={14} sw={2} /> {meta.label}</span></div>
            <div className="card-actions-name">{openCard.title}</div>
            <div className="card-actions-desc">{openCard.text}</div>
            {openCard.cost && <div className="card-actions-cost"><b>Casting cost:</b> {openCard.cost}</div>}
            {needsActiveQ && !aq && <div className="card-actions-note">Can only be played while a question is active.</div>}
            {cost.has && !cost.ok && <div className="card-actions-note">You don't hold enough cards to pay this cost.</div>}
            <div className="card-actions-row">
              <Btn variant="solid" size="sm" disabled={playDisabled} onClick={playOpen}>Play card</Btn>
              <Btn variant="outline" tone="muted" size="sm" onClick={() => { actions.discardCard(open); setOpen(null); }}>Discard</Btn>
            </div>
          </div>
        );
      })()}
      <div className="panel-spacer" />
      <FoundBox role={role} state={state} actions={actions} />
      {state.pendingDraw && <DrawModal pendingDraw={state.pendingDraw} hand={state.hand} maxHand={maxHand} actions={actions} />}
      {cardModal?.kind === 'cost' && modalCard && <PayCostModal card={modalCard} cardUid={cardModal.uid} hand={state.hand} actions={actions} onClose={() => setCardModal(null)} />}
      {cardModal?.kind === 'discardDraw' && modalCard && <DiscardDrawModal card={modalCard} cardUid={cardModal.uid} hand={state.hand} actions={actions} onClose={() => setCardModal(null)} />}
      {cardModal?.kind === 'duplicate' && <DuplicateModal cardUid={cardModal.uid} hand={state.hand} actions={actions} onClose={() => setCardModal(null)} />}
    </div>
  );
}
