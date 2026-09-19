// Real implementations for the HTTP surface in .claude/contracts.md.
//
// The stub layer in src/index.ts answers first when a request carries `X-Stub: 1`. Everything
// here runs only for real requests, so a teammate building against a fixture is never affected
// by what this file does.

import { HttpError, json, noContent, readJson } from "../lib/http";
import { contentHash, nowIso, token, uuid } from "../lib/ids";
import { R2Keys, contentTypeFor, keyFromAssetPath } from "../lib/keys";
import { callUpstream, upstreamOrigin } from "../lib/config";
import { emitToRoom, roomAgent, scoutAgent } from "../lib/notify";
import {
  advanceJob,
  createJob,
  getJob,
  getObject,
  getObjects,
  getVersion,
  insertObject,
  insertVersion,
  latestVersion,
  listVersions,
  loadRoomCapture,
  putRoom,
  roomExists,
} from "../lib/store";
import {
  assertBBoxMeters,
  assertSchemaVersion,
  assertWorldAlignment,
  required,
} from "../lib/validate";
import { SCHEMA_VERSION } from "../lib/contracts";
import type {
  FitReportV1,
  ObjectV1,
  PlacementV1,
  RoomCaptureV1,
  VersionV1,
} from "../lib/contracts";

// --- Rooms ---------------------------------------------------------------------------------

export async function postRoom(req: Request, env: Env): Promise<Response> {
  const capture = await readJson<RoomCaptureV1>(req);
  assertSchemaVersion(capture, "RoomCapture");
  // Without true north the sun simulation is invented, and retrofitting means re-scanning
  // every room. Reject rather than store. contracts.md fixes this as a 422.
  assertWorldAlignment(capture);
  const roomId = required(capture.roomId, "roomId");

  const at = nowIso();
  // The capture itself goes to R2. D1 holds only the index row: a capture is a few hundred KB
  // of wall transforms and nothing ever queries it by field.
  await env.BUCKET.put(R2Keys.roomCapture(roomId), JSON.stringify(capture), {
    httpMetadata: { contentType: "application/json" },
  });
  await putRoom(env, capture, `Room ${roomId.slice(0, 8)}`, at);

  return json({ roomId });
}

export async function getRoom(env: Env, roomId: string): Promise<Response> {
  return json(await loadRoomCapture(env, roomId));
}

// --- Versions ------------------------------------------------------------------------------

export async function postVersion(req: Request, env: Env, roomId: string): Promise<Response> {
  if (!(await roomExists(env, roomId))) {
    throw new HttpError(404, "room_not_found", `No room with id ${roomId}. POST /v1/rooms first.`);
  }
  const body = await readJson<{
    label?: string;
    placements?: PlacementV1[];
    materials?: Record<string, string>;
    parentId?: string | null;
  }>(req);

  const placements = body.placements ?? [];
  // A non-unit scale means somebody broke the mesh normalisation contract upstream. Say so
  // here rather than letting the room render at the wrong size and blaming the renderer.
  for (const p of placements) {
    if (p.scale !== undefined && p.scale !== 1.0) {
      throw new HttpError(
        422,
        "non_unit_scale",
        `Placement ${p.placementId} has scale ${p.scale}. Scale is 1.0 everywhere except an ` +
          `explicit user override — a GLB is already bound to its measured size.`,
      );
    }
  }

  const parent = body.parentId !== undefined ? body.parentId : (await latestVersion(env, roomId))?.versionId ?? null;
  const materials = body.materials ?? { wall: "#8a9a7b", floor: "oak-natural", trim: "#ffffff" };

  const version: VersionV1 = {
    schemaVersion: SCHEMA_VERSION,
    versionId: uuid(),
    roomId,
    parentId: parent,
    label: body.label ?? "",
    createdAt: nowIso(),
    placements,
    materials,
    // A version is immutable. Hashing placements plus materials with keys sorted is what makes
    // history free: keep parent pointers, diff two versions into added, removed and moved.
    contentHash: await contentHash({ placements, materials }),
  };

  await insertVersion(env, version);
  return json(version);
}

