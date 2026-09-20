// D1 access. Every row -> schema conversion lives here, so a column rename is one file.
//
// The `objects` table stores `glb_key`, an R2 key. It never stores a URL. `toObjectV1` is the
// only place a key becomes `glbUrl`, and it needs the request origin to do it — which is why
// every read takes an `origin` argument rather than reading a configured base URL.

import { assetUrl, R2Keys } from "./keys";
import { HttpError } from "./http";
import type { ObjectV1, PlacementV1, VersionV1 } from "./contracts";
import { SCHEMA_VERSION } from "./contracts";

interface ObjectRow {
  id: string;
  source: string;
  state: string;
  name: string | null;
  category: string | null;
  glb_key: string | null;
  bbox_w: number;
  bbox_h: number;
  bbox_d: number;
  measure_method: string | null;
  measure_confidence: number | null;
  caption: string | null;
  palette_json: string | null;
  price_cents: number | null;
  currency: string | null;
  product_url: string | null;
  merchant: string | null;
  created_at: string;
}

export function toObjectV1(row: ObjectRow, origin: string): ObjectV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    objectId: row.id,
    source: row.source as ObjectV1["source"],
    state: row.state as ObjectV1["state"],
    name: row.name ?? "",
    category: row.category ?? "",
    // The one key -> URL conversion. See lib/keys.ts.
    glbUrl: row.glb_key ? assetUrl(origin, row.glb_key) : null,
    bboxMeters: { w: row.bbox_w, h: row.bbox_h, d: row.bbox_d },
    measure: {
      method: (row.measure_method ?? "declared") as ObjectV1["measure"]["method"],
      confidence: row.measure_confidence ?? 0,
    },
    caption: row.caption,
    palette: row.palette_json ? (JSON.parse(row.palette_json) as string[]) : null,
    price:
      row.price_cents !== null && row.currency
        ? { cents: row.price_cents, currency: row.currency }
        : null,
    productUrl: row.product_url,
    merchant: row.merchant,
    createdAt: row.created_at,
  };
}

export async function getObject(env: Env, id: string, origin: string): Promise<ObjectV1> {
  const row = await env.DB.prepare("SELECT * FROM objects WHERE id = ?").bind(id).first<ObjectRow>();
  if (!row) throw new HttpError(404, "object_not_found", `No object with id ${id}.`);
  return toObjectV1(row, origin);
}

export async function getObjects(env: Env, ids: string[], origin: string): Promise<ObjectV1[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM objects WHERE id IN (${marks})`)
    .bind(...ids)
    .all<ObjectRow>();
  return (results ?? []).map((r) => toObjectV1(r, origin));
}

export interface ListObjectsQuery {
  source?: ObjectV1["source"] | null;
  merchant?: string | null;
  limit: number;
}

/**
 * The phone's library tabs. A plain filtered listing, newest first — deliberately not a search:
 * no ranking, no embedder, no relaxation. `merchant` matches the stored string exactly, which is
 * what the Furniture tab's merchant menu sends back (it got the values from this same route).
 */
export async function listObjects(env: Env, q: ListObjectsQuery, origin: string): Promise<ObjectV1[]> {
  const where: string[] = ["state != 'failed'"];
  const binds: (string | number)[] = [];
  if (q.source) {
    where.push("source = ?");
    binds.push(q.source);
  }
  if (q.merchant) {
    where.push("merchant = ?");
    binds.push(q.merchant);
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM objects WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...binds, q.limit)
    .all<ObjectRow>();
  return (results ?? []).map((r) => toObjectV1(r, origin));
}

export interface InsertObjectInput {
  objectId: string;
  source: ObjectV1["source"];
  state: ObjectV1["state"];
  name: string;
  category: string;
  bboxMeters: { w: number; h: number; d: number };
  measure: { method: string; confidence: number };
  caption?: string | null;
  palette?: string[] | null;
  price?: { cents: number; currency: string } | null;
  productUrl?: string | null;
  merchant?: string | null;
  createdAt: string;
}

export async function insertObject(env: Env, o: InsertObjectInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO objects (id, source, state, name, category, glb_key,
        bbox_w, bbox_h, bbox_d, measure_method, measure_confidence,
        caption, palette_json, price_cents, currency, product_url, merchant, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
        state = excluded.state, name = excluded.name, category = excluded.category,
        bbox_w = excluded.bbox_w, bbox_h = excluded.bbox_h, bbox_d = excluded.bbox_d`,
  )
    .bind(
      o.objectId,
      o.source,
      o.state,
      o.name,
      o.category,
      o.bboxMeters.w,
      o.bboxMeters.h,
      o.bboxMeters.d,
      o.measure.method,
      o.measure.confidence,
      o.caption ?? null,
      o.palette ? JSON.stringify(o.palette) : null,
      o.price?.cents ?? null,
      o.price?.currency ?? null,
      o.productUrl ?? null,
      o.merchant ?? null,
      o.createdAt,
    )
    .run();
}

