// store.js
// Single source of truth. The design principle: clues are stored as a list of
// constraints (each = a polygon + mode + label + metadata). The current zone is
// DERIVED by folding the base country zone through that list. This makes both
// requested behaviours fall out for free:
//   - "Undo last clue"  -> drop the last clue, recompute.
//   - "Delete this clue" -> drop any clue by id, recompute.
// Nothing is mutated in place, and recompute never needs to re-query Overpass
// because each clue carries its own resolved geometry.

import { create } from 'zustand';
import { unionAll, computeZone, areaKm2, mainCluster } from './geometry';
import { idbStateGet, idbStateSet } from './idbState';
import { pushState } from './sync';

// Set to true while applying a remote state update so persist() skips the
// pushState call and doesn't echo the change back to the server.
let _suppressPush = false;

const LS_KEY = 'jetlag-deduction-v1';

// crypto.randomUUID() only exists in secure contexts (HTTPS or localhost). When
// the app is opened over a plain-HTTP LAN address (e.g. http://192.168.x.x:5173
// on a phone), it's undefined — so fall back to a manual UUID generator. We try
// crypto.getRandomValues for good randomness, then Math.random as a last resort.
function makeId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
      return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
    }
  } catch { /* fall through */ }
  // Last resort: not cryptographically strong, but unique enough for clue ids.
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function persist(state) {
  const data = {
    selectedIds: state.selectedIds,
    seeker: state.seeker,
    clues: state.clues,
  };
  // Primary: IndexedDB — structured clone, no 5 MB cap, survives Safari clearing localStorage.
  idbStateSet(data); // fire-and-forget
  // Secondary: localStorage — synchronous fallback for browsers without IDB,
  // and migration path for sessions that loaded state from localStorage.
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('localStorage persist failed (probably quota)', e);
  }
  if (!_suppressPush) pushState(data);
}

function loadPersistedSync() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Recompute baseZone + currentZone and the derived stats, then persist.
function recompute(set, get, patch = {}) {
  const s = { ...get(), ...patch };
  const selectedFeatures = s.countries
    .filter((c) => s.selectedIds.includes(c.id))
    .map((c) => mainCluster(c.feature)); // drop far-flung overseas territories
  const baseZone = unionAll(selectedFeatures);
  const currentZone = computeZone(baseZone, s.clues);
  const next = {
    ...patch,
    baseZone,
    currentZone,
    baseArea: areaKm2(baseZone),
    currentArea: areaKm2(currentZone),
  };
  set(next);
  persist({ ...s, ...next });
}

export const useStore = create((set, get) => ({
  // --- data ---
  countries: [],          // [{ id, name, feature }]
  selectedIds: [],
  seeker: null,           // { lat, lng }
  clues: [],              // [{ id, mode, geometry, label, kind, meta }]

  // --- derived (kept in state so the map doesn't recompute each render) ---
  baseZone: null,
  currentZone: null,
  baseArea: 0,
  currentArea: 0,

  // --- transient UI ---
  mapMode: 'idle',        // 'idle' | 'place-seeker' | 'place-shrink' | 'place-hotcold'
  status: '',             // status / error line
  pending: null,          // scratch data for multi-step questions (e.g. hot/cold)

  // --- lifecycle ---
  async setCountries(list) {
    set({ countries: list });
    // Prefer IndexedDB (primary, survives iOS Safari localStorage eviction).
    // Fall back to localStorage for migration from older sessions.
    let saved = await idbStateGet();
    if (!saved) saved = loadPersistedSync();
    if (saved) {
      recompute(set, get, {
        selectedIds: saved.selectedIds || [],
        seeker: saved.seeker || null,
        clues: saved.clues || [],
      });
    } else {
      recompute(set, get, {});
    }
  },

  setStatus(status) { set({ status }); },
  setMapMode(mapMode) { set({ mapMode }); },
  setSeeker(seeker) { recompute(set, get, { seeker }); },
  setPending(pending) { set({ pending }); },

  toggleCountry(id) {
    const selectedIds = get().selectedIds.includes(id)
      ? get().selectedIds.filter((x) => x !== id)
      : [...get().selectedIds, id];
    recompute(set, get, { selectedIds });
  },

  // --- the clue pipeline ---
  addClue(clue) {
    const withId = { id: makeId(), ...clue };
    recompute(set, get, { clues: [...get().clues, withId] });
  },

  undoLastClue() {
    recompute(set, get, { clues: get().clues.slice(0, -1) });
  },

  deleteClue(id) {
    recompute(set, get, { clues: get().clues.filter((c) => c.id !== id) });
  },

  resetAll() {
    recompute(set, get, { selectedIds: [], clues: [], seeker: null, pending: null });
  },

  // Apply a state snapshot received from the sync server without echoing it back.
  applyRemoteState(data) {
    _suppressPush = true;
    try {
      recompute(set, get, {
        selectedIds: data.selectedIds || [],
        seeker: data.seeker || null,
        clues: data.clues || [],
      });
    } finally {
      _suppressPush = false;
    }
  },
}));
