import { Geolocation } from "@capacitor/geolocation";
import type { LngLat } from "@shared/types";

// One-shot location read used only at proof-submit time (no continuous/background tracking).
export async function getCurrentCoordinates(): Promise<LngLat> {
  await Geolocation.requestPermissions();
  const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
  return [position.coords.longitude, position.coords.latitude];
}