export async function getVersionList(env: Env, roomId: string): Promise<Response> {
  return json(await listVersions(env, roomId));
}

export async function getVersionById(env: Env, versionId: string): Promise<Response> {
  return json(await getVersion(env, versionId));
}

// --- Uploads -------------------------------------------------------------------------------
//
// contracts.md calls for `{ key, putUrl }` from a presign. An R2 *binding* cannot sign a URL —
// presigning needs AWS SigV4 and a separate R2 API token, which would be a third secret to
// manage and would make uploads impossible in local dev against a simulated bucket.
//
// So putUrl points back at this Worker. The client's PUT is proxied into R2 through the
// binding. The contract shape is unchanged; only the host in the URL differs.
//
// ceiling: every upload crosses the Worker, which caps a single file at the Workers request
// body limit (100 MB on the free plan). Frames are ~200 KB and a bound GLB is a few MB, so the
// ceiling is far away. The upgrade path, if a large USDZ ever needs uploading, is aws4fetch
// plus an R2 API token as a Worker secret, signing a real direct-to-R2 URL.

const UPLOAD_TTL_SECONDS = 900;

export async function postUpload(req: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson<{
    kind: string;
    ext?: string;
    objectId?: string;
    roomId?: string;
    n?: number;
    merchant?: string;
    productId?: string;
  }>(req);

  const kind = required(body.kind, "kind");
  let key: string;
  switch (kind) {
    case "roomCapture":
      key = R2Keys.roomCapture(required(body.roomId, "roomId"));
      break;
    case "objectFrame":
      key = R2Keys.objectFrame(required(body.objectId, "objectId"), body.n ?? 0);
      break;
    case "objectMesh":
      key = R2Keys.objectMesh(required(body.objectId, "objectId"));
      break;
    case "objectThumb":
      key = R2Keys.objectThumb(required(body.objectId, "objectId"));
      break;
    case "catalogSource":
      key = R2Keys.catalogSource(
        required(body.merchant, "merchant"),
        required(body.productId, "productId"),
      );
      break;
    default:
      // Standing rule 4: no "first kind in the list" fallback. An unrecognised kind is a
      // caller bug and naming the valid set is the fastest way for them to see it.
      throw new HttpError(
        400,
        "unknown_upload_kind",
        `kind "${kind}" is not one of roomCapture, objectFrame, objectMesh, objectThumb, catalogSource.`,
      );
  }

  const grant = token();
  await env.CONFIG.put(`upload:${grant}`, key, { expirationTtl: UPLOAD_TTL_SECONDS });

  return json({
    key,
    putUrl: `${origin}/v1/uploads/${key}?t=${grant}`,
    expiresInSeconds: UPLOAD_TTL_SECONDS,
  });
}

export async function putUpload(req: Request, env: Env, pathname: string): Promise<Response> {
  const prefix = "/v1/uploads/";
  const key = decodeURIComponent(pathname.slice(prefix.length));
  const grant = new URL(req.url).searchParams.get("t");
  if (!grant) throw new HttpError(401, "missing_upload_token", "No ?t= token on the PUT url.");

  const granted = await env.CONFIG.get(`upload:${grant}`);
  if (!granted) {
    throw new HttpError(
      401,
      "expired_upload_token",
      `That upload token is unknown or older than ${UPLOAD_TTL_SECONDS} seconds. POST /v1/uploads again.`,
    );
  }
  // The token is bound to one key. Without this check a valid token would write anywhere.
  if (granted !== key) {
    throw new HttpError(403, "token_key_mismatch", `That token is for ${granted}, not ${key}.`);
  }

  await env.BUCKET.put(key, req.body, {
    httpMetadata: { contentType: req.headers.get("content-type") ?? contentTypeFor(key) },
  });
  // One token, one upload. A replayed token is a bug somewhere and should fail loudly.
  await env.CONFIG.delete(`upload:${grant}`);

  return json({ key, ok: true });
}

// --- Assets --------------------------------------------------------------------------------

