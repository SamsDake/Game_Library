import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const target = "http://127.0.0.1:3000";
const appBasePath = globalThis.process?.env.APP_BASE_PATH || "/";

// Proxy entry with an error handler so transient upstream resets (server still
// starting, Socket.IO reconnects/upgrades) don't crash the dev server with an
// unhandled 'error' event.
function proxyTarget(ws = false) {
  return {
    target,
    changeOrigin: true,
    ws,
    configure: (proxy: { on: (event: string, cb: (err: Error) => void) => void }) => {
      proxy.on("error", (err: Error) => console.warn("[vite proxy]", err.message));
    }
  };
}

export default defineConfig({
  root: clientDir,
  base: appBasePath,
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(clientDir, "../shared")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/socket.io": proxyTarget(true),
      "/api": proxyTarget(),
      "/uploads": proxyTarget()
    }
  }
});
