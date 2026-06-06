// QuestionPanel.jsx
// The Seeker's deduction console. Every control ends by calling
// store.addClue({ mode, geometry, label, ... }). Feature questions branch on
// the feature's geom kind (point / line / area) and the question types it
// supports are declared per-feature in FEATURES[...].modes.

import { useState } from 'react';
import { useStore } from '../lib/store';
import {
  circle, bisectorHalfPlane, multiBuffer, multiBufferLines, voronoiCell,
  lineCatchment, nearestLineGroup, containingPolygon, linesFromPolygons,
  mainCluster, nearest, distanceKm, bboxOf, pt,
} from '../lib/geometry';
import { fetchFeature, clipPointsToZone, pointsWithinRadius, FEATURES, ADMIN_LEVELS, invalidateFeature } from '../lib/overpass';
import { elevationConstraint } from '../lib/elevation';

function Section({ title, children }) {
  return (
    <div className="rounded-xl bg-slate-800/40 p-3 ring-1 ring-slate-800">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-300">{title}</h4>
      {children}
    </div>
  );
}

const btn = 'rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-40';
const primary = `${btn} bg-cyan-500 text-slate-900 hover:bg-cyan-400`;
const ghost = `${btn} bg-slate-700 text-slate-100 hover:bg-slate-600`;
const yes = `${btn} bg-emerald-500/90 text-slate-900 hover:bg-emerald-400`;
const no = `${btn} bg-rose-500/90 text-white hover:bg-rose-400`;

