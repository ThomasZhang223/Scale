import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Node 24 strips TypeScript; resolve the Worker's bundler-style local imports.
registerHooks({ resolve(specifier, context, next) {
  const stubs = {
    "cloudflare:workers": "export class WorkflowEntrypoint { constructor(_ctx, env) { this.env = env; } }",
    "cloudflare:workflows": "export class NonRetryableError extends Error {}",
    "agents": "export function getAgentByName(namespace) { return namespace.stub; }",
  };
  if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { embedInput, indexObject } = await import("../src/lib/embedding.ts");
const { consumeMeshJobs } = await import("../src/lib/queue.ts");
const { GenerateMeshWorkflow } = await import("../src/workflows/generate-mesh.ts");
const { postSearch, postGenerate, postObjectMesh, postObjectIndex, postUpload } = await import("../src/routes/index.ts");
const fingerprint = "a".repeat(64);
const vector = { values: Array(768).fill(1 / Math.sqrt(768)), dimension: 768,
  fingerprint, inputHash: "b".repeat(64), modality: "text" };
function environment() {
  return { EMBEDDING_API_KEY: "test", CONFIG: { get: async key => ({
    "embedding:fingerprint": fingerprint, "upstream:embedding": "https://encoder.example/",
  })[key] } };
}

test("text uses dedicated endpoint, Bearer auth and expected fingerprint", async t => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://encoder.example/embed");
    assert.equal(init.headers.authorization, "Bearer test");
    assert.deepEqual(JSON.parse(init.body), { text: "chair", expectedFingerprint: fingerprint });
    return Response.json(vector);
  });
  assert.deepEqual(await embedInput(environment(), { text: "chair" }), vector);
});

test("R2 frames are passed inline without exposing storage credentials", async t => {
  const env = environment();
  env.BUCKET = { get: async key => {
    assert.equal(key, "objects/id/frames/0.jpg");
    return { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  } };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { imageBase64: "AQID", expectedFingerprint: fingerprint });
    return Response.json({ ...vector, modality: "image" });
  });
  assert.equal((await embedInput(env, { imageKey: "objects/id/frames/0.jpg" })).modality, "image");
});

test("invalid vectors, fingerprints and ambiguous requests are rejected", async t => {
  for (const bad of [{ dimension: 767 }, { fingerprint: "c".repeat(64) },
    { values: Array(768).fill(0) }, { values: [1] }, { modality: "image" }]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ ...vector, ...bad }));
    await assert.rejects(embedInput(environment(), { text: "chair" }), /Invalid embedding/);
    mock.mock.restore();
  }
  await assert.rejects(embedInput(environment(), { text: "chair", imageKey: "x" }), /exactly one/);
});

