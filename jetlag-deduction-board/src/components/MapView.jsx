// MapView.jsx
import { useMemo, useEffect } from 'react';
import { MapContainer, TileLayer, GeoJSON, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useStore } from '../lib/store';
import { maskPolygon, circle } from '../lib/geometry';

// Forces Leaflet to recompute its container size. The critical case on mobile:
// the map mounts inside a `display:none` parent (the sidebar is shown first),
// so it measures a zero-size container and requests NO tiles. When the user
// switches to the map view the container gains size, but Leaflet doesn't know
// unless told. A ResizeObserver on the container catches every size change
// (including the hidden→visible transition) and re-measures, which triggers
// tile loading.
function SizeFixer({ visible }) {
  const map = useMap();
  useEffect(() => {
    const fix = () => map.invalidateSize({ animate: false });
    fix();
    const timers = [50, 200, 500, 1000].map((ms) => setTimeout(fix, ms));

    let ro;
    const el = map.getContainer();
    if (typeof ResizeObserver !== 'undefined' && el) {
      ro = new ResizeObserver(() => fix());
      ro.observe(el);
      // Observe the parent too — its display toggle is what changes our size.
      if (el.parentElement) ro.observe(el.parentElement);
    }
    window.addEventListener('resize', fix);
    window.addEventListener('orientationchange', fix);
    return () => {
      timers.forEach(clearTimeout);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', fix);
      window.removeEventListener('orientationchange', fix);
    };
  }, [map]);

  // Re-measure whenever the map becomes visible (mobile panel↔map toggle).
  useEffect(() => {
    if (!visible) return;
    const fix = () => map.invalidateSize({ animate: false });
    const timers = [0, 60, 200, 500].map((ms) => setTimeout(fix, ms));
    return () => timers.forEach(clearTimeout);
  }, [visible, map]);

  return null;
}

// Custom divIcon avoids the well-known broken-marker-image issue with bundlers.
const seekerIcon = L.divIcon({
  className: '',
  html: `<div style="
      width:18px;height:18px;border-radius:50%;
      background:#38bdf8;border:3px solid #fff;
      box-shadow:0 0 0 2px #0284c7, 0 1px 6px rgba(0,0,0,.5)"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function ClickHandler() {
  const { mapMode, setSeeker, setMapMode, setStatus, pending, setPending, addClue, currentZone } =
    useStore();

  useMapEvents({
    click(e) {
      const point = { lat: e.latlng.lat, lng: e.latlng.lng };

      if (mapMode === 'place-seeker') {
        setSeeker(point);
        setMapMode('idle');
        setStatus('Seeker placed.');
      } else if (mapMode === 'place-shrink' && pending) {
        // Manual shrink: drop a circle at the click point.
        const geom = circle(point, pending.radius);
        addClue({
          mode: pending.safe ? 'intersect' : 'difference',
          geometry: geom,
          kind: 'shrink',
          label: `${pending.safe ? 'Safe zone' : 'Exclusion'} • ${(pending.radius / 1000).toFixed(1)} km circle`,
          meta: { center: point, radius: pending.radius },
        });
        setPending(null);
        setMapMode('idle');
        setStatus('Shrink applied.');
      } else if (mapMode === 'place-hotcold' && pending) {
        // Second point of hotter/colder: pending.old is the previous seeker pos.
        setPending({ ...pending, newPos: point });
        setMapMode('idle');
        setStatus('New position set — choose hotter or colder.');
      }
    },
  });
  return null;
}

const ZONE_STYLE = { color: '#22d3ee', weight: 2, fillColor: '#22d3ee', fillOpacity: 0.06 };
const MASK_STYLE = { stroke: false, fillColor: '#020617', fillOpacity: 0.62, interactive: false };
const BORDER_STYLE = { color: '#7dd3fc', weight: 1, fill: false, dashArray: '3 4', interactive: false };

export default function MapView({ visible = true }) {
  const { currentZone, baseZone, seeker, countries, selectedIds } = useStore();

  // Build the mask AND a remount key together, only when the zone changes.
  // react-leaflet's GeoJSON doesn't diff its `data` prop, so the key must change
  // when the mask does. Previously the key did `JSON.stringify(mask).length` on
  // every render of this component (which re-renders on any store change, e.g.
  // status text or seeker moves) — serializing the whole zone each time. Doing it
  // in the memo runs it once per actual zone change instead.
  const { mask, maskKey } = useMemo(() => {
    const m = currentZone ? maskPolygon(currentZone) : null;
    return { mask: m, maskKey: m ? 'mask-' + JSON.stringify(m).length : 'mask-none' };
  }, [currentZone]);

  const selectedBorders = useMemo(
    () => countries.filter((c) => selectedIds.includes(c.id)).map((c) => c.feature),
    [countries, selectedIds]
  );

  return (
    <MapContainer
      center={[46.8, 8.2]}
      zoom={5}
      className="h-full w-full"
      style={{ height: '100%', width: '100%', minHeight: '100%' }}
      worldCopyJump
    >
      <TileLayer
        url="https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png"
        attribution='&copy; OpenStreetMap &copy; CARTO'
        tileSize={256}
        detectRetina={false}
        keepBuffer={2}
        updateWhenIdle={true}
        updateWhenZooming={false}
        maxZoom={19}
        eventHandlers={{
          tileerror: (e) => {
            const img = e.tile;
            if (!img) return;
            const tries = Number(img.dataset.retry || '0');
            if (tries >= 2) return;
            img.dataset.retry = String(tries + 1);
            const src = img.src;
            setTimeout(() => { img.src = ''; img.src = src; }, 500 * (tries + 1));
          },
        }}
      />

      {/* Dark mask over everything outside the playable zone. Keyed so it
          remounts (react-leaflet GeoJSON does not diff prop data). */}
      {mask && <GeoJSON key={maskKey} data={mask} style={MASK_STYLE} />}

      {/* Selected country borders */}
      {selectedBorders.map((f, i) => (
        <GeoJSON key={'b-' + i + selectedIds.join()} data={f} style={BORDER_STYLE} />
      ))}

      {/* The live playable zone outline */}
      {currentZone && (
        <GeoJSON key={'zone-' + JSON.stringify(currentZone).length} data={currentZone} style={ZONE_STYLE} />
      )}

      {seeker && <Marker position={[seeker.lat, seeker.lng]} icon={seekerIcon} />}

      <ClickHandler />
      <SizeFixer visible={visible} />
    </MapContainer>
  );
}
