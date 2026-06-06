import { Capacitor, registerPlugin } from "@capacitor/core";
import type { Socket } from "socket.io-client";
import type { LngLat } from "@shared/types";

type NativeLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  time?: number;
};

type NativeLocationError = {
  code?: string;
  message?: string;
};

type BackgroundGeolocationPlugin = {
  addWatcher(
    options: {
      backgroundTitle?: string;
      backgroundMessage?: string;
      requestPermissions?: boolean;
      stale?: boolean;
      distanceFilter?: number;
    },
    callback: (location?: NativeLocation, error?: NativeLocationError) => void
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
};

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");

export function canUseNativeLocation() {
  return Capacitor.isNativePlatform();
}

export async function startNativeLocation(options: {
  socket: Socket;
  gameId: string | null;
  onError: (message: string) => void;
}) {
  const watcherId = await BackgroundGeolocation.addWatcher({
    backgroundTitle: "Urban Hunt location active",
    backgroundMessage: "Your location is being shared for the active hunt.",
    requestPermissions: true,
    stale: false,
    distanceFilter: 5
  }, (location, error) => {
    if (error) {
      options.onError(error.message || error.code || "Native GPS unavailable");
      return;
    }
    if (!location) return;
    const coordinates: LngLat = [location.longitude, location.latitude];
    options.socket.emit("location_update", {
      gameId: options.gameId,
      coordinates,
      accuracy: location.accuracy ?? null,
      timestamp: new Date(location.time || Date.now()).toISOString()
    });
  });

  return async () => {
    await BackgroundGeolocation.removeWatcher({ id: watcherId });
  };
}