test("oversized and missing R2 images do not call the encoder", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw Error("must not fetch"); });
  const env = environment();
  let cancelled = false;
  env.BUCKET = { get: async () => ({ size: 11 * 1024 * 1024, body: { cancel: async () => { cancelled = true; } } }) };
  await assert.rejects(embedInput(env, { imageKey: "objects/id/frames/0.jpg" }), /10 MiB/);
  assert.equal(cancelled, true);
  env.BUCKET.get = async () => null;
  await assert.rejects(embedInput(env, { imageKey: "objects/id/frames/0.jpg" }), /not found/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("queue redelivery reuses job and durable admission without resetting job state", async () => {
  const rows = new Map(), admitted = new Map();
  let acks = 0, retries = 0;
  const message = { id: "same-delivery", body: { objectId: "object", tier: "live", apiOrigin: "https://api.example" },
    ack: () => acks++, retry: () => retries++ };
  const env = { DB: { prepare: sql => {
    if (sql.startsWith("UPDATE mesh_outbox")) return { bind: () => ({ run: async () => {} }) };
    assert.match(sql, /ON CONFLICT\(id\) DO NOTHING/);
    return { bind: id => ({ run: async () => { if (!rows.has(id)) rows.set(id, "queued"); } }) };
  } }, MESH_DISPATCHER: { idFromName: name => name, get: () => ({ fetch: async (_url, init) => {
    const params = JSON.parse(init.body); admitted.set(params.jobId, params);
    return Response.json({ accepted: true });
  } }) } };
  const batch = { queue: "jobs", messages: [message] };
  await consumeMeshJobs(batch, env);
  const id = [...rows.keys()][0];
  rows.set(id, "running");
  await consumeMeshJobs(batch, env);
  assert.equal(rows.size, 1);
  assert.equal(admitted.size, 1);
  assert.equal(rows.get(id), "running");
  assert.equal(acks, 2);
  assert.equal(retries, 0);
  env.MESH_DISPATCHER.get = () => { throw Error("unavailable"); };
  await consumeMeshJobs(batch, env);
  assert.equal(retries, 1);
});

function pipelineEnvironment() {
  const env = environment();
  const row = { id: "object", source: "catalog", state: "measured", name: "chair",
    category: "chair", bbox_w: 0.7, bbox_h: 1, bbox_d: 0.6 };
  const writes = [];
  env.DB = { prepare: sql => ({ bind: (...args) => ({
    first: async () => row, all: async () => ({ results: [row] }),
    run: async () => { writes.push({ sql, args }); },
  }) }) };
  env.BUCKET = {
    list: async () => ({ objects: [{ key: "objects/object/frames/0.jpg" }] }),
    head: async () => ({ size: 12 }),
    get: async key => {
      if (key.endsWith("mesh.glb")) {
        const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
        view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, 20, true);
        return { size: 20, arrayBuffer: async () => bytes.buffer };
      }
      return { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    },
  };
  return { env, row, writes };
}

test("mesh workflow publishes D1 ready before indexing a catalog image", async t => {
  const { env, writes } = pipelineEnvironment();
  env.BASETEN_URL = "https://gpu.example/predict";
  const indexed = [];
  env.OBJECTS_INDEX = { upsert: async vectors => {
    assert.equal(writes.some(w => w.sql.includes("state = 'ready'")), true);
    indexed.push(...vectors);
    return { mutationId: "async-index-write" };
  } };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === env.BASETEN_URL) {
      assert.equal(JSON.parse(init.body).want_embedding, false);
      return Response.json({ glbKey: "objects/object/mesh.glb" });
    }
    assert.equal(url, "https://encoder.example/embed");
    return Response.json({ ...vector, modality: "image" });
  });
  const workflow = new GenerateMeshWorkflow({}, env);
  const result = await workflow.run({ payload: { jobId: "job", objectId: "object", tier: "quality",
    apiOrigin: "https://api.example", roomId: null } }, { do: async (...args) => args.at(-1)() });
  assert.equal(result.objectId, "object");
  assert.equal(indexed[0].namespace, fingerprint);
  assert.equal(indexed[0].metadata.source, "catalog");
  assert.equal(indexed[0].metadata.w_mm, 700);
  assert.ok(writes.some(w => w.sql.includes("state = 'ready'")));
  assert.ok(writes.some(w => w.sql.includes("UPDATE jobs") && w.args[0] === "done"));
});

test("search uses Vectorize namespace and hydrates D1 even if local ranker is configured", async t => {
  const { env } = pipelineEnvironment();
  const originalGet = env.CONFIG.get;
  env.CONFIG.get = key => key === "upstream:search" ? "https://ranker.example" : originalGet(key);
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "https://encoder.example/embed");
    return Response.json(vector);
  });
  env.OBJECTS_INDEX = { query: async (values, options) => {
    assert.deepEqual(values, vector.values);
    assert.equal(options.namespace, fingerprint);
    assert.deepEqual(options.filter, { w_mm: { $lte: 800 }, source: "catalog" });
    return { matches: [{ id: "object", score: 0.9 }] };
  } };
  const response = await postSearch(new Request("https://api.example/v1/search", {
    method: "POST", body: JSON.stringify({ text: "chair", fit: { maxW: 0.8 }, source: "catalog" }),
  }), env, "https://api.example");
  assert.equal(response.headers.get("x-ranker"), "vectorize");
  assert.equal((await response.json())[0].object.name, "chair");
});

test("catalog live jobs use the durable outbox and retain the API job ID", async () => {
  const { env } = pipelineEnvironment();
  let queued;
  const prepare = env.DB.prepare;
  env.DB.prepare = sql => sql.startsWith("INSERT INTO mesh_outbox")
    ? { bind: (_id, params) => ({ run: async () => { queued = JSON.parse(params); } }) }
    : prepare(sql);
  env.DB.batch = async statements => { for (const statement of statements) await statement.run(); };
  const response = await postGenerate(new Request("https://api.example/v1/objects/object/generate", {
    method: "POST", body: JSON.stringify({ tier: "live", roomId: "room" }),
  }), env, "object", "https://api.example");
  assert.equal(queued.jobId, (await response.json()).jobId);
  assert.equal(queued.roomId, "room");
  let admitted;
  env.MESH_DISPATCHER = { idFromName: name => name, get: () => ({ fetch: async (_url, init) => {
    admitted = JSON.parse(init.body); return Response.json({ accepted: true });
  } }) };
  await consumeMeshJobs({ queue: "jobs", messages: [{ id: "delivery", body: queued,
    ack() {}, retry() { assert.fail("unexpected retry"); } }] }, env);
  assert.equal(admitted.jobId, queued.jobId);
  assert.equal(admitted.roomId, "room");
});

