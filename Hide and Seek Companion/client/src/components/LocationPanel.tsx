import { useState } from "react";
import { Geolocation } from "@capacitor/geolocation";
import type { LngLat } from "@shared/types";
import { googleMapsUrl } from "../format";

export function LocationPanel({ onLocationChange }: { onLocationChange: (location: LngLat) => void }) {
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [error, setError] = useState("");

  async function updateLocation() {
    setLoading(true);
    setError("");
    try {
      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
      const { latitude, longitude, accuracy } = position.coords;
      setCoords({ lat: latitude, lng: longitude, accuracy });
      onLocationChange([longitude, latitude]);
    } catch {
      setError("Could not get your location. Check location permissions.");
    } finally {
      setLoading(false);
    }
  }

  return <div className="location-panel">
    <button className="btn btn-ghost" disabled={loading} onClick={() => void updateLocation()}>
      {loading ? "Locating…" : "Update Location"}
    </button>
    {coords && <div className="location-readout mono">
      <span>{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)} &middot; &plusmn;{Math.round(coords.accuracy)}m</span>
      <a href={googleMapsUrl([coords.lng, coords.lat])} target="_blank" rel="noreferrer">Maps</a>
    </div>}
    {error && <div className="notice">{error}</div>}
  </div>;
}
