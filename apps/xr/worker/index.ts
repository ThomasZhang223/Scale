/*
 * The Worker half of the deployed WebXR page (wrangler.toml). Everything that is not /v1 is a
 * static asset from dist/ and never reaches this code (`run_worker_first = ["/v1/*"]`).
 *
 * /v1/voice/*  → handled HERE: ElevenLabs speech-to-text / text-to-speech, key stays server-side
 * /v1/agent/*  → AGENT_ORIGIN (services/agent), or API_ORIGIN when AGENT_ORIGIN is empty
 * /v1/*        → API_ORIGIN   (Thomas's Worker, the one front door)
 *
 * Same rule the Vite dev proxy applies (vite.config.ts): longer prefix first. The request is
 * forwarded as-is — method, headers (X-Stub included), body — and the upstream response is
 * returned as-is, so SSE (GET /v1/sync/{roomId}, the agent's event stream) streams through.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API_ORIGIN: string;
  AGENT_ORIGIN: string;
  /** Secret: `wrangler secret put ELEVENLABS_API_KEY`. Never a [vars] entry, never in the page. */
  ELEVENLABS_API_KEY?: string;
  /** [vars] in wrangler.toml. */
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_TTS_MODEL?: string;
}

const ELEVENLABS = 'https://api.elevenlabs.io';
// Safety net only: src/voice.ts always sends model_id itself. scribe_v1 is deprecated upstream.
const STT_MODEL = 'scribe_v2';
// Used when neither ELEVENLABS_TTS_MODEL nor the client's model_id is set. Turbo is deprecated.
const TTS_MODEL = 'eleven_flash_v2_5';
const TTS_OUTPUT_FORMAT = 'mp3_44100_64';

function originFor(pathname: string, env: Env): string {
  const agent = env.AGENT_ORIGIN.trim();
  if (pathname.startsWith('/v1/agent') && agent) return agent;
  if (!env.API_ORIGIN) throw new Error('API_ORIGIN is not set (apps/xr/wrangler.toml [vars])');
  return env.API_ORIGIN;
}

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
}

/** POST /v1/voice/stt (multipart: file, model_id?) → { text }
 *  POST /v1/voice/tts ({ text, model_id? })         → audio/mpeg bytes
 *  Anything unconfigured is a 501 that says exactly what to set; never a silent fallback. */
async function voice(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail(405, `${url.pathname} takes POST only`);
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) return fail(501, 'ELEVENLABS_API_KEY is not set: wrangler secret put ELEVENLABS_API_KEY (apps/xr)');

  if (url.pathname === '/v1/voice/stt') {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, 'stt: body must be multipart/form-data with a "file" field');
    }
    if (!form.has('file')) return fail(400, 'stt: multipart field "file" (the recording) is missing');
    if (!form.has('model_id')) form.append('model_id', STT_MODEL); // ElevenLabs requires it
    const up = await fetch(`${ELEVENLABS}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
    });
    if (!up.ok) return fail(up.status, `elevenlabs stt ${up.status}: ${(await up.text()).slice(0, 500)}`);
    const data = (await up.json()) as { text?: unknown };
    if (typeof data.text !== 'string') return fail(502, 'elevenlabs stt: response has no "text" field');
    return Response.json({ text: data.text }, { headers: { 'cache-control': 'no-store' } });
  }

  if (url.pathname === '/v1/voice/tts') {
    const voiceId = env.ELEVENLABS_VOICE_ID?.trim();
    if (!voiceId) return fail(501, 'ELEVENLABS_VOICE_ID is not set (apps/xr/wrangler.toml [vars])');
    let body: { text?: unknown; model_id?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return fail(400, 'tts: body must be JSON { text }');
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return fail(400, 'tts: "text" is empty');
    const model_id =
      env.ELEVENLABS_TTS_MODEL?.trim() || (typeof body.model_id === 'string' && body.model_id.trim()) || TTS_MODEL;

    const up = await fetch(
      `${ELEVENLABS}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${TTS_OUTPUT_FORMAT}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id }),
      },
    );
    if (!up.ok) return fail(up.status, `elevenlabs tts ${up.status}: ${(await up.text()).slice(0, 500)}`);
    return new Response(up.body, {
      status: 200,
      headers: {
        'content-type': up.headers.get('content-type') ?? 'audio/mpeg',
        'cache-control': 'no-store',
      },
    });
  }

  return fail(404, `no voice route at ${url.pathname} (stt, tts)`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1')) return env.ASSETS.fetch(request);
    if (url.pathname.startsWith('/v1/voice')) return voice(request, url, env);

    const upstream = new URL(originFor(url.pathname, env));
    upstream.pathname = url.pathname;
    upstream.search = url.search;

    const headers = new Headers(request.headers);
    headers.delete('host');
    const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
    return fetch(upstream.toString(), init);
  },
};