test("large inline GLB is saved before checkpointing, and an encoder outage keeps the mesh ready", async t => {
  const { env, writes } = pipelineEnvironment();
  env.BASETEN_URL = "https://gpu.example/predict";
  const bytes = new Uint8Array(2 * 1024 * 1024);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  const stored = new Map();
  env.BUCKET.put = async (key, value) => stored.set(key, value);
  t.mock.method(globalThis, "fetch", async url => url === env.BASETEN_URL
    ? Response.json({ glbBase64: Buffer.from(bytes).toString("base64") }) : new Response("unavailable", { status: 503 }));
  const workflow = new GenerateMeshWorkflow({}, env);
  const result = await workflow.run({ payload: { jobId: "job", objectId: "object", tier: "live", apiOrigin: "https://api.example", roomId: null } }, {
    do: async (...args) => {
      const value = await args.at(-1)();
      assert.ok(JSON.stringify(value).length < 1024 * 1024, `${args[0]} exceeded checkpoint limit`);
      if (args[0] === "baseten-generate") assert.equal(stored.get("objects/object/mesh.glb").length, bytes.length);
      return value;
    },
  });
  assert.equal(result.glbKey, "objects/object/mesh.glb");
  assert.ok(writes.some(w => w.sql.includes("UPDATE jobs") && w.args[0] === "done" && w.args[2]?.includes("embedding failed")));
});

test("raw SF3D responses fail explicitly and cannot mark an object ready", async t => {
  const { env, writes } = pipelineEnvironment(); env.BASETEN_URL = "https://gpu.example/predict";
  t.mock.method(globalThis, "fetch", async () => Response.json({ kind: "raw_sf3d_unscaled", glb_base64: "invalid" }));
  await assert.rejects(new GenerateMeshWorkflow({}, env).run({ payload: { jobId: "job", objectId: "object", tier: "live", apiOrigin: "https://api.example", roomId: null } },
    { do: async (...args) => args.at(-1)() }), /raw SF3D/);
  assert.equal(writes.some(w => w.sql.includes("state = 'ready'")), false);
});


test("stored mesh and ready notification are visible while indexing is blocked", async t => {
  const { env, writes } = pipelineEnvironment();
  env.BASETEN_URL = "https://gpu.example/predict";
  let release, enter, notified = false, validated = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  const get = env.BUCKET.get;
  env.BUCKET.get = async key => {
    const result = await get(key);
    if (key.endsWith("mesh.glb")) validated = true;
    return result;
  };
  env.ROOM_AGENT = { stub: { fetch: async () => {
    assert.equal(validated, true);
    assert.ok(writes.some(w => w.sql.includes("state = 'ready'")));
    notified = true; return Response.json({ delivered: 1 });
  } } };
  t.mock.method(globalThis, "fetch", async url => {
    if (url === env.BASETEN_URL) return Response.json({ glbKey: "objects/object/mesh.glb" });
    enter(); await blocked;
    throw Error("encoder outage");
  });
  const run = new GenerateMeshWorkflow({}, env).run({ payload: {
    jobId: "job", objectId: "object", tier: "live", apiOrigin: "https://api.example", roomId: "room",
  } }, { do: async (...args) => args.at(-1)() });
  await entered;
  assert.equal(notified, true);
  assert.ok(writes.some(w => w.sql.includes("UPDATE jobs") && w.args[0] === "done"));
  release(); await run;
  assert.equal(writes.some(w => w.sql.includes("state = 'failed'")), false);
});

test("missing stored GLB cannot publish ready or start indexing", async t => {
  const { env, writes } = pipelineEnvironment();
  env.BASETEN_URL = "https://gpu.example/predict";
  env.BUCKET.get = async () => null;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++; return Response.json({ glbKey: "objects/object/mesh.glb" });
  });
  await assert.rejects(new GenerateMeshWorkflow({}, env).run({ payload: {
    jobId: "job", objectId: "object", tier: "live", apiOrigin: "https://api.example", roomId: null,
  } }, { do: async (...args) => args.at(-1)() }), /nothing is stored/);
  assert.equal(calls, 1);
  assert.equal(writes.some(w => w.sql.includes("state = 'ready'")), false);
});

