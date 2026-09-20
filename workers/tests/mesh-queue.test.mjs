import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript," + encodeURIComponent(
    "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }"), shortCircuit: true };
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { MeshDispatcher } = await import("../src/agents/mesh-dispatcher.ts");
const { consumeMeshJobs } = await import("../src/lib/queue.ts");
const { normalizeCatalogItem, postCatalogIngest } = await import("../src/lib/catalog-ingest.ts");
const { enqueueMesh, relayMeshOutbox } = await import("../src/lib/mesh-dispatch.ts");

function fixture() {
  const records = new Map();
  let alarm = null;
  const storage = {
    get: async key => records.get(key), put: async (key, value) => records.set(key, value),
    delete: async key => records.delete(key),
    getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
    transaction: async fn => fn(storage),
    list: async ({ prefix, limit }) => new Map([...records].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
  };
  const states = new Map(), started = [], sql = [];
  const env = { BASETEN_URL: "https://generation.example", BASETEN_API_KEY: "test",
    DB: { prepare(query) { return { bind(...args) { sql.push([query, args]); return this; }, run: async () => ({ success: true }) }; } },
    GENERATE_MESH: {
      create: async ({ id }) => { if (states.has(id)) throw Error("already exists"); started.push(id); states.set(id, "running"); },
      get: async id => ({ status: async () => { if (!states.has(id)) throw Error("not found"); return { status: states.get(id) }; } }),
    },
  };
  const dispatcher = new MeshDispatcher({ storage }, env);
  env.MESH_DISPATCHER = { idFromName: name => name, get: () => ({ fetch: (url, init) => dispatcher.fetch(new Request(url, init)) }) };
  const enqueue = params => dispatcher.fetch(new Request("https://dispatcher/enqueue", { method: "POST", body: JSON.stringify(params) }));
  return { env, records, states, started, sql, dispatcher, enqueue, getAlarm: () => alarm };
}
const params = id => ({ jobId: id, objectId: id, tier: "live", apiOrigin: "https://worker.example", roomId: null });

test("one workflow stays active across alarms, retries, and duplicate queue deliveries", async () => {
  const f = fixture();
  await f.enqueue(params("a")); await f.enqueue(params("b")); await f.enqueue(params("a"));
  await f.dispatcher.alarm(); await f.dispatcher.alarm();
  assert.deepEqual(f.started, ["a"]);
  f.states.set("a", "waiting"); await f.dispatcher.alarm();
  assert.deepEqual(f.started, ["a"]);
  f.states.set("a", "complete"); await f.dispatcher.alarm();
  assert.deepEqual(f.started, ["a", "b"]);
  f.states.set("b", "complete"); await f.dispatcher.alarm();
  await f.enqueue(params("a")); await f.dispatcher.alarm();
  assert.deepEqual(f.started, ["a", "b"]);
});

test("workflow creation response loss is reconciled without starting a second job", async () => {
  const f = fixture();
  const create = f.env.GENERATE_MESH.create;
  f.env.GENERATE_MESH.create = async arg => { await create(arg); throw Error("response lost"); };
  await f.enqueue(params("a")); await f.enqueue(params("b"));
  await f.dispatcher.alarm(); await f.dispatcher.alarm();
  assert.deepEqual(f.started, ["a"]);
  assert.equal(f.records.get("active").jobId, "a");
});

test("failed workflows release the slot and update job state", async () => {
  const f = fixture(); await f.enqueue(params("a")); await f.enqueue(params("b"));
  await f.dispatcher.alarm(); f.states.set("a", "errored"); await f.dispatcher.alarm();
  assert.deepEqual(f.started, ["a", "b"]);
  assert.ok(f.sql.some(([query, args]) => query.includes("UPDATE jobs") && args.includes("a")));
});

test("unconfigured provider retains accepted work and starts when configuration arrives", async () => {
  const f = fixture(); delete f.env.BASETEN_API_KEY;
  await f.enqueue(params("a")); await f.dispatcher.alarm();
  assert.deepEqual(f.started, []);
  f.env.BASETEN_API_KEY = "test"; await f.dispatcher.alarm();
  assert.deepEqual(f.started, ["a"]);
});

test("queue acknowledges only after durable admission; failures retry", async () => {
  const f = fixture(); let ack = 0, retry = 0;
  const message = { id: "delivery", body: params("a"), ack: () => ack++, retry: () => retry++ };
  await consumeMeshJobs({ queue: "test", messages: [message] }, f.env);
  assert.equal(ack, 1); assert.equal(retry, 0); assert.deepEqual(f.started, ["a"]);
  f.env.MESH_DISPATCHER.get = () => ({ fetch: async () => new Response(null, { status: 503 }) });
  await consumeMeshJobs({ queue: "test", messages: [message] }, f.env);
  assert.equal(ack, 1); assert.equal(retry, 1);
});

test("outbox atomically persists job and payload without depending on Queue availability", async () => {
  let statements;
  const env = { DB: { prepare: query => ({ bind: (...args) => ({ query, args }) }), batch: async rows => { statements = rows; } } };
  await enqueueMesh(env, params("a"));
  assert.equal(statements.length, 2);
  assert.match(statements[0].query, /INSERT INTO jobs/);
  assert.equal(JSON.parse(statements[1].args[1]).jobId, "a");
});

test("outbox watchdog republishes unacknowledged work and wakes durable dispatcher", async () => {
  const f = fixture(), sent = [];
  f.env.DB.prepare = () => ({ all: async () => ({ results: [{ params_json: JSON.stringify(params("a")) }] }) });
  f.env.JOB_QUEUE = { sendBatch: async batch => sent.push(...batch.map(row => row.body)) };
  await relayMeshOutbox(f.env); await relayMeshOutbox(f.env);
  assert.deepEqual(sent.map(p => p.jobId), ["a", "a"]);
});

test("manifest and extraction objects normalize to the same stable identity", async () => {
  const row = { title: "Chair", productUrl: "https://shop.example/chair", imageUrl: "https://cdn.example/chair.png", bboxMeters: { w: 1, h: 1, d: 1 } };
  const a = await normalizeCatalogItem(row);
  const b = await normalizeCatalogItem({ ...row, objectId: "random-scraper-id", imageUrl: undefined, extraction: { imageUrl: row.imageUrl } });
  assert.equal(a.objectId, b.objectId);
  assert.match(a.objectId, /^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-a[a-f\d]{3}-[a-f\d]{12}$/);
  await assert.rejects(normalizeCatalogItem({ ...row, imageUrl: "http://localhost/image" }), /HTTPS/);
  await assert.rejects(normalizeCatalogItem({ ...row, bboxMeters: { w: 0, h: 1, d: 1 } }), /metres/);
});

test("paid catalogue intake requires the configured ingestion token", async () => {
  await assert.rejects(postCatalogIngest(new Request("https://worker/v1/catalog/ingest", { method: "POST", body: "[]" }), {}, "https://worker"), /X-Upstream-Token/);
});

test("durable acceptance notifies dispatcher at the same fake-clock instant, without cron", async () => {
  const events = [], original = Date.now;
  Date.now = () => 123000;
  try {
    const env = {
      DB: { prepare: () => ({ bind() { return this; }, run: async () => {} }),
        batch: async () => events.push(["durable", Date.now()]) },
      MESH_DISPATCHER: { idFromName: x => x, get: () => ({ fetch: async () => {
        events.push(["notified", Date.now()]); return new Response();
      } }) },
    };
    await enqueueMesh(env, params("live"));
    assert.deepEqual(events, [["durable", 123000], ["notified", 123000]]);
    env.DB.batch = async () => { throw Error("D1 failed"); };
    await assert.rejects(enqueueMesh(env, params("failed")));
    assert.equal(events.length, 2);
  } finally { Date.now = original; }
});

test("live requests pass queued catalog work; concurrent notifications preserve one slot", async () => {
  const f = fixture();
  await f.enqueue(params("active"));
  await Promise.all([f.enqueue({ ...params("catalog"), catalog: {} }), f.enqueue(params("live"))]);
  assert.deepEqual(f.started, ["active"]);
  f.states.set("active", "complete");
  await f.dispatcher.fetch(new Request("https://dispatcher/complete", {
    method: "POST", body: JSON.stringify({ jobId: "active" }),
  }));
  assert.deepEqual(f.started, ["active", "live"]);
});

test("completion callback never releases a still-running prediction", async () => {
  const f = fixture(), original = Date.now;
  Date.now = () => 1000;
  try {
    await f.enqueue(params("a")); await f.enqueue(params("b"));
    await f.dispatcher.fetch(new Request("https://dispatcher/complete", {
      method: "POST", body: JSON.stringify({ jobId: "a" }),
    }));
    assert.deepEqual(f.started, ["a"]);
    assert.equal(f.getAlarm(), 1250);
    f.states.set("a", "complete");
    await f.dispatcher.alarm();
    assert.deepEqual(f.started, ["a", "b"]);
  } finally { Date.now = original; }
});
