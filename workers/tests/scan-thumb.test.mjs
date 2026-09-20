import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript," + encodeURIComponent(
    "export class DurableObject {}\nexport class WorkflowEntrypoint {}"), shortCircuit: true };
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { renderOrigin, renderThumbJpeg, runThumbJob, runScanThumbJobs, enqueueScanThumb,
        thumbHealth, browserSecondsToday, MAX_ATTEMPTS } = await import("../src/lib/scan-thumb.ts");

const OBJECT_ID = "11111111-2222-4333-8444-555555555555";
const FINGERPRINT = "a".repeat(64);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/**
 * One scan_thumb_jobs row, in memory, plus the objects row the step reads.
 *
 * The statements are matched on a distinctive fragment rather than parsed: this fake exists to
 * prove the state machine (claim, backoff, bounded retries, done), and a SQL parser here would
 * be a second implementation of D1 to keep correct.
 */
function fakeEnv(over = {}) {
  const job = over.job === undefined
    ? { object_id: OBJECT_ID, state: "pending", attempts: 0, error: null,
        next_attempt_at: null, lease_until: null,
        created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" }
    : over.job;
  const objectRow = {
    id: OBJECT_ID, source: "scan", state: "ready", name: "Captured object", category: "unknown",
    glb_key: `scans/${OBJECT_ID}/mesh.glb`, bbox_w: 0.8, bbox_h: 1.1, bbox_d: 0.8,
    measure_method: "measured", measure_confidence: 1, caption: null, palette_json: null,
    price_cents: null, currency: null, product_url: null, merchant: null,
    created_at: "2026-09-20T00:00:00.000Z", ...(over.objectRow ?? {}),
  };
  const calls = { browser: 0, index: [], put: [], sql: [] };
  const state = { job, browserSeconds: over.browserSeconds ?? 0 };
  const due = (row, at) =>
    row && row.state === "pending"
    && (row.next_attempt_at === null || row.next_attempt_at <= at)
    && (row.lease_until === null || row.lease_until <= at);

  const env = {
    RENDER_ORIGIN: over.RENDER_ORIGIN ?? "https://xr.example",
    API_ORIGIN: "https://api.example",
    EMBEDDING_API_KEY: "test",
    CONFIG: { get: async (key) => ({
      "embedding:fingerprint": FINGERPRINT,
      "upstream:embedding": over.embeddingOrigin === undefined ? "https://encoder.example" : over.embeddingOrigin,
    })[key] ?? null },
    BUCKET: {
      head: async () => (over.thumbExists ? { size: 100 } : null),
      put: async (key, bytes) => { calls.put.push({ key, size: bytes.byteLength }); },
      get: async () => ({ size: JPEG.byteLength, arrayBuffer: async () => JPEG.buffer }),
    },
    OBJECTS_INDEX: { upsert: async (vectors) => { calls.index.push(vectors[0]); } },
    BROWSER: { quickAction: async (action, options) => {
      calls.browser += 1;
      calls.lastAction = { action, options };
      return over.browser ? over.browser(action, options)
        : new Response(JPEG, { status: 200, headers: { "x-browser-ms-used": "900" } });
    } },
    DB: { prepare: (sql) => {
      const statement = (binds) => ({
      run: async () => {
        calls.sql.push(sql.trim().split("\n")[0]);
        if (sql.includes("INSERT INTO browser_budget")) {
          state.browserSeconds += binds[1];
          return { meta: { changes: 1 } };
        }
        if (sql.includes("next_attempt_at = ?, lease_until = NULL") && sql.includes("state = 'pending'")) {
          state.job = { ...state.job, error: binds[0], next_attempt_at: binds[1], lease_until: null, updated_at: binds[2] };
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO scan_thumb_jobs")) {
          if (!state.job) state.job = { object_id: binds[0], state: "pending", attempts: 0,
            error: null, next_attempt_at: null, lease_until: null,
            created_at: binds[1], updated_at: binds[2] };
          return { meta: { changes: 1 } };
        }
        if (sql.includes("attempts = attempts + 1")) {
          const [lease, at, id, dueAt] = binds;
          if (!due(state.job, dueAt) || state.job.object_id !== id) return { meta: { changes: 0 } };
          state.job = { ...state.job, attempts: state.job.attempts + 1, lease_until: lease, updated_at: at };
          return { meta: { changes: 1 } };
        }
        if (sql.includes("state = 'done'")) {
          state.job = { ...state.job, state: "done", error: null, lease_until: null, updated_at: binds[0] };
          return { meta: { changes: 1 } };
        }
        if (sql.includes("state = 'failed'")) {
          state.job = { ...state.job, state: "failed", error: binds[0], lease_until: null,
            next_attempt_at: null, updated_at: binds[1] };
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET error = ?")) {
          state.job = { ...state.job, error: binds[0], lease_until: null,
            next_attempt_at: binds[1], updated_at: binds[2] };
          return { meta: { changes: 1 } };
        }
        throw new Error(`unhandled run: ${sql}`);
      },
      first: async () => {
        if (sql.includes("FROM browser_budget")) return { seconds: state.browserSeconds };
        if (sql.includes("FROM objects")) return objectRow;
        if (sql.includes("SELECT object_id FROM scan_thumb_jobs")) {
          return due(state.job, binds[0]) ? { object_id: state.job.object_id } : null;
        }
        if (sql.includes("SELECT * FROM scan_thumb_jobs")) return state.job;
        if (sql.includes("ORDER BY updated_at DESC")) return state.job?.error ? state.job : null;
        throw new Error(`unhandled first: ${sql}`);
      },
      all: async () => ({ results: state.job ? [{ state: state.job.state, n: 1 }] : [] }),
      });
      // Real D1 answers .all()/.first() on a statement with no binds, which thumbHealth uses.
      return { bind: (...binds) => statement(binds), ...statement([]) };
    } },
  };
  return { env, calls, state };
}

test("the render page is opened with the canvas as the completion signal", async () => {
  const { env, calls } = fakeEnv();
  const { bytes, browserMs } = await renderThumbJpeg(env, `scans/${OBJECT_ID}/mesh.glb`);
  assert.deepEqual([...bytes], [...JPEG]);
  assert.equal(browserMs, 900, "the browser states what it charged; the budget is kept from that");
  const { action, options } = calls.lastAction;
  assert.equal(action, "screenshot");
  // /thumb, not /thumb.html: Cloudflare Assets answers the second with a 307.
  assert.equal(options.url,
    `https://xr.example/thumb?glb=${encodeURIComponent(`/v1/assets/scans/${OBJECT_ID}/mesh.glb`)}`);
  assert.deepEqual(options.waitForSelector.selector, "canvas");
  // Shorter than the page's own 25 s timeout on purpose: waiting for it costs browser time and
  // tells us nothing new, and the whole daily budget is ten minutes.
  assert.equal(options.waitForSelector.timeout, 15_000);
  assert.equal(options.selector, "canvas");
  assert.equal(options.screenshotOptions.type, "jpeg");
  assert.deepEqual(options.viewport, { width: 512, height: 512 });
  // A best attempt would answer a failed render with a picture of the empty white page.
  assert.equal(options.bestAttempt, undefined);
  assert.equal(options.cacheTTL, 0);
});

test("an unset or non-https RENDER_ORIGIN names the var instead of guessing one", () => {
  for (const value of [undefined, "", "full-scale-xr.workers.dev", "http://xr.example"]) {
    assert.throws(() => renderOrigin({ RENDER_ORIGIN: value }), /RENDER_ORIGIN/);
  }
  assert.equal(renderOrigin({ RENDER_ORIGIN: "https://xr.example/" }), "https://xr.example");
});

test("a browser error and a non-JPEG body are both failures, not pictures", async () => {
  const rateLimited = fakeEnv({ browser: () => new Response("slow down", { status: 429 }) });
  await assert.rejects(renderThumbJpeg(rateLimited.env, "scans/x/mesh.glb"), /429.*slow down/s);
  // What a selector timeout looks like: the page loaded, the canvas never appeared.
  const timedOut = fakeEnv({ browser: () => new Response(
    JSON.stringify({ errors: [{ message: "waiting for selector `canvas` failed" }] }), { status: 422 }) });
  await assert.rejects(renderThumbJpeg(timedOut.env, "scans/x/mesh.glb"), /waiting for selector/);
  const html = fakeEnv({ browser: () => new Response("<!doctype html>", { status: 200 }) });
  await assert.rejects(renderThumbJpeg(html.env, "scans/x/mesh.glb"), /not a JPEG/);
});

test("attach to searchable: render, store under the scan's own key, image-embed, done", async (t) => {
  const { env, calls, state } = fakeEnv();
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.ok(JSON.parse(init.body).imageBase64, "the encoder is given the picture, not text");
    return Response.json({ values: Array(768).fill(1 / Math.sqrt(768)), dimension: 768,
      fingerprint: FINGERPRINT, inputHash: "b".repeat(64), modality: "image" });
  });
  assert.equal(await runThumbJob(env, OBJECT_ID), "done");
  assert.equal(calls.browser, 1);
  assert.deepEqual(calls.put.map((p) => p.key), [`scans/${OBJECT_ID}/thumb.jpg`]);
  assert.equal(calls.index[0].id, OBJECT_ID);
  assert.equal(calls.index[0].metadata.source, "scan");
  assert.equal(state.job.state, "done");
  assert.equal(state.job.error, null);
});