export async function getAsset(env: Env, pathname: string): Promise<Response> {
  const key = keyFromAssetPath(pathname);
  if (!key) throw new HttpError(400, "bad_asset_path", `${pathname} is not a valid asset path.`);

  const obj = await env.BUCKET.get(key);
  if (!obj) throw new HttpError(404, "asset_not_found", `Nothing stored at ${key}.`);

  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? contentTypeFor(key),
      etag: obj.httpEtag,
      // A key is derived from an immutable id, so the bytes at a key never change. The Quest
      // reloading a room should not refetch a 4 MB mesh it already has.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

// --- Objects -------------------------------------------------------------------------------

export async function postObject(req: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson<{
    objectId?: string;
    source: ObjectV1["source"];
    name: string;
    category: string;
    bboxMeters: { w: number; h: number; d: number };
    measure: { method: string; confidence: number };
    frameKeys?: string[];
    price?: { cents: number; currency: string } | null;
    productUrl?: string | null;
    merchant?: string | null;
  }>(req);

  assertBBoxMeters(body.bboxMeters, "object");
  const objectId = body.objectId ?? uuid();

  await insertObject(env, {
    objectId,
    source: required(body.source, "source"),
    // The perceived-latency fix, and it lives in the schema rather than in the UI: a real
    // bboxMeters with a null glbUrl comes back in under a second and the phone draws the
    // measured box immediately. glbUrl arrives later over SSE.
    state: "measured",
    name: body.name ?? "",
    category: body.category ?? "",
    bboxMeters: body.bboxMeters,
    measure: body.measure ?? { method: "declared", confidence: 0 },
    price: body.price ?? null,
    productUrl: body.productUrl ?? null,
    merchant: body.merchant ?? null,
    createdAt: nowIso(),
  });

  return json(await getObject(env, objectId, origin));
}

export async function getObjectById(env: Env, id: string, origin: string): Promise<Response> {
  return json(await getObject(env, id, origin));
}

export async function postGenerate(
  req: Request,
  env: Env,
  objectId: string,
  origin: string,
): Promise<Response> {
  const body = await readJson<{ tier?: "live" | "quality"; roomId?: string | null }>(req);
  const tier = body.tier ?? "live";
  if (tier !== "live" && tier !== "quality") {
    throw new HttpError(400, "bad_tier", `tier must be "live" or "quality", got ${tier}.`);
  }
  // Fails with 404 if the object does not exist, before a job row is written for nothing.
  await getObject(env, objectId, origin);

  const jobId = uuid();
  await createJob(env, jobId, objectId, "mesh", tier, nowIso());
  await env.DB.prepare("UPDATE objects SET state = 'generating' WHERE id = ?").bind(objectId).run();

  try {
    await env.GENERATE_MESH.create({
      id: jobId,
      params: { jobId, objectId, tier, apiOrigin: origin, roomId: body.roomId ?? null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await advanceJob(env, jobId, "failed", 0, message.slice(0, 500), nowIso());
    throw new HttpError(502, "workflow_start_failed", message);
  }

  return json({ jobId });
}

export async function getJobById(env: Env, jobId: string): Promise<Response> {
  return json(await getJob(env, jobId));
}

// --- Search --------------------------------------------------------------------------------
//
// Split ownership, stated once in contracts.md: Thomas owns the shape and the transport, Paul
// owns the ranking inside, Ani writes the rows. Three paths, and the response says which ran
// in an X-Ranker header so nobody has to guess from the results.
//
//   vectorize   embedding query against objects-v1 with a hard millimetre range filter
//   upstream    the same candidates, re-ranked by Paul's service through the tunnel
//   d1-fallback no embedder reachable: text LIKE plus the same dimension filter over D1
//
// The d1-fallback path is the cut-list item from BUILD_DOC ("fall back to a brute-force scan
// over the objects table, fine at a few hundred objects"). It exists so that search answers
// on stage even if Ani's embedder or the network is down, which is the whole point of having
// written it down in advance.

export interface SearchBody {
  text?: string;
  imageKey?: string;
  fit?: { maxW?: number | null; maxH?: number | null; maxD?: number | null } | null;
  source?: "scan" | "catalog" | null;
  maxPriceCents?: number | null;
  limit?: number;
}

export async function postSearch(req: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson<SearchBody>(req);
  const limit = Math.min(Math.max(body.limit ?? 8, 1), 50); // Vectorize caps topK at 50 with metadata.

  const embedding = await queryEmbedding(env, body);

  if (!embedding) {
    const hits = await d1Search(env, body, limit, origin);
    return json(hits, 200, { "x-ranker": "d1-fallback" });
  }

  // $lte is Vectorize's numeric range operator. It only works on a field that has a metadata
  // index — `wrangler vectorize create-metadata-index`, which infra/cloudflare/provision.sh
  // runs. Without the index the filter silently matches nothing.
  const filter: VectorizeVectorMetadataFilter = {};
  if (body.fit?.maxW != null) filter.w_mm = { $lte: Math.round(body.fit.maxW * 1000) };
  if (body.fit?.maxH != null) filter.h_mm = { $lte: Math.round(body.fit.maxH * 1000) };
  if (body.fit?.maxD != null) filter.d_mm = { $lte: Math.round(body.fit.maxD * 1000) };
  if (body.source) filter.source = body.source;

  const matches = await env.OBJECTS_INDEX.query(embedding, {
    topK: limit,
    returnMetadata: "indexed",
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  });

  const ids = matches.matches.map((m) => String(m.metadata?.objectId ?? m.id));
  const objects = await getObjects(env, ids, origin);
  const byId = new Map(objects.map((o) => [o.objectId, o]));

  let hits = matches.matches
    .map((m) => {
      const id = String(m.metadata?.objectId ?? m.id);
      const object = byId.get(id);
      return object ? { objectId: id, score: m.score, object } : null;
    })
    .filter((h): h is { objectId: string; score: number; object: ObjectV1 } => h !== null);

  if (body.maxPriceCents != null) {
    hits = hits.filter((h) => (h.object.price?.cents ?? 0) <= body.maxPriceCents!);
  }

  // Never an empty result set on stage. Relaxing the fit filter by 10% and saying so is better
  // than returning nothing — but only the fit filter relaxes, never the price.
  if (hits.length === 0 && body.fit) {
    const relaxed = {
      ...body,
      fit: {
        maxW: body.fit.maxW != null ? body.fit.maxW * 1.1 : null,
        maxH: body.fit.maxH != null ? body.fit.maxH * 1.1 : null,
        maxD: body.fit.maxD != null ? body.fit.maxD * 1.1 : null,
      },
    };
    const relaxedHits = await d1Search(env, relaxed, limit, origin);
    return json(relaxedHits, 200, { "x-ranker": "relaxed" });
  }

  const searchOrigin = await env.CONFIG.get("upstream:search");
  if (!searchOrigin) return json(hits, 200, { "x-ranker": "vectorize" });

  // Paul's ranker is a re-rank stage over candidates we already have, not a replacement for
  // retrieval. If it is unreachable the Vectorize order still answers the request.
  try {
    const ranked = await callUpstream<{ objectId: string; score: number }[]>(
      env,
      "search",
      "/search",
      { query: body, candidates: hits },
      8_000,
    );
    const order = new Map(ranked.map((r, i) => [r.objectId, { rank: i, score: r.score }]));
    const reordered = [...hits].sort(
      (a, b) => (order.get(a.objectId)?.rank ?? 1e6) - (order.get(b.objectId)?.rank ?? 1e6),
    );
    return json(reordered, 200, { "x-ranker": "upstream" });
  } catch {
    return json(hits, 200, { "x-ranker": "vectorize-ranker-unreachable" });
  }
}

/**
 * A 768-dim SigLIP 2 query vector, or null when no embedder is reachable.
 *
 * Workers AI has no SigLIP or CLIP model, so this cannot be done at the edge. It has to come
 * from Ani's Baseten endpoint, whose text tower shares the vision tower's space. Returning
 * null rather than a zero vector matters: a zero vector would return arbitrary nearest
 * neighbours that look like real results.
 */
async function queryEmbedding(env: Env, body: SearchBody): Promise<number[] | null> {
  if (!body.text && !body.imageKey) return null;
  if (!env.BASETEN_URL) return null;
  try {
    const res = await fetch(`${env.BASETEN_URL.replace(/\/+$/, "")}/embed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.BASETEN_API_KEY ? { authorization: `Api-Key ${env.BASETEN_API_KEY}` } : {}),
      },
      body: JSON.stringify({ text: body.text ?? null, image_key: body.imageKey ?? null }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as { embedding?: number[] };
    return out.embedding && out.embedding.length === 768 ? out.embedding : null;
  } catch {
    return null;
  }
}

async function d1Search(env: Env, body: SearchBody, limit: number, origin: string) {
  const where: string[] = ["state IN ('measured','ready')"];
  const binds: (string | number)[] = [];

  if (body.text) {
    where.push("(lower(name) LIKE ? OR lower(category) LIKE ? OR lower(COALESCE(caption,'')) LIKE ?)");
    const needle = `%${body.text.toLowerCase()}%`;
    binds.push(needle, needle, needle);
  }
  if (body.source) {
    where.push("source = ?");
    binds.push(body.source);
  }
  if (body.fit?.maxW != null) {
    where.push("bbox_w <= ?");
    binds.push(body.fit.maxW);
  }
  if (body.fit?.maxH != null) {
    where.push("bbox_h <= ?");
    binds.push(body.fit.maxH);
  }
  if (body.fit?.maxD != null) {
    where.push("bbox_d <= ?");
    binds.push(body.fit.maxD);
  }
  if (body.maxPriceCents != null) {
    where.push("(price_cents IS NULL OR price_cents <= ?)");
    binds.push(body.maxPriceCents);
  }

  const { results } = await env.DB.prepare(
    `SELECT id FROM objects WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<{ id: string }>();

  const objects = await getObjects(env, (results ?? []).map((r) => r.id), origin);
  // Score is 0 on this path, and deliberately not a fabricated similarity. The X-Ranker header
  // says d1-fallback, so a caller that cares can tell these apart from real vector scores.
  return objects.map((object) => ({ objectId: object.objectId, score: 0, object }));
}

// --- Fit and solve -------------------------------------------------------------------------
//
// Both hydrate the request fully before calling the laptop. services/fit is stateless by
// design and never fetches a room, so the Worker owns assembling the body.

export async function postFit(req: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson<{ roomId: string; versionId?: string; placements?: PlacementV1[] }>(req);
  const roomId = required(body.roomId, "roomId");
  const room = (await loadRoomCapture(env, roomId)) as RoomCaptureV1;

  let placements = body.placements;
  if (!placements) {
    const versionId = required(body.versionId, "versionId or placements");
    placements = (await getVersion(env, versionId)).placements;
  }

  const report = await callUpstream<FitReportV1>(env, "solver", "/fit", {
    schemaVersion: SCHEMA_VERSION,
    room,
    placements,
  });
  await emitToRoom(env, roomId, "fit", report);
  void origin;
  return json(report);
}

export async function postSolve(req: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson<{
    roomId: string;
    intent: string;
    budgetCents?: number | null;
    fixed?: PlacementV1[];
    objectIds?: string[];
  }>(req);

  const roomId = required(body.roomId, "roomId");
  // An intent is words. The RoomAgent turns it into an objective and constraints, and the
  // solver turns those into coordinates. This route is the front door to that, so a caller
  // that already knows the constraint plan should call the solver's own /solve, not this.
  required(body.intent, "intent");

  const agent = await roomAgent(env, roomId);
  const res = await agent.fetch("https://agent/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId,
      intent: body.intent,
      budgetCents: body.budgetCents ?? null,
      fixed: body.fixed ?? [],
    }),
  });
  void origin;
  return json(await res.json(), res.status);
}

// --- Agent entry points ----------------------------------------------------------------------

export async function postScout(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ sessionId?: string; query: string }>(req);
  // One agent per session, so its memory of what it already ingested survives the follow-up
  // question. A caller that sends no sessionId gets a fresh agent with no memory, which is
  // correct but wasteful — the client should keep and resend the id.
  const sessionId = body.sessionId ?? uuid();
  const agent = await scoutAgent(env, sessionId);
  const res = await agent.fetch("https://agent/scout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: required(body.query, "query") }),
  });
  const out = (await res.json()) as Record<string, unknown>;
  return json({ sessionId, ...out }, res.status);
}

export async function postScoutSeed(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ sessionId?: string; merchants: { name: string; storefront: string }[] }>(req);
  const sessionId = body.sessionId ?? "default";
  const agent = await scoutAgent(env, sessionId);
  const res = await agent.fetch("https://agent/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchants: body.merchants ?? [] }),
  });
  return json({ sessionId, ...((await res.json()) as Record<string, unknown>) }, res.status);
}

