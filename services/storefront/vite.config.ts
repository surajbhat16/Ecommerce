import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA is served as static files by nginx in the container; all API calls go
// to same-origin /api/* which Traefik routes to the gateway. No dev proxy needed
// in prod, but for local `vite dev` we proxy /api to the running gateway.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'https://api.localhost', changeOrigin: true, secure: false },
    },
  },
  build: { outDir: 'dist' },
});
