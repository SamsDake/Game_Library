import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.urbanhunt.app",
  appName: "Urban Hunt",
  webDir: "client/dist",
  server: {
    androidScheme: "https"
  },
  android: {
    // Required by @capacitor-community/background-geolocation to keep Android
    // background updates alive beyond the WebView bridge throttle window.
    useLegacyBridge: true
  }
};

export default config;