export async function getAgentMemory(env: Env, kind: "room" | "scout", id: string): Promise<Response> {
  const agent = kind === "room" ? await roomAgent(env, id) : await scoutAgent(env, id);
  const res = await agent.fetch("https://agent/memory");
  return json(await res.json(), res.status);
}

// --- Push and sync ---------------------------------------------------------------------------

export async function postPush(req: Request, env: Env, roomId: string): Promise<Response> {
  const body = await readJson<{ versionId: string }>(req);
  const versionId = required(body.versionId, "versionId");
  // Fails with 404 before telling the headset to load a version that does not exist.
  await getVersion(env, versionId);
  await emitToRoom(env, roomId, "version", { versionId });
  return noContent();
}

export async function getSync(env: Env, roomId: string): Promise<Response> {
  const agent = await roomAgent(env, roomId);
  // The Durable Object holds the connection open. A Worker alone cannot: its request ends.
  return await agent.fetch("https://agent/sse");
}

// --- Diagnostics -----------------------------------------------------------------------------

/**
 * What is actually wired, right now.
 *
 * This exists because "the search returns nothing" has about six causes, and five of them are
 * configuration. One GET answers which.
 */
export async function getHealth(env: Env): Promise<Response> {
  const [solver, search, ingest] = await Promise.all([
    env.CONFIG.get("upstream:solver"),
    env.CONFIG.get("upstream:search"),
    env.CONFIG.get("upstream:ingest"),
  ]);

  let d1 = "unreachable";
  try {
    await env.DB.prepare("SELECT 1").first();
    d1 = "ok";
  } catch (err) {
    d1 = err instanceof Error ? err.message.slice(0, 120) : "error";
  }

  return json({
    ok: true,
    at: nowIso(),
    d1,
    upstreams: {
      solver: solver ?? null,
      search: search ?? null,
      ingest: ingest ?? null,
    },
    secrets: {
      UPSTREAM_TOKEN: Boolean(env.UPSTREAM_TOKEN),
      BASETEN_URL: Boolean(env.BASETEN_URL),
      BASETEN_API_KEY: Boolean(env.BASETEN_API_KEY),
    },
    notes: [
      "upstreams null -> POST /v1/fit, /v1/solve return 503 naming the kv key to set.",
      "BASETEN_URL unset -> /v1/search uses the d1-fallback ranker and /v1/objects/{id}/generate fails.",
    ],
  });
}

/** Ask the solver for its own health, through the tunnel. Proves the hop end to end. */
export async function getUpstreamHealth(env: Env): Promise<Response> {
  const origin = await upstreamOrigin(env, "solver");
  const res = await fetch(`${origin}/health`, {
    headers: env.UPSTREAM_TOKEN ? { "x-upstream-token": env.UPSTREAM_TOKEN } : {},
    signal: AbortSignal.timeout(8_000),
  });
  return json({ origin, status: res.status, body: (await res.text()).slice(0, 400) });
}
