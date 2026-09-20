// Real implementations for the HTTP surface in .claude/contracts.md.
//
// The stub layer in src/index.ts answers first when a request carries `X-Stub: 1`. Everything
// here runs only for real requests, so a teammate building against a fixture is never affected
// by what this file does.

import { HttpError, json, noContent, readJson } from "../lib/http";
import { contentHash, nowIso, token, uuid } from "../lib/ids";
import { R2Keys, contentTypeFor, keyFromAssetPath } from "../lib/keys";
import { callUpstream, callUpstreamRaw, upstreamOrigin } from "../lib/config";
import { embedInput, indexObject, type Embedding } from "../lib/embedding";
import { enqueueMesh } from "../lib/mesh-dispatch";
import { emitToRoom, roomAgent, scoutAgent } from "../lib/notify";
import {
  advanceJob,
  createJob,
  getJob,
  getObject,
  getObjects,
  getVersion,
  closeParkedMeshJobs,
  insertObject,
  insertVersion,
  latestVersion,
  listVersions,
  loadRoomCapture,
  putRoom,
  roomExists,
  listObjects,
  markObjectReady,
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
    case "scanMesh":
      key = R2Keys.scanMesh(required(body.objectId, "objectId"));
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
        `kind "${kind}" is not one of roomCapture, objectFrame, objectMesh, objectThumb, scanMesh, catalogSource.`,
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

// GET /v1/objects?source=scan|catalog&merchant=&limit=
//
// Not in contracts.md yet — see workers/DEPLOY.md "Schema proposals". The phone's Scanned and
// Furniture tabs read this; until it existed they could only show the one fixture object.
export async function getObjectList(req: Request, env: Env, origin: string): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const source = params.get("source");
  if (source !== null && source !== "scan" && source !== "catalog" && source !== "primitive") {
    throw new HttpError(400, "bad_source", `source must be scan, catalog or primitive, got ${source}.`);
  }
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 100) || 100, 1), 500);
  const objects = await listObjects(env, { source, merchant: params.get("merchant"), limit }, origin);
  return json(objects);
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
    const params = { jobId, objectId, tier, apiOrigin: origin, roomId: body.roomId ?? null };
    await enqueueMesh(env, params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await advanceJob(env, jobId, "failed", 0, message.slice(0, 500), nowIso());
    throw new HttpError(502, "workflow_start_failed", message);
  }

  return json({ jobId });
}

