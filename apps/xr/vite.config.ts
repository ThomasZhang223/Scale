import { defineConfig, loadEnv, type Plugin } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // loadEnv only exposes the prefixes you name; the ElevenLabs values are deliberately NOT
  // VITE_ so they can never be baked into the page bundle. They are read here, server-side.
  const eleven = loadEnv(mode, process.cwd(), 'ELEVENLABS_');
  const elevenKey = eleven.ELEVENLABS_API_KEY?.trim() ?? '';
  // Same premade voice as wrangler.toml [vars], so the key alone is enough on a laptop.
  const elevenVoice = eleven.ELEVENLABS_VOICE_ID?.trim() || 'JBFqnCBsd6RMkjVDRZzb';

  // Dev-only stand-in for the /v1/voice routes worker/index.ts serves in production. It answers
  // the same 501 JSON when unconfigured instead of forwarding a request that will only 401.
  const voiceGuard: Plugin = {
    name: 'full-scale-voice-guard',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/v1/voice')) return next();
        const missing = !elevenKey
          ? 'ELEVENLABS_API_KEY is not set: add it to apps/xr/.env (dev) or wrangler secret put ELEVENLABS_API_KEY (deploy)'
          : req.url.startsWith('/v1/voice/tts') && !elevenVoice
            ? 'ELEVENLABS_VOICE_ID is not set: add it to apps/xr/.env (dev) or wrangler.toml [vars] (deploy)'
            : null;
        if (!missing) return next();
        res.statusCode = 501;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ error: missing }));
      });
    },
  };

  return {
    plugins: [voiceGuard],
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
        // Voice goes straight to ElevenLabs from the dev server, key attached here. Longest
        // prefix first. The proxy cannot rewrite a multipart or JSON body, so src/voice.ts
        // itself sends model_id on both routes; in production worker/index.ts does the same job.
        '/v1/voice': {
          target: 'https://api.elevenlabs.io',
          changeOrigin: true,
          rewrite: (path) =>
            path.startsWith('/v1/voice/stt')
              ? '/v1/speech-to-text'
              : path.startsWith('/v1/voice/tts')
                ? `/v1/text-to-speech/${encodeURIComponent(elevenVoice)}?output_format=mp3_44100_64`
                : path,
          configure(proxy) {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('xi-api-key', elevenKey);
              proxyReq.removeHeader('cookie');
            });
          },
        },
        // The designer agent is its own Worker (services/agent); longer prefix first.
        '/v1/agent': env.VITE_AGENT_PROXY ?? 'http://127.0.0.1:8789',
        // changeOrigin so an https workers.dev target (used when no local stub is running)
        // sees its own hostname rather than localhost:5173, which Cloudflare would refuse.
        '/v1': { target: env.VITE_API_PROXY ?? 'http://127.0.0.1:8787', changeOrigin: true },
      },
    },
  };
});