test("a picture that already exists skips the render and still repairs the index", async (t) => {
  const { env, calls, state } = fakeEnv({ thumbExists: true });
  t.mock.method(globalThis, "fetch", async () => Response.json({
    values: Array(768).fill(1 / Math.sqrt(768)), dimension: 768, fingerprint: FINGERPRINT,
    inputHash: "b".repeat(64), modality: "image" }));
  assert.equal(await runThumbJob(env, OBJECT_ID), "done");
  assert.equal(calls.browser, 0, "the expensive half is skipped");
  assert.equal(calls.index.length, 1, "the cheap half is not — this is what repairs a lost index");
  assert.equal(state.job.state, "done");
});

test("a job that is not pending is left alone", async () => {
  for (const job of [
    { object_id: OBJECT_ID, state: "done", attempts: 1, error: null, next_attempt_at: null, lease_until: null, created_at: "", updated_at: "" },
    { object_id: OBJECT_ID, state: "pending", attempts: 1, error: null, next_attempt_at: null, lease_until: "2999-01-01T00:00:00.000Z", created_at: "", updated_at: "" },
    { object_id: OBJECT_ID, state: "pending", attempts: 1, error: null, next_attempt_at: "2999-01-01T00:00:00.000Z", lease_until: null, created_at: "", updated_at: "" },
  ]) {
    const { env, calls } = fakeEnv({ job });
    assert.equal(await runThumbJob(env, OBJECT_ID), "skipped");
    assert.equal(calls.browser, 0);
  }
});

