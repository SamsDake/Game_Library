// SeekerMap.jsx — Leaflet GeoJSON deduction map (replaces the abstract SVG cell grid)
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, GeoJSON, Marker, useMapEvents, useMap } from 'react-leaflet';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { maskPolygon, applyClue, areaKm2, circle } from '../lib/geometry.js';
import { CAT_BY_ID } from '../lib/data.js';
import { Icon } from './ui.jsx';
import { useCountries } from '../lib/useCountries.js';
import { DeductionConsole } from './DeductionConsole.jsx';
import { resolveDeduction, tentacleCut, isDeducible } from '../lib/deduce.js';

// Fix default marker icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Custom orange pin icon for the seeker
const seekerIcon = L.divIcon({
  className: '',
  html: `<div style="width:14px;height:14px;border-radius:50%;background:var(--accent, #FF6A2B);border:2px solid #1c0c03;box-shadow:0 0 10px rgba(255,106,43,0.6)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

// Thermometer point icons (A, B)
function tpIcon(label) {
  return L.divIcon({
    className: '',
    html: `<div style="width:22px;height:22px;border-radius:50%;background:var(--c-seeker,#4FB7FF);border:2px solid #0a111a;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#0a111a;font-family:sans-serif">${label}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// Auto-fit map to the current zone
function MapFitter({ zone }) {
  const map = useMap();
  useEffect(() => {
    if (!zone) return;
    try {
      const layer = L.geoJSON(zone);
      const bounds = layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10 });
    } catch { /* invalid GeoJSON cannot be fitted */ }
  }, [map, zone]);
  return null;
}

// Handles map clicks for placing pin or thermometer points
function MapClickHandler({ onCellTap }) {
  useMapEvents({ click: (e) => onCellTap(e.latlng) });
  return null;
}

// ── Reveal list helpers: every map-affecting question, with on/off toggles ──
// Only enabled cuts shape the zone (disabled ones stay listed but inert), so the
// reduction % is computed over the enabled subset.
function zoneAfter(baseZone, cuts) {
  let z = baseZone;
  for (const c of cuts) { if (c.enabled === false) continue; z = applyClue(z, c.polygon, c.mode); if (!z) break; }
  return z;
}
// Reduction % a cut contributes at its position in the full sequence.
function reductionAtIndex(map, i) {
  if (map.cuts[i].enabled === false) return null;
  const before = areaKm2(zoneAfter(map.baseZone, map.cuts.slice(0, i)));
  const after = areaKm2(zoneAfter(map.baseZone, map.cuts.slice(0, i + 1)));
  if (!before) return 0;
  return Math.max(0, Math.round((1 - after / before) * 100));
}

// One toggle row for a committed cut (used by both Preview & Confirmed lists).
function CutRow({ map, cut, actions, label }) {
  const i = map.cuts.findIndex(c => c.id === cut.id);
  const on = cut.enabled !== false;
  const pct = on ? reductionAtIndex(map, i) : null;
  return (
    <div className="reveal-item" style={{ opacity: on ? 1 : 0.5 }}>
      <button
        className="reveal-toggle"
        title={on ? 'Impact ON — tap to turn off' : 'Impact OFF — tap to turn on'}
        onClick={() => actions.mapToggleCut(cut.id)}
        style={{ flexShrink: 0, width: 30, height: 18, borderRadius: 9, padding: 0, position: 'relative', background: on ? 'var(--accent)' : 'var(--line-2)', transition: '.15s' }}
      >
        <span style={{ position: 'absolute', top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: '.15s' }} />
      </button>
      <span className={`reveal-dot ${cut.kind}`} />
      <span className="reveal-label">{label ?? cut.label}</span>
      <span className="reveal-pct">{on ? `−${pct}%` : 'off'}</span>
      <button className="reveal-del" title="Remove this reveal" onClick={() => actions.mapDeleteCut(cut.id)}><Icon name="close" size={13} /></button>
    </div>
  );
}

// Preview list = the manual, speculative deductions made in the Deduce tab (qid null).
function PreviewList({ map, actions }) {
  const cuts = map.cuts.filter(c => c.qid == null);
  if (!cuts.length) return <p className="map-hint">No preview deductions yet. Build one in the <b>Deduce</b> tab — it lands here, off until you toggle it on.</p>;
  return (
    <div className="reveal-list">
      {cuts.map(c => <CutRow key={c.id} map={map} cut={c} actions={actions} />)}
    </div>
  );
}

