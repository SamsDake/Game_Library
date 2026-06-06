// store.js — Zustand game store (v3 design + Leaflet map state)
import { useState, useRef, useEffect, useCallback } from 'react';
import { CAT_BY_ID, DECK_BY_ID, DEFAULT_DECK_CONFIG, buildDeck, SEED_LEADERBOARD, optionLabel } from './data.js';
import { applyClue, computeConstraint, bisectorHalfPlane } from './geometry.js';

const LS_KEY = 'jetlag_state_v4';
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 9));

// ── Map state (GeoJSON-based, replaces the abstract cell grid) ──
function freshMapState() {
  return {
    selectedCountryIds: [],   // array of ISO_A2 codes
    baseZone: null,           // GeoJSON Feature (union of selected countries)
    currentZone: null,        // GeoJSON Feature (after all cuts)
    cuts: [],                 // [{ id, qid, kind, label, polygon, mode }]
    pin: null,                // { lat, lng } seeker position
    p1: null,                 // thermometer start point { lat, lng }
    p2: null,                 // thermometer end point { lat, lng }
  };
}

function freshState(cfg) {
  // deckConfig can be undefined if called without cfg (e.g., from AdminOverlay before initialization)
  const deckConfig = cfg?.deckConfig || DEFAULT_DECK_CONFIG;
  return {
    phase: 'lobby',
    roles: { A: null, B: null },
    countdownMs: (cfg?.countdownMins ?? 120) * 60000,
    countdownEndsAt: null,
    huntStartedAt: null,
    huntFrozenAt: null,
    bonusMs: 0,
    paused: false, pausedAt: null, pausedAccum: 0,
    relocateEndsAt: null,
    deckConfig,
    deck: buildDeck(deckConfig),
    hand: [],
    drawBonus: 0,
    freeQuestion: 0,
    asked: {},
    pendingDraw: null,
    activeQuestion: null,
    questionLog: [],
    effects: [],
    conditionalBonuses: [],
    photos: [],
    notifications: [],
    found: { hider: false, seeker: false },
    leaderboard: SEED_LEADERBOARD.slice(),
    map: freshMapState(),
    feed: [{ t: Date.now(), text: 'New game created.' }],
    kickedAt: 0,
  };
}

function loadState(cfg) {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // Ensure deckConfig is always set to a valid value before building the deck
      if (!s.deckConfig) s.deckConfig = DEFAULT_DECK_CONFIG;
      if (typeof s.deckConfig !== 'object' || Object.keys(s.deckConfig).length === 0) {
        s.deckConfig = DEFAULT_DECK_CONFIG;
      }
      if (!s.deck) s.deck = buildDeck(s.deckConfig);
      if (!s.notifications) s.notifications = [];
      if (!s.asked) s.asked = {};
      if (!s.map) s.map = freshMapState();
      if (!s.map.selectedCountryIds) s.map.selectedCountryIds = [];
      if (!s.map.cuts) s.map.cuts = [];
      // Migrate cuts saved before the on/off toggle existed → default enabled.
      s.map.cuts = s.map.cuts.map(c => (c.enabled === undefined ? { ...c, enabled: true } : c));
      return s;
    }
  } catch (e) {
    console.warn('Failed to load state from localStorage:', e.message);
  }
  // If freshState is called without cfg or cfg.deckConfig is invalid, fall back to defaults
  if (!cfg || !cfg.deckConfig) {
    return freshState({ ...cfg, deckConfig: DEFAULT_DECK_CONFIG });
  }
  return freshState(cfg);
}

function applyDrawPenalty(draw, keep, penalty) {
  let d = draw, k = keep;
  for (let i = 0; i < penalty; i++) {
    if (d - 1 >= k && d - 1 >= 1) d -= 1;
    else if (k - 1 >= 1) k -= 1;
    else if (d - 1 >= 1) d -= 1;
  }
  if (k > d) k = d;
  return { draw: d, keep: k };
}

