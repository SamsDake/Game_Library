import { Capacitor } from "@capacitor/core";
import { registerPlugin } from "@capacitor/core";
import type { BackgroundGeolocationPlugin } from "@capacitor-community/background-geolocation";
import type { Socket } from "socket.io-client";
import type { LngLat } from "@shared/types";

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");

export function canUseNativeLocation() {
  return Capacitor.isNativePlatform();
}

export async function startNativeLocation(options: {
  socket: Socket;
  gameId: string | null;
  onError: (message: string) => void;
}) {
  const watcherId = await BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: "Urban Hunt GPS active",
      backgroundMessage: "Urban Hunt is sharing your live game location.",
      requestPermissions: true,
      stale: false,
      distanceFilter: 5
    },
    (position, err) => {
      if (err) {
        options.onError(err.message || "GPS error");
        return;
      }
      if (!position) return;
      const coordinates: LngLat = [position.longitude, position.latitude];
      options.socket.emit("location_update", {
        gameId: options.gameId,
        coordinates,
        accuracy: position.accuracy ?? null,
        timestamp: new Date(position.time || Date.now()).toISOString()
      });
    }
  );

  return async () => {
    await BackgroundGeolocation.removeWatcher({ id: watcherId });
  };
}
