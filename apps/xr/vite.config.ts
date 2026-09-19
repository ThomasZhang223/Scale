import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    server: {
      host: true,
      port: 5173,
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
