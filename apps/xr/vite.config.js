import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Cloudflare quick tunnel supplies HTTPS now (see infra/README.md), so this needs no
// mkcert setup for WebXR's secure-context requirement — that was the previous ceiling here.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // The quick-tunnel hostname is random on every restart (*.trycloudflare.com), so a
    // fixed allowlist can never match it. Vite rejects an unrecognised Host header
    // otherwise, and the page never loads.
    allowedHosts: true,
    hmr: {
      // Without this, the browser opens the hot-reload websocket on 5173, which the tunnel
      // never publishes (it forwards only the one port it was given). The page loads once
      // and then never updates. wss/443 rides the same tunnel connection as the page itself.
      protocol: 'wss',
      clientPort: 443,
    },
  },
});
