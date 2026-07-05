import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LngLat, Objective, SeekerRouteProgress } from "@shared/types";

const DARK_TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const ATTRIB = "&copy; OpenStreetMap contributors &copy; CARTO";

type AdminProps = {
  mode: "admin";
  center: LngLat;
  radiusM: number;
  onCenterChange: (center: LngLat) => void;
};
type HiderProps = { mode: "hider"; objective: Objective | null };
type SeekerProps = {
  mode: "seeker";
  route: Objective[];
  progress: SeekerRouteProgress[];
  focusOn?: LngLat | null;
};
type Props = AdminProps | HiderProps | SeekerProps;

export function GameMap(props: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!ref.current) return;
    const map = L.map(ref.current, { zoomControl: false });
    mapRef.current = map;
    L.tileLayer(DARK_TILES, { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Redraw only when the drawable content actually changes (not on every parent re-render, which
  // would happen ~1x/sec from the timer) so a marker drag-in-progress isn't torn down mid-gesture.
  const signature = drawSignature(props);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const current = propsRef.current;

    if (current.mode === "admin") {
      map.setView([current.center[1], current.center[0]], map.getZoom() || 13);
      const icon = L.divIcon({ className: "", html: '<div class="pin pin-center"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
      const marker = L.marker([current.center[1], current.center[0]], { draggable: true, icon }).addTo(map);
      const circle = L.circle([current.center[1], current.center[0]], {
        radius: current.radiusM, color: "#2fd4a5", fillColor: "#2fd4a5", fillOpacity: 0.12, weight: 2
      }).addTo(map);
      marker.on("drag", e => circle.setLatLng((e.target as L.Marker).getLatLng()));
      marker.on("dragend", e => {
        const p = (e.target as L.Marker).getLatLng();
        const latest = propsRef.current;
        if (latest.mode === "admin") latest.onCenterChange([p.lng, p.lat]);
      });
      const clickHandler = (e: L.LeafletMouseEvent) => {
        marker.setLatLng(e.latlng);
        circle.setLatLng(e.latlng);
        const latest = propsRef.current;
        if (latest.mode === "admin") latest.onCenterChange([e.latlng.lng, e.latlng.lat]);
      };
      map.on("click", clickHandler);
      setTimeout(() => map.invalidateSize(), 200);
      return () => {
        map.off("click", clickHandler);
        marker.remove();
        circle.remove();
      };
    }

    if (current.mode === "hider") {
      const layer = L.layerGroup().addTo(map);
      if (current.objective) {
        const icon = L.divIcon({ className: "", html: '<div class="pin pin-current">1</div>', iconSize: [34, 34], iconAnchor: [17, 17] });
        L.marker([current.objective.coordinates[1], current.objective.coordinates[0]], { icon }).addTo(layer);
        map.setView([current.objective.coordinates[1], current.objective.coordinates[0]], 15);
      }
      setTimeout(() => map.invalidateSize(), 200);
      return () => layer.remove();
    }

    if (current.mode === "seeker") {
      const layer = L.layerGroup().addTo(map);
      const latlngs = current.route.map(o => [o.coordinates[1], o.coordinates[0]] as [number, number]);
      if (latlngs.length) L.polyline(latlngs, { color: "rgba(245,243,239,0.35)", weight: 2, dashArray: "4,6" }).addTo(layer);
      current.route.forEach((o, i) => {
        const status = current.progress[i]?.status || "upcoming";
        const html = status === "completed" ? '<div class="pin pin-done">&#10003;</div>' : `<div class="pin pin-${status === "in_progress" ? "current" : "upcoming"}">${i + 1}</div>`;
        const icon = L.divIcon({ className: "", html, iconSize: [34, 34], iconAnchor: [17, 17] });
        L.marker([o.coordinates[1], o.coordinates[0]], { icon }).addTo(layer)
          .on("click", () => map.flyTo([o.coordinates[1], o.coordinates[0]], 16));
      });
      if (latlngs.length) map.fitBounds(latlngs, { padding: [40, 40] });
      setTimeout(() => map.invalidateSize(), 200);
      return () => layer.remove();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.mode !== "seeker" || !props.focusOn) return;
    map.flyTo([props.focusOn[1], props.focusOn[0]], 16);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode === "seeker" ? props.focusOn : null]);

  return <div ref={ref} className="map-box" />;
}

function drawSignature(props: Props): string {
  if (props.mode === "admin") return JSON.stringify(["admin", props.center, props.radiusM]);
  if (props.mode === "hider") return JSON.stringify(["hider", props.objective?.id, props.objective?.coordinates]);
  return JSON.stringify(["seeker", props.route.map(o => o.id), props.progress.map(p => p.status)]);
}
