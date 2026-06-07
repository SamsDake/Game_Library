import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.urbanhunt.app",
  appName: "Urban Hunt",
  webDir: "client/dist",
  server: {
    androidScheme: "https"
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "banner", "list"]
    }
  }
};

export default config;