// --- Phone-scanned GLB: scans/ key and the magic check -----------------------------------------

function glbBytes(length = 20, declared = length) {
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, declared, true);
  return bytes;
}

function scanEnvironment(stored) {
  const { env, row, writes } = pipelineEnvironment();
  Object.assign(row, { id: "scan-1", source: "scan", state: "measured", name: "walnut side table", category: "table" });
  env.BUCKET = {
    head: async () => stored ? { size: stored.length } : null,
    get: async (_key, options) => ({ arrayBuffer: async () =>
      stored.slice(options.range.offset, options.range.offset + options.range.length).buffer }),
  };
  return { env, writes };
}

// ExecutionContext double: the background work waitUntil receives is kept so a test can await it.
function context() {
  const pending = [];
  return { ctx: { waitUntil: promise => { pending.push(promise); } }, settle: () => Promise.all(pending) };
}

const scanRequest = key => new Request("https://api.example/v1/objects/scan-1/mesh", {
  method: "POST", body: JSON.stringify({ key }),
});

test("scanMesh upload kind grants a scans/ key and the error names it", async () => {
  const env = { CONFIG: { put: async () => {} } };
  const grant = await (await postUpload(new Request("https://api.example/v1/uploads", {
    method: "POST", body: JSON.stringify({ kind: "scanMesh", objectId: "scan-1" }),
  }), env, "https://api.example")).json();
  assert.equal(grant.key, "scans/scan-1/mesh.glb");
  await assert.rejects(postUpload(new Request("https://api.example/v1/uploads", {
    method: "POST", body: JSON.stringify({ kind: "nope" }),
  }), env, "https://api.example"), /scanMesh/);
});

test("postObjectMesh accepts only the scans/ key", async () => {
  const { env, writes } = scanEnvironment(glbBytes());
  await assert.rejects(postObjectMesh(scanRequest("objects/scan-1/mesh.glb"), env, "scan-1", "https://api.example", context().ctx),
    error => error.code === "bad_mesh_key");
  assert.equal(writes.some(w => w.sql.includes("state = 'ready'")), false);
});

test("garbage bytes at the scan key return not_a_glb and never flip the row to ready", async () => {
  for (const stored of [new TextEncoder().encode("<html>error page</html>"), glbBytes(20, 99), new Uint8Array(8)]) {
    const { env, writes } = scanEnvironment(stored);
    await assert.rejects(postObjectMesh(scanRequest("scans/scan-1/mesh.glb"), env, "scan-1", "https://api.example", context().ctx),
      error => error.code === "not_a_glb" && error.status === 422);
    assert.equal(writes.some(w => w.sql.includes("state = 'ready'")), false);
  }
});

test("a valid GLB at the scan key flips the row to ready with that glb_key", async t => {
  const { env, writes } = scanEnvironment(glbBytes());
  env.OBJECTS_INDEX = { upsert: async () => {} };
  t.mock.method(globalThis, "fetch", async () => Response.json(vector));
  const { ctx, settle } = context();
  const response = await postObjectMesh(scanRequest("scans/scan-1/mesh.glb"), env, "scan-1", "https://api.example", ctx);
  assert.equal(response.status, 200);
  await settle();
  const ready = writes.find(w => w.sql.includes("state = 'ready'"));
  assert.equal(ready.args[0], "scans/scan-1/mesh.glb");
});

// --- One indexer -------------------------------------------------------------------------------

test("embedInput admits catalogue source keys and still refuses every other key", async t => {
  const env = environment();
  env.BUCKET = { get: async () => ({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) };
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...vector, modality: "image" }));
  for (const good of ["catalog/Floyd_Home/9246282842274/source.jpg", "catalog/Poly___Bark/1/source.png",
    "objects/id/frames/0.jpg"]) {
    assert.equal((await embedInput(env, { imageKey: good })).modality, "image");
  }
  for (const bad of ["catalog/a/b/other.jpg", "catalog/a/source.jpg", "scans/id/mesh.glb", "objects/id/mesh.glb",
    "rooms/id/capture.json", "catalog/a/b/c/source.jpg"]) {
    await assert.rejects(embedInput(env, { imageKey: bad }), /Expected an object frame or catalogue source key/);
  }
});