// POST /v1/objects/{id}/mesh  { key, roomId? }
//
// Attaches an already-uploaded GLB to an object and flips it to ready. Which key is acceptable
// follows the ROW's source, and there is no fallback either way:
//   scan               scans/{id}/mesh.glb    the phone's Object Capture path
//                      (apps/mobile/modules/object-capture reconstructs on-device with Apple's
//                      PhotogrammetrySession and uploads through POST /uploads, kind scanMesh)
//   catalog/primitive  objects/{id}/mesh.glb  a reviewed hero mesh (services/gen's
//                      WorkerArtifactSink, kind objectMesh — services/gen asserts that literal key)
// A scan is never attached under objects/ and a catalogue object never under scans/.
// Not in contracts.md yet — same standing as GET /v1/objects, see workers/DEPLOY.md "Schema proposals".
//
// Standing rule 2 ("the scale binding happens exactly once, in C") is honoured, not skipped:
// Object Capture output is already in metres at true size, so no binding step exists for a scan
// mesh at all — nothing here or downstream rescales it. `bboxMeters` on the object row was
// measured from that same mesh on the phone. A reviewed catalogue mesh was bound in C.
export async function postObjectMesh(
  req: Request,
  env: Env,
  objectId: string,
  origin: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readJson<{ key: string; roomId?: string | null }>(req);
  const key = required(body.key, "key");
  // 404 before anything else; the row decides which key is acceptable.
  const object0 = await getObject(env, objectId, origin);
  let expected: string;
  switch (object0.source) {
    case "scan":
      expected = R2Keys.scanMesh(objectId);
      break;
    case "catalog":
    case "primitive":
      expected = R2Keys.objectMesh(objectId);
      break;
    default:
      // Standing rule 4: an unrecognised source has no folder, and guessing one would file a
      // mesh where nothing looks for it.
      throw new HttpError(422, "unknown_object_source", `Object ${objectId} has source "${object0.source}".`);
  }
  if (key !== expected) {
    throw new HttpError(
      400,
      "bad_mesh_key",
      `key must be ${expected} for a ${object0.source} object, got ${key}.`,
    );
  }
  // A loud error if the client marks ready before its PUT landed.
  const head = await env.BUCKET.head(key);
  if (!head) throw new HttpError(409, "mesh_not_uploaded", `Nothing is stored at ${key} yet. PUT it first.`);
  // A truncated upload or an HTML error page must not flip a row to ready. Same check
  // generate-mesh.ts makes on Ani's path (assertGlb); this route had none.
  const probe = await env.BUCKET.get(key, { range: { offset: 0, length: 12 } });
  const bytes = probe ? new Uint8Array(await probe.arrayBuffer()) : new Uint8Array(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 12 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== head.size
  ) {
    throw new HttpError(
      422,
      "not_a_glb",
      `${key} is ${head.size} bytes but is not a binary glTF (bad magic, version or declared length).`,
    );
  }

  await markObjectReady(env, objectId, { glbKey: key });
  // A catalogue object may have mesh jobs parked (queued, undelivered) waiting for a Baseten
  // that is not configured. Close them so configuring it later cannot regenerate over this mesh.
  if (object0.source !== "scan") await closeParkedMeshJobs(env, objectId, nowIso());

  // A phone-uploaded GLB never passes through the mesh Workflow, so this is the only place a
  // scanned object can reach Vectorize. Same indexer as the Workflow — there is not a second one.
  // Object Capture uploads no photo (modules/object-capture exposes only imageCount), so the only
  // embeddable content is the name the user gave it. SigLIP 2's text tower shares the vision
  // tower's space, which is why a text vector is comparable with the catalogue's image vectors.
  // ceiling: a named scan is indexed from text, which is weaker than an image. The upgrade path is
  // for the capture module to export one frame and for this to pass imageKey instead.
  const text = [object0.name, object0.category]
    .filter((part) => part && part !== "unknown")
    .join(" ")
    .trim();
  let indexed: Record<string, string>;
  if (!text) {
    // Standing rule 4: do not invent a caption. Say the object is unsearchable and why.
    indexed = { "x-indexed": "false", "x-index-skipped": "no-embeddable-text" };
  } else {
    // Not awaited: the embed can take up to 25 s (embedInput's timeout) and this is the phone's
    // Save button. The mesh is stored and the object IS ready; only search is affected, so a
    // failure is logged and never reaches the phone.
    // ceiling: the outcome cannot be reported in this response. The retry path is
    // POST /v1/objects/{id}/index { text }.
    ctx.waitUntil(
      indexObject(env, {
        objectId,
        source: object0.source,
        category: object0.category,
        bboxMeters: object0.bboxMeters,
        dominantHex: object0.palette?.[0] ?? null,
        text,
      }).catch((err: unknown) => console.error(`scan_index_failed ${objectId}: ${String(err).slice(0, 300)}`)),
    );
    indexed = { "x-indexed": "pending" };
  }

  const object = await getObject(env, objectId, origin);
  if (body.roomId) await emitToRoom(env, body.roomId, "object", object);
  return json(object, 200, indexed);
}

/**
 * POST /v1/objects/{id}/index   { imageKey } | { text }   ->  { objectId, fingerprint, modality }
 *
 * Index an object into Vectorize without generating a mesh. Two jobs, one route:
 *  - backfill: catalogue rows loaded straight into D1 have real photos in R2 but no vectors,
 *    because the only other writer sits behind a Baseten call that may not be running.
 *  - retry: the mesh Workflow's index step records an embed failure and moves on (the job still
 *    ends `done`), and a phone scan is indexed in the background. This retries either without
 *    regenerating a paid mesh.
 *
 * Same X-Upstream-Token gate as POST /v1/catalog/ingest — this writes to a shared index and is
 * not a public route. Not in contracts.md yet; see workers/DEPLOY.md "Schema proposals".
 */
