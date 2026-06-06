// DeductionConsole.jsx
// The Seeker's full deduction console, ported from jetlag-deduction-board's
// QuestionPanel. Every control ends by calling actions.mapAddClue({ mode,
// geometry, label, kind, meta }), which folds a constraint into the shared
// map.cuts zone. Feature questions branch on the feature's geom kind
// (point / line / area); supported question types are declared per-feature in
// FEATURES[...].modes.
//
// Rewired from the board's Zustand store to the mobile app's store via props:
//   seeker      → state.map.pin            (setSeeker → actions.mapSetPin)
//   currentZone → state.map.currentZone    baseZone → state.map.baseZone
//   addClue     → actions.mapAddClue       selectedIds → state.map.selectedCountryIds
//   countries   → Natural Earth features loaded by SeekerMap (border branch)
//   mapMode / pending / status are lifted into SeekerMap so map clicks can
//   complete the place-seeker / place-shrink / place-hotcold flows.

import { useState } from 'react';
import {
  circle, bisectorHalfPlane, multiBuffer, multiBufferLines, voronoiCell,
  lineCatchment, nearestLineGroup, containingPolygon, linesFromPolygons,
  mainCluster, nearest, distanceKm, bboxOf, pt,
} from '../lib/geometry.js';
import { fetchFeature, clipPointsToZone, pointsWithinRadius, FEATURES, ADMIN_LEVELS, invalidateFeature } from '../lib/overpass.js';
import { countryId } from '../lib/useCountries.js';
import { elevationConstraint } from '../lib/elevation.js';
import { Icon, Btn, CoordEntry } from './ui.jsx';
import { requestLocation } from '../lib/ui-helpers.js';

function Section({ title, children }) {
  return (
    <div className="ded-sec">
      <div className="sk-section-label">{title}</div>
      {children}
    </div>
  );
}

// The 5 question categories (+ Manual shrink) surfaced as buttons. Selecting one
// reveals only that category's controls, instead of one long scroll.
const CATS = [
  ['radius', 'Radius', 'radar'],
  ['measuring', 'Measuring', 'measuring'],
  ['matching', 'Matching', 'matching'],
  ['thermometer', 'Thermometer', 'thermo'],
  ['tentacles', 'Tentacles', 'tentacles'],
  ['shrink', 'Shrink', 'pin'],
];
// Feature-based categories → the FEATURES mode they require.
const CAT_MODE = { measuring: 'relative', matching: 'nearest', tentacles: 'target' };

