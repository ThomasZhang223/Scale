import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript," + encodeURIComponent(
    "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }\nexport class WorkflowEntrypoint {}"), shortCircuit: true };
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { readyOnly, merchantSlug, catalogIdCandidates, restrictFindToReady, failedFindResult } =
  await import("../src/lib/find-ready.ts");
const { catalogObjectId } = await import("../src/lib/catalog-ingest.ts");

const ORIGIN = "https://api.example";
const body = { storefront: "https://polyandbark.com/", merchant: "Poly & Bark", query: "lamp", limit: 8 };

/** One D1 objects row. Ready with a mesh unless overridden. */
const row = (id, over = {}) => ({
  id, source: "catalog", state: "ready", name: "Arc Lamp", category: "lighting",
  glb_key: `objects/${id}/mesh.glb`, bbox_w: 0.3, bbox_h: 1.4, bbox_d: 0.3,
  measure_method: "extracted", measure_confidence: 0.9, caption: null, palette_json: null,
  price_cents: null, currency: null, product_url: null, merchant: "Poly___Bark",
  created_at: "2026-09-20T00:00:00.000Z", ...over,
});

/** Enough D1 for getObjects (`id IN (...)`) and the ready lookup (`id = ?`). */
const fakeEnv = (rows, vars = { FIND_READY_ONLY: "1" }) => ({
  ...vars,
  DB: {
    prepare(sql) {
      return { bind(...binds) {
        return {
          async all() { return { results: rows.filter((r) => binds.includes(r.id)) }; },
          async first() {
            const hit = rows.find((r) => r.id === binds[0]);
            if (!hit) return null;
            if (sql.includes("state = 'ready'")) return hit.state === "ready" && hit.glb_key ? hit : null;
            return hit;
          },
        };
      } };
    },
  },
});

const listing = (over = {}) => ({
  schemaVersion: 1, objectId: "advisory", source: "catalog", state: "measured", name: "Arc Lamp",
  category: "lighting", glbUrl: null, bboxMeters: { w: 0.31, h: 1.41, d: 0.31 },
  measure: { method: "extracted", confidence: 0.9 }, merchant: "Poly & Bark",
  productUrl: "https://polyandbark.com/products/arc-lamp", price: null,
  extraction: { productId: "1", via: "api", imageUrl: "https://cdn.shopify.com/a.jpg", fits: true },
  ...over,
});

const found = (listings) => ({
  merchant: body.merchant, storefront: body.storefront, searchUrl: "u", searchedFor: "lamp",
  handles: listings.length, products: listings.length, measured: listings.length,
  fitting: listings.length, fallbackSuspected: false, warning: null, listings,
});

const noSearch = async () => [];

test("readyOnly accepts only an explicit 1 or 0", () => {
  assert.equal(readyOnly({ FIND_READY_ONLY: "1" }), true);
  assert.equal(readyOnly({ FIND_READY_ONLY: "0" }), false);
  for (const bad of [undefined, "", "true", "yes", "on", "2"]) {
    assert.throws(() => readyOnly({ FIND_READY_ONLY: bad }),
      (e) => e.status === 500 && e.code === "bad_config" && e.hint.includes("wrangler.toml"));
  }
});

test("merchantSlug reproduces the label that build_prebake.py wrote into D1", () => {
  assert.equal(merchantSlug("Poly & Bark"), "Poly___Bark");
  assert.equal(merchantSlug("Lulu and Georgia"), "Lulu_and_Georgia");
  // Both observed verbatim in D1's merchant column today.
  assert.equal(merchantSlug("InStyle Home (CA)"), "InStyle_Home__CA");
  assert.equal(merchantSlug("2Modern (lighting & furniture)"), "2Modern__lighting___furniture");
  assert.equal(merchantSlug("Bend_Goods"), "Bend_Goods");
});

test("catalogIdCandidates offers the productUrl id first, then both merchant spellings", async () => {
  const ids = await catalogIdCandidates(listing());
  assert.deepEqual(ids, [
    await catalogObjectId({ productUrl: "https://polyandbark.com/products/arc-lamp" }),
    await catalogObjectId({ merchant: "Poly & Bark", productId: "1" }),
    await catalogObjectId({ merchant: "Poly___Bark", productId: "1" }),
  ]);
});

test("catalogIdCandidates returns nothing when neither identity is present, rather than guessing", async () => {
  assert.deepEqual(await catalogIdCandidates(listing({ productUrl: null, merchant: null, extraction: {} })), []);
  assert.deepEqual(await catalogIdCandidates(listing({ productUrl: null, extraction: { productId: null } })), []);
});

