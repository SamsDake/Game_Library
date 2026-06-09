import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appBasePath = globalThis.process?.env.APP_BASE_PATH || './';

export default defineConfig({
  base: appBasePath,
  plugins: [react()],
  server: {
    proxy: {
      '/deduction-sync': {
        target: 'ws://localhost:3001',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/deduction-sync/, ''),
      },
    },
  },
});
