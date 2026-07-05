import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hideandseek.app",
  appName: "Hide and Seek Companion",
  webDir: "client/dist",
  server: {
    androidScheme: "https"
  }
};

export default config;