test("indexObject upserts one vector in millimetres under the fingerprint namespace", async t => {
  const env = environment();
  const upserts = [];
  env.OBJECTS_INDEX = { upsert: async vectors => { upserts.push(...vectors); } };
  t.mock.method(globalThis, "fetch", async () => Response.json(vector));
  const result = await indexObject(env, { objectId: "o", source: "scan", category: "table",
    bboxMeters: { w: 0.5, h: 0.75, d: 0.25 }, text: "walnut table" });
  assert.deepEqual(result, { fingerprint, modality: "text" });
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].id, "o");
  assert.equal(upserts[0].namespace, fingerprint);
  assert.deepEqual(upserts[0].metadata, { objectId: "o", source: "scan", category: "table",
    w_mm: 500, h_mm: 750, d_mm: 250, dominant_hex: "#000000" });
});

test("postObjectMesh answers x-indexed pending and indexes in the background, not in the request", async t => {
  const { env } = scanEnvironment(glbBytes());
  const upserts = [];
  env.OBJECTS_INDEX = { upsert: async vectors => { upserts.push(...vectors); } };
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async () => { await held; return Response.json(vector); });
  const { ctx, settle } = context();
  const response = await postObjectMesh(scanRequest("scans/scan-1/mesh.glb"), env, "scan-1", "https://api.example", ctx);
  assert.equal(response.headers.get("x-indexed"), "pending");
  assert.equal(upserts.length, 0, "the response must not wait for the embed");
  release(); await settle();
  assert.equal(upserts[0].id, "scan-1");
  assert.equal(upserts[0].metadata.source, "scan");
});

test("a background embed failure never fails the scan save", async t => {
  const { env, writes } = scanEnvironment(glbBytes());
  env.OBJECTS_INDEX = { upsert: async () => {} };
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response("down", { status: 503 }));
  const { ctx, settle } = context();
  const response = await postObjectMesh(scanRequest("scans/scan-1/mesh.glb"), env, "scan-1", "https://api.example", ctx);
  assert.equal(response.status, 200);
  await settle();
  assert.ok(writes.some(w => w.sql.includes("state = 'ready'")));
});

test("a scan with no embeddable text is saved and reports why it is not searchable", async t => {
  for (const [name, category] of [["", ""], ["unknown", "unknown"], ["", "unknown"]]) {
    const { env, writes } = scanEnvironment(glbBytes());
    const row = (await env.DB.prepare("").bind().first());
    Object.assign(row, { name, category });
    t.mock.method(globalThis, "fetch", async () => { throw Error("must not embed"); });
    const { ctx } = context();
    const response = await postObjectMesh(scanRequest("scans/scan-1/mesh.glb"), env, "scan-1", "https://api.example", ctx);
    assert.equal(response.headers.get("x-indexed"), "false");
    assert.equal(response.headers.get("x-index-skipped"), "no-embeddable-text");
    assert.ok(writes.some(w => w.sql.includes("state = 'ready'")));
    t.mock.restoreAll();
  }
});

test("postObjectIndex needs the upstream token, then indexes the image at the given key", async t => {
  const { env } = pipelineEnvironment();
  env.UPSTREAM_TOKEN = "secret";
  const upserts = [];
  env.OBJECTS_INDEX = { upsert: async vectors => { upserts.push(...vectors); } };
  env.BUCKET.get = async key => {
    assert.equal(key, "catalog/Floyd_Home/1/source.jpg");
    return { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...vector, modality: "image" }));
  const call = (headers, body) => postObjectIndex(new Request("https://api.example/v1/objects/object/index", {
    method: "POST", headers, body: JSON.stringify(body) }), env, "object", "https://api.example");
  await assert.rejects(call({}, { imageKey: "catalog/Floyd_Home/1/source.jpg" }), error => error.status === 401);
  await assert.rejects(call({ "x-upstream-token": "wrong" }, { text: "x" }), error => error.status === 401);
  await assert.rejects(call({ "x-upstream-token": "secret" }, { text: "x", imageKey: "y" }), error => error.code === "bad_index_input");
  await assert.rejects(call({ "x-upstream-token": "secret" }, {}), error => error.code === "bad_index_input");
  assert.equal(upserts.length, 0);
  const response = await call({ "x-upstream-token": "secret" }, { imageKey: "catalog/Floyd_Home/1/source.jpg" });
  assert.deepEqual(await response.json(), { objectId: "object", fingerprint, modality: "image" });
  assert.equal(upserts[0].id, "object");
  assert.equal(upserts[0].metadata.source, "catalog");
});