test("a found listing whose row is ready is kept, with the D1 mesh, box and objectId", async () => {
  const id = await catalogObjectId({ productUrl: "https://polyandbark.com/products/arc-lamp" });
  const env = fakeEnv([row(id)]);
  const { result, header } = await restrictFindToReady(env, ORIGIN, body, found([listing()]), noSearch);
  assert.equal(result.listings.length, 1);
  const kept = result.listings[0];
  assert.equal(kept.objectId, id);
  assert.equal(kept.state, "ready");
  assert.equal(kept.glbUrl, `${ORIGIN}/v1/assets/objects/${id}/mesh.glb`);
  // The GLB was bound to the D1 box, and nothing rescales a GLB (standing rule 2).
  assert.deepEqual(kept.bboxMeters, { w: 0.3, h: 1.4, d: 0.3 });
  assert.equal(kept.findSource, "storefront");
  assert.equal(kept.price, null);
  assert.equal(header, "storefront=1,catalog=0,dropped=0,unidentified=0");
  assert.equal(result.measured, 1);
});

test("a found listing whose row is only measured is dropped and counted", async () => {
  const id = await catalogObjectId({ productUrl: "https://polyandbark.com/products/arc-lamp" });
  const env = fakeEnv([row(id, { state: "measured", glb_key: null })]);
  const { result, header } = await restrictFindToReady(env, ORIGIN, body, found([listing()]), noSearch);
  assert.deepEqual(result.listings, []);
  assert.equal(header, "storefront=0,catalog=0,dropped=1,unidentified=0");
});

test("a found listing with no identity is dropped as unidentified, never matched by title", async () => {
  const env = fakeEnv([row("whatever", { name: "Arc Lamp" })]);
  const blind = listing({ productUrl: null, merchant: null, extraction: {} });
  const { result, header } = await restrictFindToReady(env, ORIGIN, body, found([blind]), noSearch);
  assert.deepEqual(result.listings, []);
  assert.equal(header, "storefront=0,catalog=0,dropped=0,unidentified=1");
});

test("a merchant-label variant joins: no productUrl, and D1 was written from the slug", async () => {
  const id = await catalogObjectId({ merchant: "Lulu_and_Georgia", productId: "8127313313891" });
  const env = fakeEnv([row(id, { merchant: "Lulu_and_Georgia" })]);
  const live = found([listing({
    productUrl: null, merchant: "Lulu and Georgia",
    extraction: { productId: "8127313313891", via: "api", imageUrl: null, fits: true },
  })]);
  const { result, header } = await restrictFindToReady(env, ORIGIN, body, live, noSearch);
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].objectId, id);
  assert.equal(header, "storefront=1,catalog=0,dropped=0,unidentified=0");
});

test("the top-up fills from ready catalogue rows only, keeps the ranking order and de-duplicates", async () => {
  const keptId = await catalogObjectId({ productUrl: "https://polyandbark.com/products/arc-lamp" });
  const env = fakeEnv([
    row(keptId),
    row("ready-a", { name: "Floor Lamp" }),
    row("ready-b", { name: "Table Lamp" }),
    row("not-ready", { state: "measured", glb_key: null, name: "Pendant" }),
  ]);
  const asked = [];
  const search = async (s) => { asked.push(s); return ["not-ready", "ready-b", keptId, "ready-a"]; };
  const { result, header } = await restrictFindToReady(env, ORIGIN, body, found([listing()]), search);

  assert.deepEqual(asked, [{ text: "lamp", source: "catalog", limit: 24 }]);
  assert.deepEqual(result.listings.map((l) => l.objectId), [keptId, "ready-b", "ready-a"]);
  assert.equal(result.listings[1].findSource, "catalog");
  assert.equal(result.listings[1].state, "ready");
  assert.ok(result.listings[1].glbUrl.endsWith("/v1/assets/objects/ready-b/mesh.glb"));
  assert.equal(header, "storefront=1,catalog=2,dropped=0,unidentified=0");
});

test("the top-up passes the fit bounds through and stops at the tile target", async () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => row(id));
  let asked;
  const search = async (s) => { asked = s; return rows.map((r) => r.id); };
  const fit = { maxH: 1.5 };
  const { result, header } = await restrictFindToReady(
    fakeEnv(rows), ORIGIN, { ...body, fit }, found([]), search);
  assert.deepEqual(asked.fit, fit);
  assert.equal(result.listings.length, 6);
  assert.equal(header, "storefront=0,catalog=6,dropped=0,unidentified=0");
});

test("no top-up runs once the storefront already filled the menu", async () => {
  const ids = await Promise.all([1, 2, 3, 4, 5, 6].map((n) =>
    catalogObjectId({ productUrl: `https://polyandbark.com/products/lamp-${n}` })));
  const env = fakeEnv(ids.map((id) => row(id)));
  const live = found(ids.map((_, n) => listing({ productUrl: `https://polyandbark.com/products/lamp-${n + 1}` })));
  const search = async () => { throw new Error("the top-up must not run"); };
  const { header } = await restrictFindToReady(env, ORIGIN, body, live, search);
  assert.equal(header, "storefront=6,catalog=0,dropped=0,unidentified=0");
});

test("failedFindResult names the storefront failure instead of hiding it", () => {
  const out = failedFindResult(body, new Error("browserbase timeout"));
  assert.equal(out.warning, "storefront search failed: browserbase timeout");
  assert.deepEqual(out.listings, []);
  assert.equal(out.merchant, body.merchant);
  assert.equal(out.searchedFor, body.query);
});
