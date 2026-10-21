import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, the browser talks to Vite on :5173 and Vite forwards /api to the gateway.
// Same origin means the httpOnly refresh cookie just works — no CORS dance.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.GATEWAY_URL ?? 'http://localhost:8080', changeOrigin: true },
    },
  },
});