test("the encoder being down is a recorded retry, and then a recorded failure", async (t) => {
  // The laptop's SigLIP 2 container behind a quick tunnel. The render succeeds and the embed
  // cannot: the one case that must never end as a silent gap.
  const first = fakeEnv();
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  assert.equal(await runThumbJob(first.env, OBJECT_ID), "failed");
  assert.equal(first.state.job.state, "pending", "still pending: another attempt is coming");
  assert.match(first.state.job.error, /attempt 1: .*fetch failed/);
  assert.ok(first.state.job.next_attempt_at > new Date().toISOString(), "backed off, not retried at once");
  assert.equal(first.state.job.lease_until, null, "the claim is released for the next tick");

  // An unset upstream:embedding is the same shape of failure, with its own reason.
  const unset = fakeEnv({ embeddingOrigin: null });
  assert.equal(await runThumbJob(unset.env, OBJECT_ID), "failed");
  assert.match(unset.state.job.error, /No origin is configured for the embedding service/);

  // The last allowed attempt stops, says how many it took, and leaves a text vector behind
  // rather than no vector at all.
  const last = fakeEnv({ job: { object_id: OBJECT_ID, state: "pending", attempts: MAX_ATTEMPTS - 1,
    error: null, next_attempt_at: null, lease_until: null, created_at: "", updated_at: "" },
    objectRow: { name: "Blue armchair", category: "armchair" } });
  let embedded = null;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.imageBase64) throw new TypeError("fetch failed");
    embedded = body.text;
    return Response.json({ values: Array(768).fill(1 / Math.sqrt(768)), dimension: 768,
      fingerprint: FINGERPRINT, inputHash: "b".repeat(64), modality: "text" });
  });
  assert.equal(await runThumbJob(last.env, OBJECT_ID), "failed");
  assert.equal(last.state.job.state, "failed");
  assert.match(last.state.job.error, new RegExp(`after ${MAX_ATTEMPTS} attempts`));
  assert.equal(embedded, "Blue armchair armchair", "the floor is the text vector it would have had");
});