/** Flip an object to ready. Called only by the mesh workflow's finalize step. */
export async function markObjectReady(
  env: Env,
  objectId: string,
  fields: { glbKey: string; caption?: string | null; palette?: string[] | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE objects SET state = 'ready', glb_key = ?, caption = COALESCE(?, caption),
       palette_json = COALESCE(?, palette_json) WHERE id = ?`,
  )
    .bind(
      fields.glbKey,
      fields.caption ?? null,
      fields.palette ? JSON.stringify(fields.palette) : null,
      objectId,
    )
    .run();
}

export async function markObjectFailed(env: Env, objectId: string): Promise<void> {
  await env.DB.prepare("UPDATE objects SET state = 'failed' WHERE id = ?").bind(objectId).run();
}

// --- Rooms ---------------------------------------------------------------------------------
//
// The capture JSON itself lives in R2 at rooms/{roomId}/capture.json, not in D1. D1 holds the
// index row so that listing rooms is a cheap query, and because a capture is a few hundred KB
// of wall transforms that nothing ever queries by field.

export async function putRoom(env: Env, capture: { roomId: string; capturedAt: string; northBearingDeg: number }, name: string, createdAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rooms (id, name, captured_at, north_bearing_deg, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, captured_at = excluded.captured_at,
       north_bearing_deg = excluded.north_bearing_deg`,
  )
    .bind(capture.roomId, name, capture.capturedAt, capture.northBearingDeg, createdAt)
    .run();
}

export async function roomExists(env: Env, roomId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM rooms WHERE id = ?").bind(roomId).first();
  return row !== null;
}

export async function loadRoomCapture(env: Env, roomId: string): Promise<unknown> {
  const obj = await env.BUCKET.get(R2Keys.roomCapture(roomId));
  if (!obj) {
    throw new HttpError(
      404,
      "room_not_found",
      `No capture stored for room ${roomId}. POST /v1/rooms writes it.`,
    );
  }
  return await obj.json();
}

// --- Versions ------------------------------------------------------------------------------

interface VersionRow {
  id: string;
  room_id: string;
  parent_id: string | null;
  label: string | null;
  content_hash: string;
  placements_json: string;
  materials_json: string;
  created_at: string;
}

function toVersionV1(row: VersionRow): VersionV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    versionId: row.id,
    roomId: row.room_id,
    parentId: row.parent_id,
    label: row.label ?? "",
    createdAt: row.created_at,
    placements: JSON.parse(row.placements_json) as PlacementV1[],
    materials: JSON.parse(row.materials_json) as Record<string, string>,
    contentHash: row.content_hash,
  };
}

export async function insertVersion(env: Env, v: VersionV1): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO versions (id, room_id, parent_id, label, content_hash,
        placements_json, materials_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      v.versionId,
      v.roomId,
      v.parentId,
      v.label,
      v.contentHash,
      JSON.stringify(v.placements),
      JSON.stringify(v.materials),
      v.createdAt,
    )
    .run();
}

export async function getVersion(env: Env, versionId: string): Promise<VersionV1> {
  const row = await env.DB.prepare("SELECT * FROM versions WHERE id = ?")
    .bind(versionId)
    .first<VersionRow>();
  if (!row) throw new HttpError(404, "version_not_found", `No version with id ${versionId}.`);
  return toVersionV1(row);
}

export async function listVersions(env: Env, roomId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, label, created_at, parent_id FROM versions
     WHERE room_id = ? ORDER BY created_at ASC`,
  )
    .bind(roomId)
    .all<{ id: string; label: string | null; created_at: string; parent_id: string | null }>();
  return (results ?? []).map((r) => ({
    versionId: r.id,
    label: r.label ?? "",
    createdAt: r.created_at,
    parentId: r.parent_id,
  }));
}

export async function latestVersion(env: Env, roomId: string): Promise<VersionV1 | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM versions WHERE room_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(roomId)
    .first<VersionRow>();
  return row ? toVersionV1(row) : null;
}

// --- Jobs ----------------------------------------------------------------------------------
//
// A job row is the perceived-latency contract made observable. The phone polls GET /v1/jobs/{id}
// while the mesh generates, and each Workflow step advances progress_pct here.

export interface JobState {
  state: "queued" | "running" | "done" | "failed";
  progressPct: number;
  objectId: string;
  error: string | null;
}

export async function createJob(
  env: Env,
  jobId: string,
  objectId: string,
  kind: string,
  tier: string,
  createdAt: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, object_id, kind, tier, state, progress_pct, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, NULL, ?, ?)`,
  )
    .bind(jobId, objectId, kind, tier, createdAt, createdAt)
    .run();
}

export async function advanceJob(
  env: Env,
  jobId: string,
  state: JobState["state"],
  progressPct: number,
  error: string | null,
  updatedAt: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE jobs SET state = ?, progress_pct = ?, error = ?, updated_at = ? WHERE id = ?",
  )
    .bind(state, progressPct, error, updatedAt, jobId)
    .run();
}

export async function getJob(env: Env, jobId: string): Promise<JobState> {
  const row = await env.DB.prepare(
    "SELECT object_id, state, progress_pct, error FROM jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<{ object_id: string; state: string; progress_pct: number; error: string | null }>();
  if (!row) throw new HttpError(404, "job_not_found", `No job with id ${jobId}.`);
  return {
    state: row.state as JobState["state"],
    progressPct: row.progress_pct,
    objectId: row.object_id,
    error: row.error,
  };
}