export function DeductionConsole({ state, actions, countries, mapMode, setMapMode, pending, setPending, status, setStatus }) {
  const seeker = state.map.pin;
  const setSeeker = actions.mapSetPin;
  const currentZone = state.map.currentZone || state.map.baseZone;
  const baseZone = state.map.baseZone;
  const selectedIds = state.map.selectedCountryIds;
  const addClue = actions.mapAddClue;

  const [radius, setRadius] = useState(50000);
  const [shrinkRadius, setShrinkRadius] = useState(50000);
  const [shrinkSafe, setShrinkSafe] = useState(true);
  const [feature, setFeature] = useState('airport');
  const [adminLevel, setAdminLevel] = useState(6);
  const [busy, setBusy] = useState(false);
  const [nearbyPOIs, setNearbyPOIs] = useState(null);
  const [category, setCategory] = useState('radius');

  const cfg = FEATURES[feature];
  const isLine = cfg.geom === 'line';
  const isArea = cfg.geom === 'area';
  const isElevation = cfg.special === 'elevation';
  const needSeeker = !seeker;
  const needZone = !currentZone;
  const seekerPt = seeker ? pt(seeker.lng, seeker.lat) : null;

  const featuresForMode = (mode) => Object.entries(FEATURES).filter(([, v]) => (v.modes || []).includes(mode));
  // Switch category; if the current feature can't answer the new category, pick
  // the first feature that can.
  const selectCategory = (key) => {
    setCategory(key);
    setNearbyPOIs(null);
    const mode = CAT_MODE[key];
    if (mode && !(FEATURES[feature]?.modes || []).includes(mode)) {
      const first = featuresForMode(mode)[0];
      if (first) setFeature(first[0]);
    }
  };

  async function useGPS() {
    setStatus('Locating…');
    try {
      const loc = await requestLocation();
      setSeeker({ lat: loc.lat, lng: loc.lng });
      setStatus('Located via GPS.');
    } catch {
      setStatus('Could not get GPS fix.');
    }
  }

  function radiusQuestion(within) {
    addClue({
      mode: within ? 'intersect' : 'difference',
      geometry: circle(seeker, radius), kind: 'radius',
      label: `Within ${(radius / 1000).toFixed(0)} km? → ${within ? 'YES' : 'NO'}`,
      meta: { center: seeker, radius },
    });
    setStatus('Radius clue applied.');
  }

  function startHotCold() {
    if (!seeker) return setStatus('Place the seeker first (becomes your OLD position).');
    setPending({ old: seeker });
    setMapMode('place-hotcold');
    setStatus('Tap your NEW position on the map.');
  }
  function resolveHotCold(hotter) {
    // App's bisectorHalfPlane takes keep ∈ {'hotter','colder'} (old=p1, new=p2).
    addClue({
      mode: 'intersect',
      geometry: bisectorHalfPlane(pending.old, pending.newPos, hotter ? 'hotter' : 'colder'),
      kind: 'hotcold', label: `Moved → ${hotter ? 'HOTTER' : 'COLDER'}`,
      meta: { old: pending.old, newPos: pending.newPos, hotter },
    });
    setSeeker(pending.newPos);
    setPending(null);
    setStatus('Bisector applied; seeker moved to new position.');
  }

  function armShrink() {
    setPending({ radius: shrinkRadius, safe: shrinkSafe });
    setMapMode('place-shrink');
    setStatus('Tap the map to drop the shrink circle.');
  }

  // Resolve feature data: Overpass for most, local geometry for borders.
  // Query against the STABLE base-zone bbox so repeat questions are cache hits;
  // features are then clipped to currentZone locally.
  async function getData(forceRefresh = false) {
    if (feature === 'border') {
      const feats = countries
        .filter((f) => selectedIds.includes(countryId(f)))
        .map((f) => mainCluster(f));
      return { geom: 'line', fc: linesFromPolygons(feats), complete: true, cached: false };
    }
    if (forceRefresh) invalidateFeature(feature);
    const fetchBbox = bboxOf(baseZone || currentZone);
    return fetchFeature(feature, fetchBbox, { adminLevel });
  }

  function dataNote(res) {
    if (res.complete === false) return ' ⚠ partial data (not cached — Refresh & re-ask for full coverage)';
    if (res.cached === 'preload') return ' (preloaded — instant)';
    if (res.cached === 'idb') return ' (from saved cache)';
    if (res.cached === 'memory') return ' (from cache)';
    return '';
  }

  async function suggestAdminLevel() {
    const others = ADMIN_LEVELS.filter((a) => a.level !== adminLevel);
    for (const a of others) {
      try {
        const r = await fetchFeature('admin', bboxOf(baseZone || currentZone), { adminLevel: a.level });
        if (r?.fc?.features?.length) {
          const hit = containingPolygon(r.fc, seekerPt);
          if (hit) return ` Try “${a.label}” — the seeker is in “${hit.properties?.name}” there.`;
        }
      } catch { /* ignore and try next level */ }
    }
    return ' No division covers this spot at any available level here (e.g. some capitals/Luxembourg).';
  }

  // ---- Category 1: nearest feature / same division ----
  async function nearestQuestion(same) {
    setBusy(true);
    try {
      setStatus(`Querying ${cfg.label}…`);
      const res = await getData();
      const { geom, fc } = res;
      if (!fc.features.length) return setStatus('No such features in the zone.');

      let constraint = null, detail = '';
      if (geom === 'area') {
        constraint = containingPolygon(fc, seekerPt);
        if (!constraint) {
          setStatus('Seeker is not inside any division at this level — checking other levels…');
          return setStatus('Seeker is not inside any division at this level.' + await suggestAdminLevel());
        }
        detail = constraint.properties?.name || '';
      } else if (geom === 'line') {
        constraint = lineCatchment(fc, seekerPt, currentZone);
        detail = nearestLineGroup(seekerPt, fc).group || '';
      } else {
        const clip = clipPointsToZone(fc, currentZone);
        if (!clip.features.length) return setStatus('No such features in the zone.');
        const near = nearest(seekerPt, clip);
        constraint = voronoiCell(clip, near, currentZone);
        detail = near.properties?.name || '';
      }
      if (!constraint) return setStatus('Could not build a catchment area.');

      addClue({
        mode: same ? 'intersect' : 'difference', geometry: constraint, kind: 'nearest',
        label: `Same ${isArea ? 'division' : 'nearest ' + cfg.label}? → ${same ? 'YES' : 'NO'}${detail ? ` (${detail})` : ''}`,
        meta: { feature, geom, detail, adminLevel: isArea ? adminLevel : undefined },
      });
      setStatus('Catchment clue applied.' + dataNote(res));
    } catch (e) { setStatus(e.message); }
    finally { setBusy(false); }
  }

  // ---- Category 2: relative distance (closer/further) ----
  async function relativeQuestion(closer) {
    setBusy(true);
    try {
      if (isElevation) {
        setStatus('Sampling elevations (approximate, may take a few seconds)…');
        const geom = await elevationConstraint(currentZone, seeker, closer);
        if (!geom) return setStatus('Could not build an elevation region (API unavailable or no data).');
        addClue({
          mode: 'intersect', geometry: geom, kind: 'relative',
          label: `${closer ? 'Closer' : 'Further'} to sea level (elevation, approx.)`,
          meta: { feature },
        });
        return setStatus('Elevation clue applied (approximate).');
      }

      setStatus(`Querying ${cfg.label}…`);
      const res = await getData();
      const { geom, fc } = res;
      if (!fc.features.length) return setStatus('No such features in the zone.');

      let buffers = null, ds = null;
      if (geom === 'line') {
        ds = nearestLineGroup(seekerPt, fc).distanceKm;
        if (ds == null) return setStatus('Could not measure distance to a line.');
        buffers = multiBufferLines(fc, ds);
      } else {
        const clip = clipPointsToZone(fc, currentZone);
        if (!clip.features.length) return setStatus('No such features in the zone.');
        const near = nearest(seekerPt, clip);
        ds = distanceKm(seekerPt, near);
        buffers = multiBuffer(clip, ds, seeker);
      }
      if (!buffers) return setStatus('Could not build buffer zones.');

      addClue({
        mode: closer ? 'intersect' : 'difference', geometry: buffers, kind: 'relative',
        label: `${closer ? 'Closer' : 'Further'} to ${cfg.label} (Ds=${ds.toFixed(1)} km)`,
        meta: { feature, geom, ds },
      });
      const extra = res.complete === false && !closer
        ? ' ⚠ partial data on a "further" cut may leave area that should be removed — Refresh & re-ask.'
        : dataNote(res);
      setStatus('Relative-distance clue applied.' + extra);
    } catch (e) { setStatus(e.message); }
    finally { setBusy(false); }
  }

  // ---- Category 5: closest of nearby (points only) ----
  async function loadNearby(forceRefresh = false) {
    setBusy(true);
    try {
      setStatus(`Querying ${cfg.label} within ${(radius / 1000).toFixed(0)} km…`);
      const res = await getData(forceRefresh);
      const within = pointsWithinRadius(res.fc, seeker, radius);
      if (!within.features.length) return setStatus('None within that radius.');
      setNearbyPOIs(within);
      const warn = res.complete === false
        ? ' ⚠ partial data — a candidate may be missing; Refresh to re-pull.'
        : (res.cached === 'idb' ? ' (from saved cache)' : res.cached ? ' (from cache)' : '');
      setStatus(`Pick which ${cfg.label} the hider is closest to.` + warn);
    } catch (e) { setStatus(e.message); }
    finally { setBusy(false); }
  }
  function pickClosest(target) {
    const cell = voronoiCell(nearbyPOIs, target, currentZone);
    if (!cell) return setStatus('Could not isolate that feature’s area.');
    addClue({
      mode: 'intersect', geometry: cell, kind: 'target',
      label: `Closest of nearby ${cfg.label} → ${target.properties?.name}`,
      meta: { feature, name: target.properties?.name },
    });
    setNearbyPOIs(null);
    setStatus('Target-proximity clue applied.');
  }

  const isFeatureCat = category === 'matching' || category === 'measuring' || category === 'tentacles';

  return (
    <div className="ded-console">
      <Section title="Seeker position (origin)">
        <div className="ded-row">
          <Btn variant={mapMode === 'place-seeker' ? 'solid' : 'outline'} size="sm"
            onClick={() => { setMapMode(mapMode === 'place-seeker' ? 'idle' : 'place-seeker'); setStatus('Tap the map to drop the seeker pin.'); }}>
            {mapMode === 'place-seeker' ? 'Tap map…' : 'Place pin'}
          </Btn>
          <Btn variant="outline" size="sm" onClick={useGPS}>Use GPS</Btn>
        </div>
        <div style={{ marginTop: 8 }}>
          <CoordEntry onSet={(p) => { setSeeker(p); setStatus('Pin set from coordinates.'); }} />
        </div>
        <p className="map-hint" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginTop: 6 }}>
          {seeker ? `${seeker.lat.toFixed(3)}, ${seeker.lng.toFixed(3)}` : 'Not set — required for distance/radius questions.'}
        </p>
      </Section>

      {needZone && <p className="ded-warn">Set the game area in the Admin panel to enable questions.</p>}

      {/* Category selector — tap one to reveal its controls */}
      <Section title="Question type">
        <div className="map-modes" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {CATS.map(([key, label, ic]) => (
            <button key={key} className={`map-mode${category === key ? ' is-on' : ''}`} onClick={() => selectCategory(key)}>
              <Icon name={ic} size={15} /> {label}
            </button>
          ))}
        </div>
      </Section>

      {category === 'radius' && (
        <Section title="Radius — within distance?">
          <label className="ded-lbl">Radius (m)</label>
          <input type="number" value={radius} onChange={(e) => setRadius(+e.target.value)} className="ded-in" />
          <div className="preview-choices">
            <button className="prev-btn ded-yes" disabled={needSeeker || needZone} onClick={() => radiusQuestion(true)}>Within: YES</button>
            <button className="prev-btn ded-no" disabled={needSeeker || needZone} onClick={() => radiusQuestion(false)}>NO</button>
          </div>
        </Section>
      )}

      {category === 'thermometer' && (
        <Section title="Thermometer — hotter / colder">
          {!pending?.newPos ? (
            <Btn variant="outline" size="sm" full disabled={needSeeker || needZone} onClick={startHotCold}>
              {mapMode === 'place-hotcold' ? 'Tap new position…' : 'Start (move to new spot)'}
            </Btn>
          ) : (
            <div className="preview-choices">
              <button className="prev-btn ded-no" onClick={() => resolveHotCold(false)}>Colder</button>
              <button className="prev-btn ded-yes" onClick={() => resolveHotCold(true)}>Hotter</button>
            </div>
          )}
        </Section>
      )}

      {category === 'shrink' && (
        <Section title="Manual shrink point">
          <label className="ded-lbl">Radius (m)</label>
          <input type="number" value={shrinkRadius} onChange={(e) => setShrinkRadius(+e.target.value)} className="ded-in" />
          <div className="preview-choices" style={{ marginBottom: 8 }}>
            <button className={`prev-btn${shrinkSafe ? ' is-on' : ''}`} onClick={() => setShrinkSafe(true)}>Safe (keep)</button>
            <button className={`prev-btn${!shrinkSafe ? ' is-on' : ''}`} onClick={() => setShrinkSafe(false)}>Exclude (cut)</button>
          </div>
          <Btn variant="outline" size="sm" full disabled={needZone} onClick={armShrink}>
            {mapMode === 'place-shrink' ? 'Tap map…' : 'Arm & tap map'}
          </Btn>
        </Section>
      )}

      {isFeatureCat && (
        <Section title={category === 'matching' ? 'Matching — nearest feature' : category === 'measuring' ? 'Measuring — closer / further' : 'Tentacles — closest within radius'}>
          <div className="ded-feat-head">
            <label className="ded-lbl" style={{ margin: 0 }}>Feature</label>
            {!isArea && feature !== 'border' && !isElevation && (
              <button className="map-text-btn"
                onClick={() => { invalidateFeature(feature); setNearbyPOIs(null); setStatus(`Cache cleared for ${cfg.label} — next question re-pulls fresh data.`); }}
                title="Discard cached data and re-pull on the next question">↻ Refresh data</button>
            )}
          </div>
          <select value={feature} onChange={(e) => { setFeature(e.target.value); setNearbyPOIs(null); }} className="ded-in ded-sel">
            {featuresForMode(CAT_MODE[category]).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>

          {isArea && (
            <>
              <label className="ded-lbl">Division level</label>
              <select value={adminLevel} onChange={(e) => setAdminLevel(+e.target.value)} className="ded-in ded-sel">
                {ADMIN_LEVELS.map((a) => <option key={a.level} value={a.level}>{a.label}</option>)}
              </select>
              <p className="map-hint" style={{ fontSize: 11 }}>Levels vary by country. UK: 6 ≈ county, 8 ≈ district.</p>
            </>
          )}

          {category === 'matching' && (
            <div className="preview-choices">
              <button className="prev-btn ded-yes" disabled={busy || needSeeker || needZone} onClick={() => nearestQuestion(true)}>Same: YES</button>
              <button className="prev-btn ded-no" disabled={busy || needSeeker || needZone} onClick={() => nearestQuestion(false)}>NO</button>
            </div>
          )}

          {category === 'measuring' && (
            <div className="preview-choices">
              <button className="prev-btn ded-yes" disabled={busy || needSeeker || needZone} onClick={() => relativeQuestion(true)}>Closer</button>
              <button className="prev-btn ded-no" disabled={busy || needSeeker || needZone} onClick={() => relativeQuestion(false)}>Further</button>
            </div>
          )}

          {category === 'tentacles' && (
            <>
              <label className="ded-lbl">Radius (m)</label>
              <input type="number" value={radius} onChange={(e) => setRadius(+e.target.value)} className="ded-in" />
              {!nearbyPOIs ? (
                <Btn variant="outline" size="sm" full disabled={busy || needSeeker || needZone} onClick={() => loadNearby()}>Load candidates</Btn>
              ) : (
                <div className="ded-cand-list">
                  {nearbyPOIs.features.map((f, i) => (
                    <button key={i} className="ded-cand" onClick={() => pickClosest(f)}>{f.properties?.name}</button>
                  ))}
                </div>
              )}
            </>
          )}

          {isLine && feature !== 'border' && (
            <p className="map-hint" style={{ fontSize: 11 }}>Uses distance to the nearest {cfg.label.toLowerCase()} automatically — no radius needed.</p>
          )}
          {feature === 'border' && (
            <p className="map-hint" style={{ fontSize: 11 }}>Borders = outlines of the selected countries (incl. internal borders).</p>
          )}
          {isElevation && (
            <p className="map-hint" style={{ fontSize: 11, color: 'var(--c-time)' }}>Sea level is experimental: a coarse elevation grid via a public API.</p>
          )}
        </Section>
      )}

      {status && <p className="ded-status">{status}</p>}
      {busy && <p className="ded-mini-lbl" style={{ color: 'var(--c-seeker)' }}>Working…</p>}
    </div>
  );
}