// Picker for a Tentacles answer — the seeker taps the place the hider named.
function TentaclePicker({ pick, onChoose, onClose }) {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" style={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="modal-kicker">TENTACLES</div>
        <h3 className="modal-title">Pick the place the hider named</h3>
        {pick.hint && <p className="modal-sub">Hider answered: “{pick.hint}”</p>}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
          {pick.candidates.features.map((f, i) => (
            <button key={i} className="q-item" style={{ opacity: 1 }} onClick={() => onChoose(f)}>
              <span className="q-text">{f.properties?.name || 'Unnamed'}</span>
            </button>
          ))}
        </div>
        <button className="admin-text-btn" style={{ marginTop: 8 }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// Confirmed list = every hider-answered question, auto-deduced from the GPS
// captured at ask time. Radar/Thermometer already have cuts (made on answer);
// Matching/Measuring auto-resolve here (async OSM lookups); Tentacles taps Resolve.
function ConfirmedList({ state, actions, countries, active }) {
  const map = state.map;
  const questions = state.questionLog.filter(isDeducible);
  const [status, setStatus] = useState({}); // qid → 'resolving' | error string
  const [pick, setPick] = useState(null);   // { qid, candidates, label, hint }
  const [picking, setPicking] = useState(false);
  const resolvingRef = useRef(new Set());

  const qidsKey = questions.map(q => q.id).join(',');

  // Auto-resolve answered Matching/Measuring questions that don't have a cut yet.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      const ctx = { currentZone: map.currentZone, baseZone: map.baseZone, countries, selectedIds: map.selectedCountryIds };
      for (const q of questions) {
        if (cancelled) return;
        if (map.cuts.some(c => c.qid === q.id)) continue; // already resolved
        if (status[q.id] === 'pick') continue;            // waiting on manual fallback pick
        if (resolvingRef.current.has(q.id)) continue;
        resolvingRef.current.add(q.id);
        setStatus(s => ({ ...s, [q.id]: 'resolving' }));
        try {
          const r = await resolveDeduction(q, ctx);
          if (cancelled) return;
          if (r.geometry) {
            actions.mapAddClue({ qid: q.id, enabled: true, mode: r.mode, geometry: r.geometry, kind: r.kind, label: r.label });
            setStatus(s => { const n = { ...s }; delete n[q.id]; return n; });
          } else if (r.needsPick) {
            setStatus(s => ({ ...s, [q.id]: 'pick' })); // unmatched tentacles → seeker picks by hand
          } else {
            setStatus(s => ({ ...s, [q.id]: r.error || 'Could not resolve.' }));
          }
        } catch (e) {
          if (!cancelled) setStatus(s => ({ ...s, [q.id]: e.message || 'Resolve failed.' }));
        } finally {
          resolvingRef.current.delete(q.id);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [active, qidsKey, map.cuts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const startPick = async (q) => {
    setPicking(true);
    setStatus(s => ({ ...s, [q.id]: 'resolving' }));
    try {
      const ctx = { currentZone: map.currentZone, baseZone: map.baseZone, countries, selectedIds: map.selectedCountryIds };
      const r = await resolveDeduction(q, ctx);
      if (r.needsPick) { setPick({ qid: q.id, candidates: r.candidates, label: r.label, hint: r.hint }); setStatus(s => { const n = { ...s }; delete n[q.id]; return n; }); }
      else setStatus(s => ({ ...s, [q.id]: r.error || 'Could not resolve.' }));
    } catch (e) { setStatus(s => ({ ...s, [q.id]: e.message || 'Resolve failed.' })); }
    finally { setPicking(false); }
  };

  const choose = (feature) => {
    const zone = map.currentZone || map.baseZone;
    const cut = tentacleCut(feature, pick.candidates, zone, pick.label);
    if (cut) actions.mapAddClue({ qid: pick.qid, enabled: true, mode: cut.mode, geometry: cut.geometry, kind: cut.kind, label: cut.label });
    setPick(null);
  };

  if (!questions.length) return <p className="map-hint">No confirmed deductions yet — ask the hider a question and they'll appear here once answered.</p>;

  return (
    <div className="reveal-list">
      {questions.map(q => {
        const cut = map.cuts.find(c => c.qid === q.id);
        const st = status[q.id];
        const origin = q.gps?.p1 || q.askedLoc;
        return (
          <div key={q.id}>
            {cut
              ? <CutRow map={map} cut={cut} actions={actions} label={`${CAT_BY_ID[q.catId].name}: ${q.answer.value}`} />
              : (
                <div className="reveal-item">
                  <span className={`reveal-dot ${q.catId}`} />
                  <span className="reveal-label">{CAT_BY_ID[q.catId].name}: {q.answer.value}</span>
                  {st === 'pick'
                    ? <button className="map-text-btn" disabled={picking} onClick={() => startPick(q)}>Resolve</button>
                    : <span className="reveal-pct">{st === 'resolving' ? '…' : '—'}</span>}
                </div>
              )}
            <div className="map-hint" style={{ fontSize: 10, paddingLeft: 40, marginTop: -2 }}>
              {q.text}{origin ? ` · asked @ ${origin.lat.toFixed(3)}, ${origin.lng.toFixed(3)}` : ''}
            </div>
            {st && st !== 'resolving' && <div className="map-hint" style={{ fontSize: 10, paddingLeft: 40, color: 'var(--c-curse)' }}>{st}</div>}
          </div>
        );
      })}
      {pick && <TentaclePicker pick={pick} onChoose={choose} onClose={() => setPick(null)} />}
    </div>
  );
}

// ── The map sheet ────────────────────────────────────────────────
export function SeekerMap({ state, actions, onClose }) {
  const map = state.map;
  const { countries } = useCountries();
  const [mode, setMode] = useState('deduce');     // tabs: deduce | history
  const [histView, setHistView] = useState('confirmed'); // history sub-view: confirmed | preview
  const [fitter, setFitter] = useState(0);
  // Deduction console map-interaction state (place-seeker / place-shrink / place-hotcold)
  const [dedMode, setDedMode] = useState('idle');
  const [dedPending, setDedPending] = useState(null);
  const [dedStatus, setDedStatus] = useState('');
  const currentZone = map.currentZone || map.baseZone;

  // Dark mask (world minus zone)
  const mask = useMemo(() => currentZone ? maskPolygon(currentZone) : null, [currentZone]);

  // GeoJSON layers must remount when the enabled-cut set changes (react-leaflet
  // doesn't diff `data`). A stable string of enabled cut ids does it — and stays
  // constant across WS syncs (which replace object refs), so no re-render loop.
  const enabledSig = map.cuts.filter(c => c.enabled !== false).map(c => c.id).join(',');

  // Re-fit the map when the game area (country selection) changes. Keyed on a
  // STABLE string, not map.baseZone: the WS sync replaces the whole state tree
  // each message, so the baseZone object reference changes on every sync — using
  // it here caused an infinite setState→sync→setState loop while the map was open.
  const countryKey = map.selectedCountryIds.join(',');
  useEffect(() => { if (map.baseZone) setFitter(x => x + 1); }, [countryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map taps drive the Deduce tab's place-seeker / place-shrink / place-hotcold flows.
  const handleMapClick = useCallback((latlng) => {
    if (mode !== 'deduce') return;
    const p = { lat: latlng.lat, lng: latlng.lng };
    if (dedMode === 'place-seeker') {
      actions.mapSetPin(p); setDedMode('idle'); setDedStatus('Seeker pin placed.');
    } else if (dedMode === 'place-shrink') {
      const r = dedPending?.radius ?? 50000;
      actions.mapAddClue({
        mode: dedPending?.safe ? 'intersect' : 'difference', geometry: circle(p, r), kind: 'shrink',
        label: `Manual ${dedPending?.safe ? 'safe' : 'exclude'} ${(r / 1000).toFixed(0)} km`,
        meta: { center: p, radius: r },
      });
      setDedMode('idle'); setDedPending(null); setDedStatus('Shrink circle applied.');
    } else if (dedMode === 'place-hotcold') {
      setDedPending(pp => ({ ...pp, newPos: p })); setDedMode('idle'); setDedStatus('New position set — choose Hotter or Colder.');
    }
  }, [mode, dedMode, dedPending, actions]);

  return (
    <div className="sheet">
      <div className="sheet-head">
        <button className="icon-btn" onClick={onClose}><Icon name="back" size={20} /></button>
        <div className="sheet-title"><Icon name="map" size={18} /> Tactical map</div>
        <span style={{ width: 36 }} />
      </div>
      <div className="sheet-body" style={{ padding: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Map */}
        <div style={{ flex: '0 0 auto', height: 340, position: 'relative' }}>
          <MapContainer
            center={[50, 10]} zoom={4}
            style={{ width: '100%', height: '100%' }}
            zoomControl={false}
            attributionControl={false}
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution=""
            />
            {/* Base zone (selected countries) */}
            {map.baseZone && !currentZone && (
              <GeoJSON key="base" data={map.baseZone} style={{ fillColor: 'rgba(255,106,43,0.25)', color: 'rgba(255,106,43,0.7)', weight: 1.5, fillOpacity: 1 }} />
            )}
            {/* Current zone (after enabled cuts) — keyed on the enabled set so a
                toggle remounts it and the map repaints */}
            {currentZone && (
              <GeoJSON key={`zone-${enabledSig}`} data={currentZone} style={{ fillColor: 'rgba(255,106,43,0.35)', color: '#FF6A2B', weight: 2, fillOpacity: 1 }} />
            )}
            {/* Dark mask over eliminated area */}
            {mask && currentZone && (
              <GeoJSON key={`mask-${enabledSig}`} data={mask} style={{ fillColor: 'rgba(10,8,7,0.65)', color: 'transparent', weight: 0, fillOpacity: 1 }} interactive={false} />
            )}
            {/* Seeker pin */}
            {map.pin && <Marker position={[map.pin.lat, map.pin.lng]} icon={seekerIcon} />}
            {/* Deduce hot/cold new position */}
            {mode === 'deduce' && dedPending?.newPos && <Marker position={[dedPending.newPos.lat, dedPending.newPos.lng]} icon={tpIcon('B')} />}
            <MapClickHandler onCellTap={handleMapClick} />
            {fitter > 0 && <MapFitter key={fitter} zone={currentZone || map.baseZone} />}
          </MapContainer>
          {/* Placing hint overlay */}
          {mode === 'deduce' && dedMode === 'place-seeker' && <div className="map-placing">Tap map to drop the seeker pin</div>}
          {mode === 'deduce' && dedMode === 'place-shrink' && <div className="map-placing">Tap map to drop the shrink circle</div>}
          {mode === 'deduce' && dedMode === 'place-hotcold' && <div className="map-placing">Tap your NEW position (after travel)</div>}
        </div>

        {/* Controls */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 32px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Legend */}
          <div className="map-legend">
            <span className="ml-item"><span className="ml-sw ml-avail" /> In play</span>
            <span className="ml-item"><span className="ml-sw ml-elim" /> Ruled out</span>
            <span className="ml-item"><span className="ml-sw ml-out" /> Off-map</span>
            {map.cuts.length > 0 && <span className="ml-item" style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 11 }}>{map.cuts.length} reveal{map.cuts.length !== 1 ? 's' : ''}</span>}
          </div>

          {/* Mode tabs */}
          <div className="map-modes" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            {[['deduce', 'Deduce', 'list'], ['history', 'History', 'time']].map(([id, label, ic]) => (
              <button key={id} className={`map-mode${mode === id ? ' is-on' : ''}`} onClick={() => setMode(id)}><Icon name={ic} size={15} /> {label}</button>
            ))}
          </div>

          {/* No game area yet — the admin sets it */}
          {!map.baseZone && (
            <p className="map-hint" style={{ color: 'var(--text-faint)' }}>No game area set yet — ask the admin to choose the countries in play.</p>
          )}

          {/* Deduce mode — full deduction console (manual / preview deductions) */}
          {mode === 'deduce' && (
            <div className="map-ctl">
              <DeductionConsole
                state={state} actions={actions} countries={countries}
                mapMode={dedMode} setMapMode={setDedMode}
                pending={dedPending} setPending={setDedPending}
                status={dedStatus} setStatus={setDedStatus}
              />
            </div>
          )}

          {/* History mode — confirmed (answered) + preview (manual) deductions */}
          {mode === 'history' && (
            <div className="map-ctl">
              <div className="map-modes" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                {[['confirmed', 'Confirmed'], ['preview', 'Preview']].map(([id, label]) => (
                  <button key={id} className={`map-mode${histView === id ? ' is-on' : ''}`} onClick={() => setHistView(id)}>{label}</button>
                ))}
              </div>
              {histView === 'confirmed'
                ? <ConfirmedList state={state} actions={actions} countries={countries} active={mode === 'history' && histView === 'confirmed'} />
                : <PreviewList map={map} actions={actions} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Compact map strip on the seeker panel ───────────────────────
export function MapStrip({ state, onOpen }) {
  const map = state.map;
  const hasZone = !!(map.currentZone || map.baseZone);
  return (
    <button className="map-strip" onClick={onOpen}>
      <div className="map-strip-mini">
        {hasZone
          ? <div style={{ width: '100%', height: '100%', background: 'rgba(255,106,43,0.3)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="map" size={22} /></div>
          : <div style={{ width: '100%', height: '100%', background: 'rgba(255,238,228,0.05)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="globe" size={20} /></div>}
      </div>
      <div className="map-strip-body">
        <div className="map-strip-title"><Icon name="map" size={15} /> Tactical map</div>
        <div className="map-strip-sub">
          {hasZone
            ? `${map.selectedCountryIds.length} countr${map.selectedCountryIds.length === 1 ? 'y' : 'ies'} · ${map.cuts.length} reveal${map.cuts.length === 1 ? '' : 's'}`
            : 'Tap to set up the game area'}
        </div>
      </div>
      <Icon name="chevron" size={18} />
    </button>
  );
}
