/*
 * The team's HTTP API (the Cloudflare Worker, Thomas's): rooms, objects and the per-room
 * live feed, exactly as .claude/contracts.md describes them. Every /v1 route answers a
 * committed fixture when the request carries `X-Stub: 1`; that's on by default here until
 * the real backend exists (VITE_API_STUB=0 turns it off). In dev, Vite proxies /v1 to the
 * Worker (vite.config.ts), so the browser sees one origin and CORS never comes up.
 */

import type { FitReport } from './fit';

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
  /**
   * A picture of the object, when the server has one. A catalogue row carries the store's
   * photo; a phone scan has none at all, because Object Capture uploads only the mesh — the
   * field is absent on those rows, which is the signal the headset renders one and sends it.
   * Read it only from a row the server sent: listings.ts fills a fallback URL in for search
   * results, so a Recommendation always looks like it has an image whether or not one exists.
   */
  imageUrl?: string | null;
  createdAt?: string;
  bboxMeters: BBoxMeters;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: STUB ? { 'X-Stub': '1' } : {} });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from GET ${API_BASE}${path}`);
  return res.json() as Promise<T>;
}

/** The room the phone picked for the headset (dev server, see vite.config.ts). null = none. */
export async function getActiveRoom(): Promise<string | null> {
  // The cloud route (POST/GET /v1/active-room on the front door), not the Vite dev server: the
  // deployed page has no dev server, and a Release build of the phone app has no Metro to find one.
  const res = await fetch(`${API_BASE}/active-room`, { cache: 'no-store' });
  if (!res.ok) return null;
  const body = (await res.json()) as { roomId?: string | null };
  return body.roomId ?? null;
}

/** A room from the live table, never the stub: a room built on the phone exists only there. */
export async function getRoomLive(roomId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/rooms/${roomId}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from GET ${API_BASE}/rooms/${roomId}`);
  return res.json() as Promise<Record<string, unknown>>;
}

/** RoomCapture v1. buildRoomFromScan checks its schemaVersion. */
export function getRoom(roomId: string): Promise<Record<string, unknown>> {
  return get(`/rooms/${roomId}`);
}

