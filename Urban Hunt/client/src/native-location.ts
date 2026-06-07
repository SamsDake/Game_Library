import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import type { Socket } from "socket.io-client";
import type { LngLat } from "@shared/types";

export function canUseNativeLocation() {
  return Capacitor.isNativePlatform();
}

export async function startNativeLocation(options: {
  socket: Socket;
  gameId: string | null;
  onError: (message: string) => void;
}) {
  await Geolocation.requestPermissions();

  const watcherId = await Geolocation.watchPosition(
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    (position, err) => {
      if (err) {
        options.onError(err.message || "GPS error");
        return;
      }
      if (!position) return;
      const coordinates: LngLat = [position.coords.longitude, position.coords.latitude];
      options.socket.emit("location_update", {
        gameId: options.gameId,
        coordinates,
        accuracy: position.coords.accuracy ?? null,
        timestamp: new Date(position.timestamp).toISOString()
      });
    }
  );

  return async () => {
    await Geolocation.clearWatch({ id: watcherId });
  };
}