export default function QuestionPanel() {
  const {
    seeker, setSeeker, mapMode, setMapMode, setStatus, status,
    currentZone, baseZone, addClue, pending, setPending, countries, selectedIds,
  } = useStore();

  const [radius, setRadius] = useState(50000);
  const [shrinkRadius, setShrinkRadius] = useState(50000);
  const [shrinkSafe, setShrinkSafe] = useState(true);
  const [feature, setFeature] = useState('airport');
  const [adminLevel, setAdminLevel] = useState(6);
  const [busy, setBusy] = useState(false);
  const [nearbyPOIs, setNearbyPOIs] = useState(null);

  const cfg = FEATURES[feature];
  const modes = cfg.modes || ['nearest', 'relative', 'target'];
  const isLine = cfg.geom === 'line';
  const isArea = cfg.geom === 'area';
  const isElevation = cfg.special === 'elevation';
  const needSeeker = !seeker;
  const needZone = !currentZone;
  const seekerPt = seeker ? pt(seeker.lng, seeker.lat) : null;

  function useGPS() {
    if (!navigator.geolocation) return setStatus('Geolocation not supported.');
    setStatus('Locating…');
    navigator.geolocation.getCurrentPosition(
      (p) => { setSeeker({ lat: p.coords.latitude, lng: p.coords.longitude }); setStatus('Located via GPS.'); },
      () => setStatus('Could not get GPS fix.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
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
    setStatus('Click your NEW position on the map.');
  }
  function resolveHotCold(hotter) {
    addClue({
      mode: 'intersect',
      geometry: bisectorHalfPlane(pending.old, pending.newPos, hotter ? 'new' : 'old'),
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
    setStatus('Click the map to drop the shrink circle.');
  }

  // Resolve feature data: Overpass for most, local geometry for borders.
  // `forceRefresh` invalidates any cached entry first so seekers can re-pull.
  // IMPORTANT: we query against the STABLE base-zone bbox (the selected
  // countries), NOT the shrinking currentZone. If we keyed on currentZone the
  // bbox would change after every clue, so the cache key would never repeat and
  // every question would re-download. Fetching the base area once per feature
  // means subsequent questions are cache hits; the features are then clipped to
  // currentZone locally (fast Turf ops), no network needed.
  async function getData(forceRefresh = false) {
    if (feature === 'border') {
      const feats = countries.filter((c) => selectedIds.includes(c.id)).map((c) => mainCluster(c.feature));
      return { geom: 'line', fc: linesFromPolygons(feats), complete: true, cached: false };
    }
    if (forceRefresh) invalidateFeature(feature);
    const fetchBbox = bboxOf(baseZone || currentZone);
    return fetchFeature(feature, fetchBbox, { adminLevel });
  }

  // Status suffix that warns when data was partial (truncated/empty) so seekers
  // know the clue may be based on incomplete data and can refresh + re-ask.
  function dataNote(res) {
    if (res.complete === false) return ' ⚠ partial data (not cached — Refresh & re-ask for full coverage)';
    if (res.cached === 'preload') return ' (preloaded — instant)';
    if (res.cached === 'idb') return ' (from saved cache)';
    if (res.cached === 'memory') return ' (from cache)';
    return '';
  }

  // When the seeker isn't inside any division at the chosen admin level, probe
  // the OTHER level(s) to see which one actually covers this spot, and suggest it.
  // Common case: capital city-states (Berlin/Brussels) and Luxembourg, which lack
  // a polygon at one level but have one at the other. Admin data is preloaded so
  // these probes are instant. Returns a guidance string for the status line.
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
      // Sea level uses an elevation grid; the returned region IS the valid area.
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
      // "Further" subtracts area, so missing instances are unsafe (they leave
      // valid-looking zone that should have been cut). Flag that explicitly.
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
    if (!cell) return setStatus('Could not isolate that feature\u2019s area.');
    addClue({
      mode: 'intersect', geometry: cell, kind: 'target',
      label: `Closest of nearby ${cfg.label} → ${target.properties?.name}`,
      meta: { feature, name: target.properties?.name },
    });
    setNearbyPOIs(null);
    setStatus('Target-proximity clue applied.');
  }

  return (
    <div className="space-y-3">
      <Section title="Seeker position (origin)">
        <div className="flex flex-wrap gap-2">
          <button className={mapMode === 'place-seeker' ? primary : ghost}
            onClick={() => { setMapMode(mapMode === 'place-seeker' ? 'idle' : 'place-seeker'); setStatus('Click the map to drop the seeker pin.'); }}>
            {mapMode === 'place-seeker' ? 'Click map…' : 'Place pin'}
          </button>
          <button className={ghost} onClick={useGPS}>Use GPS</button>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          {seeker ? `${seeker.lat.toFixed(3)}, ${seeker.lng.toFixed(3)}` : 'Not set — required for distance/radius questions.'}
        </p>
      </Section>

      {needZone && <p className="text-xs text-amber-400">Select at least one country to enable questions.</p>}

      <Section title="① Radius proximity">
        <label className="mb-1 block text-xs text-slate-400">Radius (m)</label>
        <input type="number" value={radius} onChange={(e) => setRadius(+e.target.value)}
          className="mb-2 w-full rounded-lg bg-slate-900 px-2 py-1 text-sm ring-1 ring-slate-700" />
        <div className="flex gap-2">
          <button className={yes} disabled={needSeeker || needZone} onClick={() => radiusQuestion(true)}>Within: YES</button>
          <button className={no} disabled={needSeeker || needZone} onClick={() => radiusQuestion(false)}>NO</button>
        </div>
      </Section>

      <Section title="② Hotter / colder">
        {!pending?.newPos ? (
          <button className={primary} disabled={needSeeker || needZone} onClick={startHotCold}>
            {mapMode === 'place-hotcold' ? 'Click new position…' : 'Start (move to new spot)'}
          </button>
        ) : (
          <div className="flex gap-2">
            <button className={no} onClick={() => resolveHotCold(false)}>Colder</button>
            <button className={yes} onClick={() => resolveHotCold(true)}>Hotter</button>
          </div>
        )}
      </Section>

      <Section title="③ Manual shrink point">
        <label className="mb-1 block text-xs text-slate-400">Radius (m)</label>
        <input type="number" value={shrinkRadius} onChange={(e) => setShrinkRadius(+e.target.value)}
          className="mb-2 w-full rounded-lg bg-slate-900 px-2 py-1 text-sm ring-1 ring-slate-700" />
        <div className="mb-2 flex gap-2 text-xs">
          <button onClick={() => setShrinkSafe(true)} className={shrinkSafe ? primary : ghost}>Safe (keep inside)</button>
          <button onClick={() => setShrinkSafe(false)} className={!shrinkSafe ? primary : ghost}>Exclude (cut out)</button>
        </div>
        <button className={ghost} disabled={needZone} onClick={armShrink}>
          {mapMode === 'place-shrink' ? 'Click map…' : 'Arm & click map'}
        </button>
      </Section>

      <Section title="④ Feature questions">
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs text-slate-400">Feature</label>
          {!isArea && feature !== 'border' && !isElevation && (
            <button
              onClick={() => { invalidateFeature(feature); setNearbyPOIs(null); setStatus(`Cache cleared for ${cfg.label} — next question re-pulls fresh data.`); }}
              className="rounded-md px-2 py-0.5 text-[11px] text-cyan-300 hover:bg-cyan-500/15"
              title="Discard cached data and re-pull on the next question"
            >
              ↻ Refresh data
            </button>
          )}
        </div>
        <select value={feature} onChange={(e) => { setFeature(e.target.value); setNearbyPOIs(null); }}
          className="mb-3 w-full rounded-lg bg-slate-900 px-2 py-1.5 text-sm ring-1 ring-slate-700">
          {Object.entries(FEATURES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>

        {isArea && (
          <>
            <label className="mb-1 block text-xs text-slate-400">Division level</label>
            <select value={adminLevel} onChange={(e) => setAdminLevel(+e.target.value)}
              className="mb-3 w-full rounded-lg bg-slate-900 px-2 py-1.5 text-sm ring-1 ring-slate-700">
              {ADMIN_LEVELS.map((a) => <option key={a.level} value={a.level}>{a.label}</option>)}
            </select>
            <p className="mb-2 text-[11px] text-slate-500">Levels vary by country. UK: 6 ≈ county, 8 ≈ district, 10 ≈ parish.</p>
          </>
        )}

        {modes.includes('nearest') && (
          <>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">{isArea ? 'Same division?' : 'Nearest feature comparison'}</p>
            <div className="mb-3 flex gap-2">
              <button className={yes} disabled={busy || needSeeker || needZone} onClick={() => nearestQuestion(true)}>Same: YES</button>
              <button className={no} disabled={busy || needSeeker || needZone} onClick={() => nearestQuestion(false)}>NO</button>
            </div>
          </>
        )}

        {modes.includes('relative') && (
          <>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Relative distance</p>
            <div className="mb-3 flex gap-2">
              <button className={yes} disabled={busy || needSeeker || needZone} onClick={() => relativeQuestion(true)}>Closer</button>
              <button className={no} disabled={busy || needSeeker || needZone} onClick={() => relativeQuestion(false)}>Further</button>
            </div>
          </>
        )}

        {modes.includes('target') && (
          <>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Closest of nearby (within radius above)</p>
            {!nearbyPOIs ? (
              <button className={ghost} disabled={busy || needSeeker || needZone} onClick={loadNearby}>Load candidates</button>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {nearbyPOIs.features.map((f, i) => (
                  <button key={i} onClick={() => pickClosest(f)}
                    className="block w-full truncate rounded-md bg-slate-700 px-2 py-1 text-left text-xs hover:bg-slate-600">
                    {f.properties?.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {isLine && feature !== 'border' && (
          <p className="text-[11px] text-slate-500">Uses distance to the nearest {cfg.label.toLowerCase()} automatically — no radius needed.</p>
        )}
        {feature === 'border' && (
          <p className="text-[11px] text-slate-500">Borders = outlines of the selected countries (incl. internal borders).</p>
        )}
        {isElevation && (
          <p className="text-[11px] text-amber-400/80">Sea level is experimental: a coarse elevation grid via a public API.</p>
        )}
      </Section>

      {status && <p className="rounded-lg bg-slate-800/60 px-3 py-2 text-xs text-slate-300">{status}</p>}
      {busy && <p className="text-xs text-cyan-300">Working…</p>}
    </div>
  );
}