/** GET /objects?source=… : every object of that source, newest first. */
export async function listObjects(source: ObjectV1['source'], limit = 200): Promise<(ObjectV1 & { createdAt?: string })[]> {
  const rows = await get<(ObjectV1 & { createdAt?: string })[]>(`/objects?source=${source}&limit=${limit}`);
  for (const row of rows) checkSchema(row, 'Object');
  return rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export async function getObject(objectId: string): Promise<ObjectV1> {
  const obj = await get<ObjectV1>(`/objects/${objectId}`);
  checkSchema(obj, 'Object');
  return obj;
}

export interface JobV1 { state: 'queued' | 'running' | 'done' | 'failed'; progressPct: number; objectId: string; error: string | null }

export function getJob(jobId: string): Promise<JobV1> {
  return get(`/jobs/${jobId}`);
}

/**
 * POST /search, the contract route. Returns `[{objectId, score, object}]` in similarity order.
 * `source` is always explicit here: an unscoped text query is narrowed to the catalogue by the
 * Worker (X-Search-Scope), which is the wrong library for a scan or a built-in.
 */
export async function searchObjects(body: {
  text?: string;
  source: 'scan' | 'catalog' | 'primitive';
  fit?: { maxW?: number; maxH?: number; maxD?: number };
  limit?: number;
}): Promise<{ objectId: string; score: number; object: ObjectV1 }[]> {
  const res = await fetch(`${API_BASE}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} from POST ${API_BASE}/search`);
  const hits = (await res.json()) as { objectId: string; score: number; object: ObjectV1 }[];
  return Array.isArray(hits) ? hits : [];
}

/** What POST /v1/intent answers. `fit` is ignored by the caller: metres come from needFromText. */
export interface ParsedIntent {
  intent: 'shop' | 'scans' | 'library' | 'design';
  query: string | null;
  category: string | null;
  fit: { maxW?: number; maxH?: number; maxD?: number } | null;
  /**
   * Design requests only: the furniture CATEGORIES the request would need in the room ("a
   * reading nook" -> armchair, lamp, side table), in this app's own vocabulary. Never a product
   * and never a position (standing rule 3). Optional, because a Worker deployed before this
   * existed answers without it — an absent field means "we do not know", which is the same
   * thing the rules router says, and both leave the design request untouched.
   */
  needs?: string[] | null;
}

/**
 * POST /intent: what the sentence means, decided by a small model on the Worker.
 *
 * Rejects rather than guessing. Every failure — a timeout, a 502 from a model that answered
 * nothing, an offline headset — has one meaning for the caller: use the regex router instead.
 * The budget is deliberately shorter than the Worker's own, so a slow answer never becomes a
 * silent wait on a headset where nothing is drawn yet.
 */
export async function askIntent(text: string, budgetMs = 1200): Promise<ParsedIntent> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budgetMs);
  try {
    const res = await fetch(`${API_BASE}/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`${res.status} from POST ${API_BASE}/intent`);
    return (await res.json()) as ParsedIntent;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /listings/generate: a picked /find row becomes an object and a mesh job. Not in
 * contracts.md yet. `jobId` is null when the object already had its mesh — the Worker starts no
 * second inference over a finished one, so there is nothing to poll and `glbUrl` is there now.
 */
export function postListingsGenerate(listing: unknown, roomId: string | null): Promise<{ objectId: string; jobId: string | null; state?: string; glbUrl?: string | null }> {
  return post('/listings/generate', { listing, roomId });
}

/**
 * The phone's own captures that have a mesh: source "scan", state "ready", a glbUrl. Always the
 * live table, never the stub — a fixture cannot hold something you scanned a minute ago. Two
 * routes merged by id: GET /v1/objects (list route) and POST /v1/search with no text (contract
 * route); on 2026-09-19 the deployed Worker answered one of them empty for scans.
 */
export async function listScans(): Promise<ObjectV1[]> {
  const byId = new Map<string, ObjectV1>();
  const add = (list: ObjectV1[]) => {
    for (const o of list) if (o && o.objectId && !byId.has(o.objectId)) byId.set(o.objectId, o);
  };
  const results = await Promise.allSettled([
    fetch(`${API_BASE}/objects?source=scan&limit=50`).then(async (r) => (r.ok ? ((await r.json()) as ObjectV1[]) : [])),
    fetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'scan', limit: 50 }),
    }).then(async (r) => (r.ok ? ((await r.json()) as { object: ObjectV1 }[]).map((h) => h.object) : [])),
  ]);
  for (const r of results) if (r.status === 'fulfilled' && Array.isArray(r.value)) add(r.value);
  if (results.every((r) => r.status === 'rejected')) throw new Error('scans: both list routes failed');
  return [...byId.values()]
    .filter((o) => o.source === 'scan' && o.state === 'ready' && !!o.glbUrl)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * The built-in furniture: source "primitive" objects served from the cloud library. Always the
 * live table, never the stub (the stub layer only knows one MacBook). A row that is not ready
 * with a glbUrl is skipped by name; a failed list call throws, with no bundled fallback.
 */
export async function listBuiltIns(): Promise<ObjectV1[]> {
  // 200, not 50: the library passed 50 rows the night P-PAUL's CC0 models landed (102 now), and
  // a short page is invisible — it reads as "the library has no armchair" rather than "you asked
  // for the first fifty". The route caps at 500.
  const res = await fetch(`${API_BASE}/objects?source=primitive&limit=200`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from GET ${API_BASE}/objects?source=primitive`);
  const list = (await res.json()) as ObjectV1[];
  if (!Array.isArray(list)) throw new Error('GET /objects?source=primitive did not return a list — ask Thomas');
  return list.filter((o) => {
    if (o.state === 'ready' && o.glbUrl) return true;
    console.warn(`skipping built-in ${o.objectId} (${o.name}): state ${o.state}, glbUrl ${o.glbUrl}`);
    return false;
  });
}

