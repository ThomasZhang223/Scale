/*
 * Push-to-talk voice input and spoken output for the WebXR page, through ElevenLabs.
 *
 * The Meta Quest Browser has getUserMedia and <audio>, but no Web Speech API, so speech is
 * recorded here with MediaRecorder and sent to the same-origin proxy at `${base}/stt`
 * (Vite dev proxy or worker/index.ts), which holds the ElevenLabs key. The browser never
 * sees the key. Replies come back from `${base}/tts` as MP3 and play through one reused
 * <audio> element — the Quest only lets a page start audio after a user gesture, and the
 * trigger press that started the recording is that gesture.
 *
 * No DOM, no three.js: main.ts owns the UI and reacts to onState.
 */

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'speaking' | 'error';

export interface VoiceEvents {
  onState(state: VoiceState, detail?: string): void;
}

/** ElevenLabs model ids. scribe_v1 and eleven_turbo_v2_5 are listed as deprecated in the
 *  current model docs; the client sends these so the dev proxy (which cannot rewrite bodies)
 *  works, and the Worker keeps them as a safety net / override. */
export const STT_MODEL = 'scribe_v2';
export const TTS_MODEL = 'eleven_flash_v2_5';

/** A press shorter than this is a mis-fire on the trigger, not speech; never sent. */
export const MIN_RECORDING_MS = 300;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

export class Voice {
  readonly supported: boolean;
  private readonly events: VoiceEvents;
  private readonly base: string;
  private _state: VoiceState = 'idle';
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  /** Bumped by every speak() and stopSpeaking(); a stale speak() stops touching state. */
  private speakGen = 0;

  constructor(events: VoiceEvents, base = '/v1/voice') {
    this.events = events;
    this.base = base.replace(/\/$/, '');
    this.supported =
      typeof MediaRecorder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function';
  }

  get state(): VoiceState {
    return this._state;
  }

  private set(state: VoiceState, detail?: string): void {
    this._state = state;
    this.events.onState(state, detail);
  }

  /** Ask for the microphone now, so the permission prompt shows on the 2D page rather than
   *  inside the VR session (where the Quest Browser hides it behind the immersive view). */
  async warmUp(): Promise<boolean> {
    if (!this.supported) return false;
    try {
      await this.mic();
      return true;
    } catch (e) {
      this.set('error', `microphone: ${message(e)}`);
      return false;
    }
  }

  private async mic(): Promise<MediaStream> {
    if (this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live')) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return this.stream;
  }

  /** Push-to-talk begins. Throws when the browser cannot record at all. */
  async start(): Promise<void> {
    if (!this.supported) {
      throw new Error(
        'Voice input needs MediaRecorder and getUserMedia; this browser has neither. ' +
          'On the Quest, open the page in the Meta Quest Browser over HTTPS.',
      );
    }
    if (this._state === 'recording') return;
    this.stopSpeaking();
    let stream: MediaStream;
    try {
      stream = await this.mic();
    } catch (e) {
      this.set('error', `microphone: ${message(e)}`);
      throw e;
    }
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    recorder.start();
    this.recorder = recorder;
    this.startedAt = Date.now();
    this.set('recording');
  }

  /** Push-to-talk ends. Resolves to the trimmed transcript, or null when there was nothing
   *  worth sending (too short, silent) or the proxy failed (state 'error' carries why). */
  async stop(): Promise<string | null> {
    const recorder = this.recorder;
    if (!recorder || this._state !== 'recording') return null;
    this.recorder = null;
    const durationMs = Date.now() - this.startedAt;

    await new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') return resolve();
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    const blob = new Blob(this.chunks, { type: recorder.mimeType || this.chunks[0]?.type || 'audio/webm' });
    this.chunks = [];

    if (durationMs < MIN_RECORDING_MS || blob.size === 0) {
      this.set('idle', `recording too short (${durationMs} ms)`);
      return null;
    }

    this.set('transcribing');
    try {
      const form = new FormData();
      form.append('file', blob, `speech.${extensionFor(blob.type)}`);
      // Always present: the Vite dev proxy forwards multipart untouched and ElevenLabs
      // requires model_id. The Worker appends it too, as a safety net.
      form.append('model_id', STT_MODEL);
      const res = await fetch(`${this.base}/stt`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await errorOf(res));
      const body = (await res.json()) as { text?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      this.set('idle');
      return text.length > 0 ? text : null;
    } catch (e) {
      this.set('error', message(e));
      return null;
    }
  }

  /** Speak `text` through the shared <audio>; anything already playing is cut off. */
  async speak(text: string): Promise<void> {
    this.stopSpeaking();
    const trimmed = text.trim();
    if (!trimmed) return;
    const gen = ++this.speakGen;
    this.set('speaking');
    try {
      const res = await fetch(`${this.base}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // model_id rides along for the dev proxy, which forwards the JSON as-is; the Worker
        // overrides it with ELEVENLABS_TTS_MODEL when that var is set.
        body: JSON.stringify({ text: trimmed, model_id: TTS_MODEL }),
      });
      if (gen !== this.speakGen) return;
      if (!res.ok) throw new Error(await errorOf(res));
      const bytes = await res.blob();
      if (gen !== this.speakGen) return;

      const audio = this.player();
      this.releaseUrl();
      this.audioUrl = URL.createObjectURL(bytes);
      audio.src = this.audioUrl;
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('audio playback failed'));
        audio.play().catch(reject);
      });
      if (gen !== this.speakGen) return;
      this.set('idle');
    } catch (e) {
      if (gen !== this.speakGen) return; // cancelled by stopSpeaking(); its state change wins
      this.set('error', message(e));
    } finally {
      if (gen === this.speakGen) this.releaseUrl();
    }
  }

  stopSpeaking(): void {
    this.speakGen++;
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
      } catch {
        /* an element with no source throws on some browsers; nothing to stop */
      }
    }
    this.releaseUrl();
    if (this._state === 'speaking') this.set('idle');
  }

  private player(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
    }
    return this.audio;
  }

  private releaseUrl(): void {
    if (this.audioUrl) {
      URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
  }
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

function extensionFor(mime: string): string {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

/** The proxy answers failures as JSON { error }, both 501 (not configured) and upstream
 *  errors; surface that text rather than a bare status code. */
async function errorOf(res: Response): Promise<string> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* body already consumed or unreadable; the status is all we have */
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return text ? `${res.status}: ${text.slice(0, 200)}` : `${res.status} ${res.statusText}`.trim();
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
