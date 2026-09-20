import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  // The route module pulls in the Durable Object, Workflow and Agent base classes through
  // lib/notify. Node has no cloudflare: loader and the `agents` package is built against one,
  // so both resolve to stand-ins. Nothing under test touches either.
  if (specifier.startsWith("cloudflare:")) return { url: "data:text/javascript," + encodeURIComponent(
    "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }\nexport class WorkflowEntrypoint {}\nexport class WorkerEntrypoint {}\nexport class RpcTarget {}\nexport default {};"), shortCircuit: true };
  if (specifier === "agents") return { url: "data:text/javascript," + encodeURIComponent(
    "export class Agent {}\nexport const getAgentByName = async () => { throw new Error('no agent in this test'); };"), shortCircuit: true };
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { postListingsGenerate } = await import("../src/routes/index.ts");
const { catalogObjectId } = await import("../src/lib/catalog-ingest.ts");

const ORIGIN = "https://api.example";
const productUrl = "https://polyandbark.com/products/arc-lamp";
const listing = {
  name: "Arc Lamp", category: "lighting", bboxMeters: { w: 0.3, h: 1.4, d: 0.3 },
  imageUrl: "https://cdn.shopify.com/a.jpg", merchant: "Poly & Bark", productUrl,
  measure: { method: "extracted", confidence: 0.9 },
};

const readyRow = (id) => ({
  id, source: "catalog", state: "ready", name: "Arc Lamp", category: "lighting",
  glb_key: `objects/${id}/mesh.glb`, bbox_w: 0.3, bbox_h: 1.4, bbox_d: 0.3,
  measure_method: "extracted", measure_confidence: 0.9, caption: null, palette_json: null,
  price_cents: null, currency: null, product_url: productUrl, merchant: "Poly___Bark",
  created_at: "2026-09-20T00:00:00.000Z",
});

/** Records every statement, so "changed no state" is checkable and not assumed. */
function fakeEnv(rows) {
  const statements = [];
  const env = {
    JOB_QUEUE: { send: async (m) => statements.push(["QUEUE", m]) },
    MESH_DISPATCHER: { idFromName: () => "d", get: () => ({ fetch: async () => { statements.push(["DISPATCH"]); return new Response("{}"); } }) },
    DB: {
      batch: async (list) => { statements.push(["BATCH", list.length]); return list.map(() => ({ success: true })); },
      prepare(sql) {
        return { bind(...binds) {
          statements.push([sql.replace(/\s+/g, " ").trim(), binds]);
          return {
            async first() {
              const hit = rows.find((r) => r.id === binds[0]);
              if (!hit) return null;
              if (sql.includes("state = 'ready'")) return hit.state === "ready" && hit.glb_key ? hit : null;
              return hit;
            },
            async all() { return { results: rows.filter((r) => binds.includes(r.id)) }; },
            async run() { statements.push(["RUN", sql.replace(/\s+/g, " ").trim()]); return { success: true }; },
          };
        } };
      },
    },
  };
  return { env, statements };
}

const req = () => new Request("https://api.example/v1/listings/generate", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ listing, roomId: "room-1" }),
});

test("listings/generate on an already-ready object returns the mesh, creates no job and writes nothing", async () => {
  const id = await catalogObjectId({ productUrl });
  const { env, statements } = fakeEnv([readyRow(id)]);
  const res = await postListingsGenerate(req(), env, ORIGIN);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    objectId: id, jobId: null, state: "ready",
    glbUrl: `${ORIGIN}/v1/assets/objects/${id}/mesh.glb`,
  });
  // No INSERT, no UPDATE, no job row, no queue message: the row keeps its reviewed mesh.
  assert.deepEqual(statements.filter(([s]) => /INSERT|UPDATE|QUEUE|DISPATCH|RUN|BATCH/i.test(s)), []);
});

test("listings/generate still enqueues when the object has no mesh yet", async () => {
  const { env, statements } = fakeEnv([]);
  const res = await postListingsGenerate(req(), env, ORIGIN);
  assert.equal(res.status, 202);
  const out = await res.json();
  assert.equal(out.objectId, await catalogObjectId({ productUrl }));
  assert.ok(out.jobId);
  assert.ok(statements.some(([s]) => /INSERT INTO objects/i.test(s)));
});