test("the cron takes one due job per tick, and health reports the state", async (t) => {
  const { env, calls, state } = fakeEnv();
  t.mock.method(globalThis, "fetch", async () => Response.json({
    values: Array(768).fill(1 / Math.sqrt(768)), dimension: 768, fingerprint: FINGERPRINT,
    inputHash: "b".repeat(64), modality: "image" }));
  await runScanThumbJobs(env);
  assert.equal(calls.browser, 1);
  assert.equal(state.job.state, "done");
  // Nothing due on the next tick: one render at a time, and no work invented.
  await runScanThumbJobs(env);
  assert.equal(calls.browser, 1);
  const health = await thumbHealth(env);
  assert.equal(health.done, 1);
  assert.equal(health.renderOriginConfigured, true);
  assert.equal(health.maxAttempts, MAX_ATTEMPTS);
});

test("the daily browser budget stops new renders and defers without spending an attempt", async () => {
  // Ten minutes a day is the whole allowance. Past 8 minutes this step stops launching renders
  // rather than racing the rest of the account to the wall.
  const { env, calls, state } = fakeEnv({ browserSeconds: 8 * 60 });
  assert.equal(await runThumbJob(env, OBJECT_ID), "deferred");
  assert.equal(calls.browser, 0, "no browser is launched once the budget is gone");
  assert.equal(state.job.state, "pending", "still pending: it is out of budget, not broken");
  assert.match(state.job.error, /deferred: daily browser budget/);
  assert.ok(state.job.next_attempt_at.endsWith("T00:00:00.000Z"), "retries after the UTC reset");
});

test("an object that already has a picture is never deferred: that path costs no browser time", async (t) => {
  const { env, calls, state } = fakeEnv({ browserSeconds: 9 * 60, thumbExists: true });
  t.mock.method(globalThis, "fetch", async () => Response.json({
    values: Array(768).fill(1 / Math.sqrt(768)), dimension: 768, fingerprint: FINGERPRINT,
    inputHash: "b".repeat(64), modality: "image" }));
  assert.equal(await runThumbJob(env, OBJECT_ID), "done");
  assert.equal(calls.browser, 0);
  assert.equal(state.job.state, "done");
});

test("a failed render is charged to the day too, and health reports the meter", async (t) => {
  const { env, state } = fakeEnv({ browser: () => new Response("nope", { status: 422,
    headers: { "x-browser-ms-used": "15000" } }) });
  t.mock.method(console, "error", () => {});
  assert.equal(await runThumbJob(env, OBJECT_ID), "failed");
  assert.equal(state.browserSeconds, 15, "the timeout is browser time we already spent");
  assert.equal(await browserSecondsToday(env), 15);
  const health = await thumbHealth(env);
  assert.equal(health.browserSecondsToday, 15);
  assert.equal(health.browserBudgetSeconds, 480);
  assert.equal(health.browserSelectorTimeoutSeconds, 15);
});

test("acceptance is one row, and a repeat attach does not create a second", async () => {
  const { env, state } = fakeEnv({ job: null });
  await enqueueScanThumb(env, OBJECT_ID, "2026-09-20T01:00:00.000Z");
  await enqueueScanThumb(env, OBJECT_ID, "2026-09-20T01:05:00.000Z");
  assert.equal(state.job.created_at, "2026-09-20T01:00:00.000Z");
  assert.equal(state.job.state, "pending");
});
