import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    // Both of these exist for the cloudflared quick tunnel (infra/README.md), which is also
    // what supplies the HTTPS that WebXR's secure-context requirement needs.
    //
    // The tunnel hostname is random on every restart (*.trycloudflare.com), so a fixed
    // allowlist can never match it, and Vite rejects an unrecognised Host header — the page
    // simply never loads.
    allowedHosts: true,
    // Without this the browser opens the hot-reload websocket on 5173, which the tunnel never
    // publishes: it forwards only the one port it was given. The page loads once and then
    // never updates. wss/443 rides the same tunnel connection as the page itself.
    hmr: { protocol: 'wss', clientPort: 443 },
    fs: { allow: ['../..'] }, // fixtures/ lives at the repo root, outside this app
  },
});