/**
 * An asset URL the page can actually fetch. The Worker sends no CORS headers, so a GLB at the
 * Worker's absolute origin is unreachable from this page's origin; its /v1/... path, through the
 * same proxy the API already uses (Vite in dev, worker/index.ts deployed), is reachable.
 */
export function sameOrigin(url: string): string {
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin && u.pathname.startsWith('/v1/')) return u.pathname + u.search;
    return url;
  } catch {
    return url;
  }
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(STUB ? { 'X-Stub': '1' } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from POST ${API_BASE}${path}`);
  return res.json() as Promise<T>;
}

/** POST /fit: validate the room's layout. Returns FitReport v1 (the door-swing fixture under the stub). */
export async function postFit(roomId: string, placements?: unknown[]): Promise<FitReport> {
  const report = await post<FitReport>('/fit', placements ? { roomId, placements } : { roomId });
  checkSchema(report, 'FitReport');
  return report;
}

export interface PlacementV1 {
  placementId: string;
  objectId: string;
  p: [number, number, number];
  yawDeg: number;
  scale: number;
  lockedToWallId: string | null;
  flags: string[];
}

export interface VersionV1 {
  schemaVersion: number;
  versionId: string;
  roomId: string;
  parentId: string | null;
  label: string;
  createdAt: string;
  placements: PlacementV1[];
  materials: Record<string, string>;
  contentHash: string;
}

/** GET /rooms/{id}/versions: the room's layout history, oldest first. The last one is its head. */
export function listVersions(roomId: string): Promise<{ versionId: string; label: string; createdAt: string; parentId: string | null }[]> {
  return get(`/rooms/${roomId}/versions`);
}

export async function getVersion(versionId: string): Promise<VersionV1> {
  const version = await get<VersionV1>(`/versions/${versionId}`);
  checkSchema(version, 'Version');
  return version;
}

/** POST /rooms/{id}/versions with a Version v1 minus its ids; the server mints them. */
export function postVersion(roomId: string, body: Omit<VersionV1, 'versionId' | 'createdAt'>): Promise<VersionV1> {
  return post(`/rooms/${roomId}/versions`, body);
}

export interface RoomEvents {
  object: (obj: ObjectV1) => void;
  version: (v: { versionId: string }) => void;
  fit: (report: FitReport) => void;
  status: (status: 'live' | 'nosync') => void;
}

/**
 * GET /sync/{roomId}: the room's SSE stream (`object`, `version`, `fit` events). The Quest
 * subscribes once and never polls. If the stream isn't available (the stub answers 501),
 * try again every ten seconds. Returns a function that stops watching.
 */
/**
 * The phone's room choice, pushed. One EventSource on the LOBBY stream (GET /v1/sync/lobby): the
 * same SSE fan-out as a room's feed, keyed by a name that is not a room, because a headset showing
 * room A must still hear that the phone picked room B. Always live, never the stub.
 */
export function watchActiveRoom(onPick: (roomId: string) => void): () => void {
  let source: EventSource | null = null;
  let retry: number | undefined;
  let stopped = false;
  const open = () => {
    source = new EventSource(`${API_BASE}/sync/lobby`);
    source.addEventListener('active-room', (e) => {
      const roomId = (JSON.parse((e as MessageEvent).data) as { roomId?: string }).roomId;
      if (roomId) onPick(roomId);
    });
    source.onerror = () => {
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

/**
 * Sends a rendered picture of an object to the search index (thumbs.ts makes it).
 *
 * Object Capture uploads only the mesh, so for a phone scan this render is the only image of
 * that object that exists anywhere. Without one every scan carries the same text — "Captured
 * object", category "unknown" — embeds to the same point, and no query can tell two apart.
 *
 * Fire-and-forget by design: it resolves to nothing, it is never retried, and a failure is a
 * console warning. Nothing the user is doing depends on it.
 */
export async function postObjectThumbnail(objectId: string, jpeg: Blob): Promise<void> {
  const res = await fetch(`${API_BASE}/objects/${encodeURIComponent(objectId)}/thumbnail`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', ...(STUB ? { 'X-Stub': '1' } : {}) },
    body: jpeg,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from POST ${API_BASE}/objects/${objectId}/thumbnail`);
}
