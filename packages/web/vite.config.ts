import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Cible du proxy dev (backend Fastify). Défaut : le service local en HTTPS sur 8080
 * (./server.sh — cert auto-signé, d'où `secure: false` ci-dessous).
 * Pour pointer vers un autre backend sans modifier ce fichier (ex. mock) :
 *   VITE_API_PROXY=http://localhost:9088 VITE_WS_PROXY=ws://localhost:9088 pnpm dev
 */
const apiTarget = process.env.VITE_API_PROXY ?? 'https://localhost:8080';
const wsTarget = process.env.VITE_WS_PROXY ?? 'wss://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // secure: false → accepte le certificat auto-signé du service local (HTTPS).
      '/api': { target: apiTarget, secure: false },
      '/ws': { target: wsTarget, ws: true, secure: false },
    },
  },
});
