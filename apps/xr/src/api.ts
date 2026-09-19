/*
 * The team's HTTP API (the Cloudflare Worker, Thomas's): rooms, objects and the per-room
 * live feed, exactly as .claude/contracts.md describes them. Every /v1 route answers a
 * committed fixture when the request carries `X-Stub: 1`; that's on by default here until
 * the real backend exists (VITE_API_STUB=0 turns it off). In dev, Vite proxies /v1 to the
 * Worker (vite.config.ts), so the browser sees one origin and CORS never comes up.
 */

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
export const API_BASE = env.VITE_API_BASE ?? '/v1';
export const STUB = env.VITE_API_STUB !== '0';
const EXPECTED_SCHEMA_VERSION = 1;

export interface BBoxMeters {
  w: number;
  h: number;
  d: number;
}

export interface ObjectV1 {
  schemaVersion: number;
  objectId: string;
  source: 'scan' | 'catalog' | 'primitive';
  state: 'measured' | 'generating' | 'ready' | 'failed';
  name: string;
  category: string;
  glbUrl: string | null;
  bboxMeters: BBoxMeters;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: STUB ? { 'X-Stub': '1' } : {} });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from GET ${API_BASE}${path}`);
  return res.json() as Promise<T>;
}

/** RoomCapture v1. buildRoomFromScan checks its schemaVersion. */
export function getRoom(roomId: string): Promise<Record<string, unknown>> {
  return get(`/rooms/${roomId}`);
}

export async function getObject(objectId: string): Promise<ObjectV1> {
  const obj = await get<ObjectV1>(`/objects/${objectId}`);
  checkSchema(obj, 'Object');
  return obj;
}

/** The fail-loud rule from the contract: a mismatch is a person problem, not a fallback. */
export function checkSchema(doc: { schemaVersion?: unknown }, what: string) {
  if (doc.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(`${what} schemaVersion ${doc.schemaVersion}, expected ${EXPECTED_SCHEMA_VERSION} — ask Thomas`);
  }
}

export interface ServerItem {
  url: string;
  name: string;
  scale: 1;
  expected: BBoxMeters;
}

/** What the headset needs from an Object v1: only a `ready` object has a mesh to load. */
export function objectToItem(obj: ObjectV1): ServerItem {
  checkSchema(obj, 'Object');
  if (obj.state !== 'ready' || !obj.glbUrl) throw new Error(`${obj.name} is ${obj.state}; no mesh yet`);
  // scale 1: the mesh normalisation contract guarantees the GLB already measures
  // bboxMeters. Rescaling here would be a bug, not a preference.
  return { url: obj.glbUrl, name: obj.name, scale: 1, expected: obj.bboxMeters };
}

/** Null when the loaded mesh matches bboxMeters within 1 mm; otherwise, what broke. */
export function boundsMismatch(size: { x: number; y: number; z: number }, expected: BBoxMeters): string | null {
  const worst = Math.max(Math.abs(size.x - expected.w), Math.abs(size.y - expected.h), Math.abs(size.z - expected.d));
  if (worst <= 0.001) return null;
  const f = (n: number) => n.toFixed(3);
  return `mesh measures ${f(size.x)} × ${f(size.y)} × ${f(size.z)} m but bboxMeters says ${f(expected.w)} × ${f(expected.h)} × ${f(expected.d)} m — the normalisation contract broke upstream (ask Ani)`;
}

export interface RoomEvents {
  object: (obj: ObjectV1) => void;
  version: (v: { versionId: string }) => void;
  fit: (report: unknown) => void;
  status: (status: 'live' | 'nosync') => void;
}

/**
 * GET /sync/{roomId}: the room's SSE stream (`object`, `version`, `fit` events). The Quest
 * subscribes once and never polls. If the stream isn't available (the stub answers 501),
 * try again every ten seconds. Returns a function that stops watching.
 */
export function watchRoom(roomId: string, on: RoomEvents): () => void {
  let source: EventSource | null = null;
  let retry: number | undefined;
  let stopped = false;

  const open = () => {
    source = new EventSource(`${API_BASE}/sync/${roomId}${STUB ? '?stub=1' : ''}`);
    source.onopen = () => on.status('live');
    source.addEventListener('object', (e) => on.object(JSON.parse((e as MessageEvent).data)));
    source.addEventListener('version', (e) => on.version(JSON.parse((e as MessageEvent).data)));
    source.addEventListener('fit', (e) => on.fit(JSON.parse((e as MessageEvent).data)));
    source.onerror = () => {
      on.status('nosync');
      source?.close();
      if (!stopped) retry = window.setTimeout(open, 10_000);
    };
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(retry);
    source?.close();
  };
}