export async function postObjectIndex(
  req: Request,
  env: Env,
  objectId: string,
  origin: string,
): Promise<Response> {
  if (!env.UPSTREAM_TOKEN || req.headers.get("x-upstream-token") !== env.UPSTREAM_TOKEN) {
    throw new HttpError(401, "unauthorized", "A valid X-Upstream-Token is required.");
  }
  const body = await readJson<{ imageKey?: string; text?: string }>(req);
  if ((body.imageKey == null) === (body.text == null)) {
    throw new HttpError(400, "bad_index_input", "Supply exactly one of imageKey or text.");
  }
  const object = await getObject(env, objectId, origin); // 404s before touching Vectorize
  const r = await indexObject(env, {
    objectId,
    source: object.source,
    category: object.category,
    bboxMeters: object.bboxMeters,
    dominantHex: object.palette?.[0] ?? null,
    imageKey: body.imageKey,
    text: body.text,
  });
  return json({ objectId, fingerprint: r.fingerprint, modality: r.modality });
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

  // Paul's service first, when one is configured. It is a COMPLETE search, not a re-rank stage:
  // services/search/app/main.py embeds the query itself, queries its own index, and returns
  // `[{objectId, score, object}]` — the public contract shape. So the right move is to hand it
  // the caller's body untouched and return its answer, not to wrap the body in an envelope.
  //
  // This ordering also matters for cost: retrieving from Vectorize first and then discarding it
  // paid for a query nobody read.
  const searchOrigin = await env.CONFIG.get("upstream:search");
  // The laptop ranker's in-memory index is independent of Vectorize and may be empty.
  // With Cloudflare embeddings configured, query the durable index we actually write.
  const embeddingOrigin = await env.CONFIG.get("upstream:embedding");
  if (searchOrigin && !embeddingOrigin) {
    try {
      // Verbatim. `{ query: body, candidates }` would nest every field one level too deep, and
      // his `body.get("text")` / `body.get("fit")` would read None — producing an unfiltered,
      // unembedded search that returns plausible rows and reports no error at all.
      const res = await callUpstreamRaw(env, "search", "/search", body, 8_000);
      const ranked = (await res.json()) as unknown;
      const passthrough: Record<string, string> = { "x-ranker": "upstream" };
      // His headers say something the body does not: that the fit filter was widened, or that
      // his embedder was down. Losing them would hide a degradation.
      for (const h of ["x-fit-relaxed", "x-search-degraded"]) {
        const v = res.headers.get(h);
        if (v) passthrough[h] = v;
      }
      return json(ranked, 200, passthrough);
    } catch {
      // Falls through to the Vectorize path below. A ranker that is down must not take search
      // down with it — but the header has to say so, or the demo looks fine and is not.
      // ceiling: no circuit breaker. Every request pays the 8s timeout while it is down.
    }
  }

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

  const matches = await env.OBJECTS_INDEX.query(embedding.values, {
    namespace: embedding.fingerprint,
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

  // Reaching here means either no ranker is configured, or the configured one failed. Both are
  // real, complete answers in similarity order — which is why an unset upstream:search does not
  // 503 the way an unset upstream:solver does. The solver is a capability: with none there is no
  // answer to /v1/fit at all. The ranker is a stage: without it the result set is still correct.
  //
  // What keeps that from being a silent default is the header. Every response names which of the
  // five paths ran, so "these are not ranked" is one curl away rather than something you notice
  // on stage.
  return json(hits, 200, {
    "x-ranker": searchOrigin && !embeddingOrigin ? "vectorize-ranker-unreachable" : "vectorize",
  });
}

/**
 * A 768-dim SigLIP 2 query vector, or null when no embedder is reachable.
 *
 * Workers AI has no SigLIP or CLIP model, so this cannot be done at the edge. It has to come
 * from the dedicated CPU encoder, whose text tower shares the vision tower's space. Returning
 * null rather than a zero vector matters: a zero vector would return arbitrary nearest
 * neighbours that look like real results.
 */
async function queryEmbedding(env: Env, body: SearchBody): Promise<Embedding | null> {
  if (!body.text && !body.imageKey) return null;
  try {
    return await embedInput(env, { text: body.text, imageKey: body.imageKey });
  } catch {
    return null;
  }
}

async function d1Search(env: Env, body: SearchBody, limit: number, origin: string) {
  // Same filter as listObjects (store.ts), so the phone's fallback path returns the same rows as
  // its primary one.
  const where: string[] = ["state != 'failed'"];
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
  if (!placements && body.versionId) {
    placements = (await getVersion(env, body.versionId)).placements;
  }
  // The headset sends `{roomId}` alone. ceiling: "the current layout" means the newest version;
  // a room with no versions checks an empty layout, which is correctly ok:true.
  placements ??= (await latestVersion(env, roomId))?.placements ?? [];

  // services/fit is stateless: it needs each placed object's box inlined, or it 422s.
  const objs = await getObjects(env, [...new Set(placements.map((p) => p.objectId))], origin);
  const objects = Object.fromEntries(objs.map((o) => [o.objectId, o.bboxMeters]));

  const report = await callUpstream<FitReportV1>(env, "solver", "/fit", {
    schemaVersion: SCHEMA_VERSION,
    room,
    placements,
    objects,
  });
  await emitToRoom(env, roomId, "fit", report);
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

/**
 * POST /v1/ingest  { merchant, storefront, collection?, browserbase?, llm?, vlm? }
 *   -> 202 { workflowId, merchant, storefront }
 *
 * The deterministic ingest trigger. IngestMerchantWorkflow's only other caller is
 * ScoutAgent.toolIngest, i.e. an LLM tool loop, so an unattended multi-merchant run had no entry
 * point in the Worker at all. Token-gated like /v1/catalog/ingest: this spends someone else's
 * bandwidth. Not in contracts.md yet; see workers/DEPLOY.md "Schema proposals".
 */
export async function postIngestMerchant(req: Request, env: Env): Promise<Response> {
  if (!env.UPSTREAM_TOKEN || req.headers.get("x-upstream-token") !== env.UPSTREAM_TOKEN) {
    throw new HttpError(401, "unauthorized", "A valid X-Upstream-Token is required.");
  }
  const body = await readJson<{
    merchant: string; storefront: string; collection?: string | null;
    browserbase?: boolean; llm?: boolean; vlm?: boolean;
  }>(req);
  const merchant = required(body.merchant, "merchant");
  const storefront = required(body.storefront, "storefront");
  if (!storefront.startsWith("https://")) {
    throw new HttpError(422, "bad_storefront", `storefront must be an https URL, got ${storefront}.`);
  }
  const instance = await env.INGEST_MERCHANT.create({
    params: {
      merchant, storefront, collection: body.collection ?? null,
      browserbase: body.browserbase ?? false, llm: body.llm ?? false, vlm: body.vlm ?? false,
    },
  });
  return json({ workflowId: instance.id, merchant, storefront }, 202);
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
  const [solver, search, ingest, embedding, fingerprint] = await Promise.all([
    env.CONFIG.get("upstream:solver"),
    env.CONFIG.get("upstream:search"),
    env.CONFIG.get("upstream:ingest"),
    env.CONFIG.get("upstream:embedding"),
    env.CONFIG.get("embedding:fingerprint"),
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
      embedding: embedding ?? null,
    },
    embeddingFingerprint: fingerprint ?? null,
    meshPipeline: {
      revision: "sequential-v1",
      providerConfigured: Boolean(env.BASETEN_URL && env.BASETEN_API_KEY),
      concurrency: 1,
      intake: "/v1/catalog/ingest",
      dispatch: "D1 outbox -> Cloudflare Queue -> MeshDispatcher -> GenerateMeshWorkflow",
    },
    secrets: {
      UPSTREAM_TOKEN: Boolean(env.UPSTREAM_TOKEN),
      BASETEN_URL: Boolean(env.BASETEN_URL),
      BASETEN_API_KEY: Boolean(env.BASETEN_API_KEY),
      EMBEDDING_API_KEY: Boolean(env.EMBEDDING_API_KEY),
    },
    notes: [
      "upstream:solver unset -> POST /v1/fit AND POST /v1/solve both return 503 (one service answers both).",
      "Missing Baseten secrets -> accepted mesh jobs wait durably. A configured URL must serve the dimension-binding adapter, not raw SF3D.",
      "Vector search requires upstream:embedding, embedding:fingerprint, and EMBEDDING_API_KEY.",
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