function drawCards(deck, n, cfg) {
  let d = deck.slice();
  const cards = [];
  for (let i = 0; i < n; i++) {
    if (d.length === 0) d = buildDeck(cfg);
    cards.push({ uid: uid(), cardId: d.pop() });
  }
  return { cards, deck: d };
}

// Recompute currentZone from baseZone + all cuts
function recomputeZone(map) {
  if (!map.baseZone) return { ...map, currentZone: null };
  let zone = map.baseZone;
  for (const cut of map.cuts) {
    if (cut.enabled === false) continue; // disabled reveals don't affect the zone
    const next = applyClue(zone, cut.polygon, cut.mode);
    if (next !== undefined) zone = next;
  }
  return { ...map, currentZone: zone };
}

export function useGameStore(cfg) {
  const [state, setState] = useState(() => loadState(cfg));
  const [now, setNow] = useState(Date.now());
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* localStorage may be full or unavailable */ } }, [state]);
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(iv); }, []);

  useEffect(() => {
    if (state.phase === 'countdown' && state.countdownEndsAt && now >= state.countdownEndsAt) {
      setState(s => {
        const nUid = `cdwn_done_${s.countdownEndsAt}`;
        const notifications = s.notifications.some(n => n.uid === nUid)
          ? s.notifications
          : [{ uid: nUid, to: 'both', title: 'Head start over!', text: 'The seekers are coming — the hunt has begun!', at: Date.now() }, ...s.notifications].slice(0, 8);
        return { ...s, phase: 'hunt', huntStartedAt: Date.now(), notifications, feed: logIn(s, 'Head start over — the hunt is on!') };
      });
    }
  }, [now, state.phase, state.countdownEndsAt]);

  useEffect(() => {
    if (state.phase !== 'countdown' || !state.countdownEndsAt) return;
    const remaining = Math.max(0, state.countdownEndsAt - now);
    const endsAt = state.countdownEndsAt;
    const milestones = [
      [7200000, '2h', '2 hours left', 'The hider has 2 hours of head start remaining.'],
      [3600000, '1h', '1 hour left', 'The hider has 1 hour of head start remaining.'],
    ];
    for (const [ms, key, title, text] of milestones) {
      if (remaining <= ms && state.countdownMs > ms) {
        setState(s => {
          if (s.phase !== 'countdown') return s;
          const nUid = `cdwn_${key}_${endsAt}`;
          if (s.notifications.some(n => n.uid === nUid)) return s;
          return { ...s, notifications: [{ uid: nUid, to: 'both', title, text, at: Date.now() }, ...s.notifications].slice(0, 8) };
        });
      }
    }
  }, [now, state.phase, state.countdownEndsAt, state.countdownMs]);

  useEffect(() => {
    if (state.relocateEndsAt && now >= state.relocateEndsAt) {
      setState(s => ({ ...s, relocateEndsAt: null, paused: false, pausedAccum: s.pausedAccum + (s.pausedAt ? Date.now() - s.pausedAt : 0), pausedAt: null, feed: logIn(s, 'Relocation over — hunt resumes.') }));
    }
  }, [now, state.relocateEndsAt]);

  const countdownRemaining = state.countdownEndsAt ? Math.max(0, state.countdownEndsAt - now) : state.countdownMs;
  const relocateRemaining = state.relocateEndsAt ? Math.max(0, state.relocateEndsAt - now) : 0;
  const hideAnchor = state.huntFrozenAt || now;
  const pausedTotal = state.pausedAccum + (state.paused && !state.huntFrozenAt && state.pausedAt ? now - state.pausedAt : 0);
  const hideElapsed = state.huntStartedAt ? Math.max(0, hideAnchor - state.huntStartedAt - pausedTotal + state.bonusMs) : 0;

  useEffect(() => {
    const activeTime = now - pausedTotal;
    const hasExpired = state.effects.some(e => e.duration && activeTime >= (e.playedAtActiveTime || e.playedAt) + e.duration * 60000);
    if (hasExpired) setState(s => ({ ...s, effects: s.effects.filter(e => !(e.duration && activeTime >= (e.playedAtActiveTime || e.playedAt) + e.duration * 60000)) }));
  }, [now, state.effects, pausedTotal]);

  const patch = useCallback((fn) => setState(s => typeof fn === 'function' ? fn(s) : { ...s, ...fn }), []);
  function logIn(s, text) { return [{ t: Date.now(), text }, ...s.feed].slice(0, 40); }
  function notif(s, to, title, text) { return [{ uid: uid(), to, title, text, at: Date.now() }, ...s.notifications].slice(0, 8); }

  const actions = {
    pickRole(p, role) { patch(s => ({ ...s, roles: { ...s.roles, [p]: role } })); },
    clearRole(p) { patch(s => ({ ...s, roles: { ...s.roles, [p]: null } })); },
    startGame() { patch(s => ({ ...s, phase: 'countdown', countdownEndsAt: Date.now() + s.countdownMs, feed: logIn(s, 'Countdown started — hiders, go hide!') })); },
    skipCountdown() { patch(s => ({ ...s, phase: 'hunt', huntStartedAt: Date.now(), countdownEndsAt: Date.now(), feed: logIn(s, 'Head start skipped.') })); },

    askQuestion(catId, optIndex, customValue, askedLoc) {
      const cat = CAT_BY_ID[catId]; if (!cat) return;
      let opt = cat.options[optIndex];
      const isCustom = catId === 'radar' && opt === 'CUSTOM';
      let optStr = optionLabel(cat, opt);
      if (isCustom) { optStr = customValue || 'a custom range'; opt = customValue; }
      const text = isCustom ? `Are you within ${optStr} of me?` : cat.make(typeof opt === 'object' ? opt : optStr);
      const instruction = cat.id === 'photo' ? cat.options[optIndex].note : '';
      const qid = uid();
      patch(s => {
        const pausedTotal = s.pausedAccum + (s.paused && !s.huntFrozenAt && s.pausedAt ? Date.now() - s.pausedAt : 0);
        const activeTime = Date.now() - pausedTotal;
        // The seeker's GPS is already captured at ask time, so auto-share it as p1
        // for GPS questions. Single-GPS is then complete (timer starts now); double-GPS
        // still waits for the post-travel p2 before the timer starts.
        const autoP1 = cat.gps !== 'none' ? (askedLoc || null) : null;
        const timerDelayed = cat.gps === 'double';
        const startAt = timerDelayed ? null : activeTime;
        const aq = {
          id: qid, catId, optIndex, optStr, text, instruction, isCustom,
          askedAt: Date.now(), askedLoc: askedLoc || null,
          gpsMode: cat.gps, gps: { p1: autoP1, p2: null },
          answerCfg: cat.answer,
          timerStartedAt: startAt,
          timerEndsAt: startAt ? startAt + cat.timerSec * 1000 : null,
          answer: null, randomized: false,
          mapPin: s.map.pin,
        };
        return { ...s, activeQuestion: aq,
          asked: isCustom ? s.asked : { ...s.asked, [`${catId}:${optIndex}`]: true },
          feed: logIn(s, `Seeker asked: "${text}"`),
          notifications: notif(s, 'hider', 'New question', text) };
      });
    },

    sendGps(which, point) {
      patch(s => {
        if (!s.activeQuestion) return s;
        const gps = { ...s.activeQuestion.gps, [which]: point };
        const aq = { ...s.activeQuestion, gps };
        // The answer timer starts only when the seeker shares their final required position.
        // For double-GPS questions (Thermometer), that's p2. For single-GPS, it's p1.
        const isTrigger = aq.gpsMode === 'double' ? which === 'p2' : which === 'p1';
        if (isTrigger && !aq.timerEndsAt) {
          const cat = CAT_BY_ID[aq.catId];
          const pausedTotal = s.pausedAccum + (s.paused && !s.huntFrozenAt && s.pausedAt ? Date.now() - s.pausedAt : 0);
          const activeTime = Date.now() - pausedTotal;
          aq.timerStartedAt = activeTime;
          aq.timerEndsAt = activeTime + (cat?.timerSec || 300) * 1000;
        }
        return { ...s, activeQuestion: aq, feed: logIn(s, `Seeker shared GPS (${which}).`) };
      });
    },

    answerQuestion(value, photoDataUrl) {
      patch(s => {
        const aq = s.activeQuestion; if (!aq) return s;
        const cat = CAT_BY_ID[aq.catId];
        // Late penalty is measured from when the timer actually started. For a
        // delayed (double-GPS) question whose timer never started, there is no
        // penalty. Legacy questions without timerStartedAt fall back to askedAt.
        const pausedTotal = s.pausedAccum + (s.paused && !s.huntFrozenAt && s.pausedAt ? Date.now() - s.pausedAt : 0);
        const activeTime = Date.now() - pausedTotal;
        const startedAt = aq.timerStartedAt ?? (aq.askedAt ? aq.askedAt - pausedTotal : activeTime); // fallback for legacy
        const over = aq.timerEndsAt ? (activeTime - startedAt - cat.timerSec * 1000) : 0;
        const penalty = over > 0 ? 1 + Math.floor(over / 300000) : 0;
        const isFree = s.freeQuestion > 0;
        let baseDraw = isFree ? 0 : cat.draw;
        const useBonus = !isFree && s.drawBonus > 0;
        if (useBonus) baseDraw += 1;
        const { draw: dN, keep: kN } = isFree ? { draw: 0, keep: 0 } : applyDrawPenalty(baseDraw, cat.keep, penalty);
        const { cards, deck } = drawCards(s.deck, dN, s.deckConfig);
        let photos = s.photos; let photoUid = null;
        if (photoDataUrl) {
          photoUid = uid();
          photos = [...s.photos, { uid: photoUid, kind: 'answer', label: aq.optStr, dataUrl: photoDataUrl, at: Date.now(), by: 'hider' }];
        }
        const answer = { value: value || (photoDataUrl ? 'Photo sent' : ''), photoUid, at: Date.now(), penalty, drew: dN, kept: kN };
        // Auto-commit a CONFIRMED map cut for the pure-geometry categories using the
        // GPS captured when the question was asked (shared GPS, else the auto pin).
        // Feature-based categories (matching/measuring/tentacles) need async OSM
        // lookups, so they are resolved seeker-side in the map's History▸Confirmed view.
        const origin = aq.gps?.p1 || aq.askedLoc || aq.mapPin || null;
        let cut = null;
        if (aq.catId === 'radar') {
          const c = computeConstraint('radar', answer.value, aq.optStr, origin, null);
          if (c?.polygon) cut = { polygon: c.polygon, mode: c.mode };
        } else if (aq.catId === 'thermometer' && aq.gps?.p1 && aq.gps?.p2) {
          const keep = (answer.value || '').toLowerCase() === 'hotter' ? 'hotter' : 'colder';
          const poly = bisectorHalfPlane(aq.gps.p1, aq.gps.p2, keep);
          if (poly) cut = { polygon: poly, mode: 'intersect' };
        }
        let map = s.map;
        if (cut) {
          const full = { id: uid(), qid: aq.id, kind: aq.catId, label: `${cat.name}: ${answer.value}`, polygon: cut.polygon, mode: cut.mode, enabled: true };
          map = recomputeZone({ ...s.map, cuts: [...s.map.cuts, full] });
        }
        return { ...s, activeQuestion: null, deck, photos, map, drawBonus: useBonus ? s.drawBonus - 1 : s.drawBonus, freeQuestion: isFree ? 0 : s.freeQuestion,
          pendingDraw: { cards, keep: kN, questionId: aq.id, penalty },
          questionLog: [{ ...aq, answer }, ...s.questionLog],
          notifications: notif(s, 'seeker', 'Hider answered', answer.value),
          feed: logIn(s, penalty ? `Hider answered late — draw ${dN}, keep ${kN}.` : `Hider answered: ${answer.value}`) };
      });
    },

    resolveDraw(finalHand, keptCount) {
      patch(s => ({ ...s, hand: finalHand.slice(-12), pendingDraw: null, feed: logIn(s, `Hiders kept ${keptCount} card${keptCount === 1 ? '' : 's'}.`) }));
    },

    playCard(cardUid, costDiscards) {
      costDiscards = costDiscards || [];
      const item = stateRef.current.hand.find(h => h.uid === cardUid);
      const card = item && DECK_BY_ID[item.cardId]; if (!card) return;
      if (card.power === 'move') return actions.playMove(cardUid);
      if (card.power === 'veto') return actions.vetoQuestion(cardUid);
      if (card.power === 'randomize') return actions.randomizeQuestion(cardUid);
      const remove = new Set([cardUid, ...costDiscards]);
      patch(s => {
        let bonusMs = s.bonusMs, effects = s.effects, drawBonus = s.drawBonus, notifications = s.notifications, feed;
        const paid = costDiscards.length ? ` (paid: discarded ${costDiscards.length})` : '';
        if (card.type === 'time') { bonusMs += (card.bonusMin || 0) * 60000; feed = logIn(s, `Hiders banked a ${card.bonusMin}-min bonus.`); }
        else if (card.hiderEffect === 'drawBonus') { drawBonus = card.drawBonus || 3; feed = logIn(s, `Overflowing Chalice — +1 draw on the next ${drawBonus} questions${paid}.`); }
        else if (card.type === 'curse') {
          const pausedTotal = s.pausedAccum + (s.paused && !s.huntFrozenAt && s.pausedAt ? Date.now() - s.pausedAt : 0);
          const activeTime = Date.now() - pausedTotal;
          const effUid = uid();
          effects = [{ uid: effUid, cardId: card.id, type: 'curse', title: card.title, text: card.text,
            playedAt: Date.now(), playedAtActiveTime: activeTime, block: !!card.block, duration: card.duration || null, persist: !!card.persist,
            needsProof: !!card.block, proofUid: null }, ...effects];
          if (card.id === 'impressionable') s = { ...s, freeQuestion: 1 };
          const conditionalBonuses = card.bonusCondition
            ? [...(s.conditionalBonuses || []), { uid: effUid, cardId: card.id, title: card.title, min: card.bonusCondition.min, question: card.bonusCondition.text, applies: null }]
            : (s.conditionalBonuses || []);
          notifications = notif(s, 'seeker', 'Curse played', card.title);
          feed = logIn(s, `Hiders played "${card.title}"${paid}.`);
          return { ...s, bonusMs, effects, conditionalBonuses, drawBonus, notifications, feed, hand: s.hand.filter(h => !remove.has(h.uid)) };
        } else { feed = logIn(s, `Hiders played "${card.title}"${paid}.`); }
        return { ...s, bonusMs, effects, drawBonus, notifications, feed, hand: s.hand.filter(h => !remove.has(h.uid)) };
      });
    },

    vetoQuestion(cardUid) {
      patch(s => {
        const aq = s.activeQuestion; if (!aq) return s;
        return { ...s, activeQuestion: null, hand: s.hand.filter(h => h.uid !== cardUid),
          questionLog: [{ ...aq, answer: { value: 'Vetoed', photoUid: null, at: Date.now() } }, ...s.questionLog],
          feed: logIn(s, 'Hiders vetoed the question.'),
          notifications: notif(s, 'seeker', 'Question vetoed', 'No answer — and no reward.') };
      });
    },

    randomizeQuestion(cardUid) {
      patch(s => {
        const aq = s.activeQuestion; if (!aq) return s;
        const cat = CAT_BY_ID[aq.catId];
        const pool = cat.options.map((_, i) => i).filter(i => !(cat.id === 'radar' && cat.options[i] === 'CUSTOM') && !s.asked[`${cat.id}:${i}`]);
        const idx = pool.length ? pool[Math.floor(Math.random() * pool.length)] : Math.floor(Math.random() * cat.options.length);
        const opt = cat.options[idx];
        const optStr = optionLabel(cat, opt);
        const text = cat.make(typeof opt === 'object' ? opt : optStr);
        const instruction = cat.id === 'photo' ? cat.options[idx].note : '';
        const newAq = { ...aq, optIndex: idx, optStr, text, instruction, isCustom: false, randomized: true, answer: null };
        return { ...s, activeQuestion: newAq, hand: s.hand.filter(h => h.uid !== cardUid),
          asked: { ...s.asked, [`${cat.id}:${idx}`]: true },
          feed: logIn(s, `Randomized → "${text}"`),
          notifications: notif(s, 'seeker', 'Question randomized', text) };
      });
    },

    playMove() {
      patch(s => {
        if (s.phase !== 'hunt') return s;
        return { ...s, hand: [], activeQuestion: null, relocateEndsAt: Date.now() + 60 * 60000, paused: true, pausedAt: Date.now(),
          feed: logIn(s, 'Hiders played Move — relocating. Seekers frozen.'),
          notifications: notif(s, 'seeker', 'Hider is on the move', 'Frozen up to 60 min while the hider relocates.') };
      });
    },
    endRelocate() { patch(s => ({ ...s, relocateEndsAt: null, paused: false, pausedAccum: s.pausedAccum + (s.pausedAt ? Date.now() - s.pausedAt : 0), pausedAt: null, feed: logIn(s, 'Admin ended relocation.') })); },

    discardThenDraw(cardUid, discardUids) {
      const item = stateRef.current.hand.find(h => h.uid === cardUid);
      const card = item && DECK_BY_ID[item.cardId]; if (!card) return;
      patch(s => {
        const remove = new Set([cardUid, ...discardUids]);
        const { cards, deck } = drawCards(s.deck, card.drawN, s.deckConfig);
        return { ...s, deck, hand: [...s.hand.filter(h => !remove.has(h.uid)), ...cards].slice(-12), feed: logIn(s, `Hiders discarded ${discardUids.length} and drew ${card.drawN}.`) };
      });
    },

    duplicateCard(cardUid, targetUid) {
      patch(s => {
        const target = s.hand.find(h => h.uid === targetUid); if (!target) return s;
        return { ...s, hand: [...s.hand.filter(h => h.uid !== cardUid), { uid: uid(), cardId: target.cardId }].slice(-12), feed: logIn(s, 'Hiders duplicated a card.') };
      });
    },

    submitProof(effectUid, dataUrl) {
      patch(s => {
        const eff = s.effects.find(e => e.uid === effectUid); if (!eff) return s;
        const pUid = uid();
        const photos = [...s.photos, { uid: pUid, kind: 'curse-proof', label: eff.title, dataUrl, at: Date.now(), by: 'seeker' }];
        const effects = eff.persist
          ? s.effects.map(e => e.uid === effectUid ? { ...e, proofUid: pUid } : e)
          : s.effects.filter(e => e.uid !== effectUid);
        return { ...s, photos, effects, feed: logIn(s, `Seeker sent proof for "${eff.title}".`), notifications: notif(s, 'hider', 'Proof submitted', `${eff.title} cleared by the seeker.`) };
      });
    },

    clearEffect(effectUid) { patch(s => ({ ...s, effects: s.effects.filter(e => e.uid !== effectUid) })); },
    discardCard(cardUid) { patch(s => ({ ...s, hand: s.hand.filter(h => h.uid !== cardUid) })); },
    dismissNotification(nUid) { patch(s => ({ ...s, notifications: s.notifications.filter(n => n.uid !== nUid) })); },

    // ── Map actions (GeoJSON-based) ──
    mapSetCountries(ids, baseZone) {
      // baseZone is the GeoJSON Feature union of selected countries (computed outside the store)
      patch(s => {
        const map = recomputeZone({ ...s.map, selectedCountryIds: ids, baseZone: baseZone || null, cuts: [] });
        return { ...s, map };
      });
    },
    mapSetPin(latLng) { patch(s => ({ ...s, map: { ...s.map, pin: latLng } })); },
    // Add a cut. Manual Deduce-tab calls omit qid/enabled → a PREVIEW cut
    // (qid:null, enabled:false, off by default). The History▸Confirmed resolver
    // passes { qid, enabled:true } for an answered-question deduction.
    mapAddClue({ mode, geometry, label, kind, meta, qid = null, enabled }) {
      patch(s => {
        const isConfirmed = qid != null;
        const on = enabled !== undefined ? enabled : true; // confirmed & preview both default on
        const cut = { id: uid(), qid, kind: kind || 'deduce', label, polygon: geometry, mode, meta, enabled: on };
        const map = recomputeZone({ ...s.map, cuts: [...s.map.cuts, cut] });
        return { ...s, map, feed: logIn(s, isConfirmed ? `Confirmed: ${label}` : `Seeker preview: ${label}`) };
      });
    },
    // Toggle a reveal's impact on the zone on/off (it stays in the list).
    mapToggleCut(id) {
      patch(s => {
        if (!s.map.cuts.some(c => c.id === id)) return s;
        const cuts = s.map.cuts.map(c => c.id === id ? { ...c, enabled: c.enabled === false } : c);
        const map = recomputeZone({ ...s.map, cuts });
        return { ...s, map };
      });
    },
    mapDeleteCut(id) {
      patch(s => {
        if (!s.map.cuts.some(c => c.id === id)) return s;
        const map = recomputeZone({ ...s.map, cuts: s.map.cuts.filter(c => c.id !== id) });
        return { ...s, map, feed: logIn(s, 'Seeker removed a map reveal.') };
      });
    },
    mapSetP1(latLng) { patch(s => ({ ...s, map: { ...s.map, p1: latLng } })); },
    mapSetP2(latLng) { patch(s => ({ ...s, map: { ...s.map, p2: latLng } })); },
    mapUndoCut() {
      patch(s => {
        if (!s.map.cuts.length) return s;
        const map = recomputeZone({ ...s.map, cuts: s.map.cuts.slice(0, -1) });
        return { ...s, map, feed: logIn(s, 'Seeker undid the last map reveal.') };
      });
    },
    mapResetCuts() {
      patch(s => {
        const map = recomputeZone({ ...s.map, cuts: [] });
        return { ...s, map, feed: logIn(s, 'Seeker cleared all map reveals.') };
      });
    },
    mapResetAll() { patch(s => ({ ...s, map: freshMapState() })); },

    requestFound(role) {
      patch(s => {
        const other = role === 'hider' ? 'seeker' : 'hider';
        const bothFound = s.found[other];
        return { ...s, found: { ...s.found, [role]: true },
          feed: logIn(s, `${role === 'hider' ? 'Hider' : 'Seeker'} confirmed: found.`),
          ...(bothFound ? { phase: 'found', huntFrozenAt: Date.now() } : {}) };
      });
    },
    unrequestFound(role) { patch(s => ({ ...s, found: { ...s.found, [role]: false } })); },

    toggleConditionalBonus(bonusUid, applies) {
      patch(s => ({ ...s, conditionalBonuses: s.conditionalBonuses.map(b => b.uid === bonusUid ? { ...b, applies } : b) }));
    },

    submitNames(names, redeemCardUids = []) {
      patch(s => {
        const anchor = s.huntFrozenAt || Date.now();
        const paused = s.pausedAccum + (s.paused && !s.huntFrozenAt && s.pausedAt ? anchor - s.pausedAt : 0);
        const extraMs = (s.conditionalBonuses || []).filter(b => b.applies === true).reduce((acc, b) => acc + b.min * 60000, 0);
        const redeemSet = new Set(redeemCardUids);
        const endgameMs = s.hand.filter(h => redeemSet.has(h.uid)).reduce((acc, h) => acc + (DECK_BY_ID[h.cardId]?.bonusMin || 0) * 60000, 0);
        const ms = Math.max(0, anchor - (s.huntStartedAt || anchor) - paused + s.bonusMs + extraMs + endgameMs);
        const leaderboard = [...s.leaderboard, { names, ms }].sort((a, b) => b.ms - a.ms);
        const hand = s.hand.filter(h => !redeemSet.has(h.uid));
        return { ...s, leaderboard, hand, phase: 'leaderboard', feed: logIn(s, `${names} posted to the leaderboard.`) };
      });
    },

    // ── Admin ──
    setPhase(phase) {
      patch(s => {
        const n = { ...s, phase };
        if (phase === 'countdown' && !s.countdownEndsAt) n.countdownEndsAt = Date.now() + s.countdownMs;
        if (phase === 'hunt' && !s.huntStartedAt) n.huntStartedAt = Date.now();
        if (phase === 'hunt') n.huntFrozenAt = null;
        if (phase === 'found') n.huntFrozenAt = Date.now();
        n.feed = logIn(s, `Admin set state → ${phase}.`);
        return n;
      });
    },
    togglePause() {
      patch(s => s.paused
        ? { ...s, paused: false, pausedAccum: s.pausedAccum + (s.pausedAt ? Date.now() - s.pausedAt : 0), pausedAt: null, feed: logIn(s, 'Admin resumed hiding time.') }
        : { ...s, paused: true, pausedAt: Date.now(), feed: logIn(s, 'Admin paused hiding time.') });
    },
    adjustCountdown(d) { patch(s => s.countdownEndsAt ? { ...s, countdownEndsAt: s.countdownEndsAt + d * 60000 } : { ...s, countdownMs: Math.max(0, s.countdownMs + d * 60000) }); },
    adjustHide(d) { patch(s => ({ ...s, bonusMs: s.bonusMs + d * 60000, feed: logIn(s, `Admin ${d >= 0 ? 'added' : 'removed'} ${Math.abs(d)} min of hide time.`) })); },
    giveCard(cardId) { patch(s => ({ ...s, hand: [...s.hand, { uid: uid(), cardId }].slice(-12), feed: logIn(s, 'Admin gave a card.') })); },
    clearHand() { patch(s => ({ ...s, hand: [], feed: logIn(s, 'Admin cleared the hand.') })); },
    removeLeader(i) { patch(s => ({ ...s, leaderboard: s.leaderboard.filter((_, j) => j !== i) })); },
    clearLeaderboard() { patch(s => ({ ...s, leaderboard: [] })); },
    setCountdownMins(m) { patch(s => ({ ...s, countdownMs: Math.max(0, m) * 60000, countdownEndsAt: s.phase === 'countdown' ? Date.now() + Math.max(0, m) * 60000 : s.countdownEndsAt })); },
    setDeckConfig(cfg) { patch(s => ({ ...s, deckConfig: cfg, deck: buildDeck(cfg), feed: logIn(s, 'Admin rebuilt the hider deck.') })); },
    reset() {
      patch(s => {
        const fresh = freshState(cfg);
        fresh.leaderboard = s.leaderboard;
        fresh.deckConfig = s.deckConfig;
        fresh.deck = buildDeck(s.deckConfig);
        fresh.countdownMs = s.countdownMs;
        if (s.map.selectedCountryIds?.length) {
          fresh.map = recomputeZone({ ...fresh.map, selectedCountryIds: s.map.selectedCountryIds, baseZone: s.map.baseZone });
        }
        return fresh;
      });
    },
    kickAll() { patch(s => ({ ...s, kickedAt: Date.now() })); },
    syncApply(newState) { setState(newState); },
  };

  return { state, now, countdownRemaining, relocateRemaining, hideElapsed, pausedTotal, actions };
}
