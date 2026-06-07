import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.jetlagmobileapp.app",
  appName: "Jetlag",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
