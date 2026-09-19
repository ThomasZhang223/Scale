import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Voice, STT_MODEL, TTS_MODEL, type VoiceState } from './voice.ts';

// Minimal browser stand-ins: a recorder that yields one 2 KB chunk on stop, a mic that always
// grants, and an <audio> that "ends" right after play().
class FakeRecorder {
  static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? '';
  }
  start() { this.state = 'recording'; }
  stop() {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) });
    this.state = 'inactive';
    this.onstop?.();
  }
}
class FakeAudio {
  src = '';
  preload = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
  pause() {}
  removeAttribute() {}
}
const stream = { getAudioTracks: () => [{ readyState: 'live' }] };
const g = globalThis as Record<string, unknown>;
const define = (k: string, v: unknown) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

const calls: { url: string; init: RequestInit }[] = [];
let answer: () => Response;
const states: [VoiceState, string | undefined][] = [];
const events = { onState: (s: VoiceState, d?: string) => void states.push([s, d]) };

beforeEach(() => {
  define('MediaRecorder', FakeRecorder);
  define('navigator', { mediaDevices: { getUserMedia: async () => stream } });
  define('Audio', FakeAudio);
  (URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:fake';
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
  define('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer(); });
  calls.length = 0;
  states.length = 0;
});

async function record(voice: Voice): Promise<string | null> {
  await voice.start();
  assert.equal(voice.state, 'recording');
  await new Promise((r) => setTimeout(r, 320)); // past MIN_RECORDING_MS; shorter is dropped
  return voice.stop();
}

test('start() throws, naming what is missing, when the browser cannot record', async () => {
  delete g.MediaRecorder;
  const voice = new Voice(events);
  assert.equal(voice.supported, false);
  await assert.rejects(() => voice.start(), /MediaRecorder and getUserMedia/);
  assert.equal(await voice.warmUp(), false);
});

test('stop() posts multipart with the file and model_id, returns the trimmed transcript', async () => {
  answer = () => Response.json({ text: '  put the chair by the window  ', language_code: 'en' });
  const voice = new Voice(events, '/v1/voice');
  assert.equal(await voice.warmUp(), true);
  assert.equal(await record(voice), 'put the chair by the window');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/voice/stt');
  const form = calls[0].init.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model_id'), STT_MODEL);
  const file = form.get('file') as Blob;
  assert.equal(file.size, 2048);
  assert.equal(file.type, 'audio/webm;codecs=opus');
  assert.deepEqual(states.map((s) => s[0]), ['recording', 'transcribing', 'idle']);
});

test('a 501 from the proxy surfaces its error text through onState and yields null', async () => {
  const error = 'ELEVENLABS_API_KEY is not set: wrangler secret put ELEVENLABS_API_KEY (apps/xr)';
  answer = () => Response.json({ error }, { status: 501 });
  const voice = new Voice(events);
  assert.equal(await record(voice), null);
  assert.equal(voice.state, 'error');
  assert.deepEqual(states.at(-1), ['error', error]);
});

test('an empty transcript is null, not an empty string', async () => {
  answer = () => Response.json({ text: '   ' });
  assert.equal(await record(new Voice(events)), null);
});

test('speak() posts {text, model_id} and goes speaking → idle', async () => {
  answer = () => new Response(new Uint8Array([0xff, 0xfb]), { headers: { 'content-type': 'audio/mpeg' } });
  const voice = new Voice(events);
  await voice.speak('Done. The chair is by the window.');
  assert.equal(calls[0].url, '/v1/voice/tts');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    text: 'Done. The chair is by the window.',
    model_id: TTS_MODEL,
  });
  assert.deepEqual(states.map((s) => s[0]), ['speaking', 'idle']);
});

test('speak() reports a proxy failure instead of playing silence', async () => {
  answer = () => Response.json({ error: 'ELEVENLABS_VOICE_ID is not set' }, { status: 501 });
  const voice = new Voice(events);
  await voice.speak('hello');
  assert.deepEqual(states.at(-1), ['error', 'ELEVENLABS_VOICE_ID is not set']);
});
