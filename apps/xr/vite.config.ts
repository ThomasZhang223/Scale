import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
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
      // Thomas's Worker (`wrangler dev`) sends no CORS headers, so /v1 is proxied to it and the
      // browser only ever talks to this origin. Works on the Quest too, via adb reverse.
      proxy: {
        // The designer agent is its own Worker (services/agent); longer prefix first.
        '/v1/agent': env.VITE_AGENT_PROXY ?? 'http://127.0.0.1:8789',
        '/v1': env.VITE_API_PROXY ?? 'http://127.0.0.1:8787',
      },
    },
  };
});
