import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const appBasePath = globalThis.process?.env.APP_BASE_PATH || './'

// https://vite.dev/config/
export default defineConfig({
  base: appBasePath,
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/vapid-public-key': 'http://localhost:8080',
      '/push-subscribe':   'http://localhost:8080',
      '/jetlag-api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jetlag-api/, ''),
      },
      '/jetlag-ws': {
        target: 'ws://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
