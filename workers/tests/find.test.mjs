import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { runFind, assertFindBody } = await import("../src/lib/find.ts");

const body = { storefront: "https://polyandbark.com/", merchant: "Poly & Bark", query: "lamp", fit: { maxH: 1.5 } };
const product = { id: 1, handle: "arc-lamp", title: "Arc Lamp", product_type: "lighting", images: [{ src: "https://cdn.shopify.com/a.jpg" }], variants: [{ price: "199.00" }] };
const measured = {
  schemaVersion: 1, objectId: "abc", source: "catalog", state: "measured", name: "Arc Lamp", category: "lighting",
  glbUrl: null, bboxMeters: { w: 0.3, h: 1.4, d: 0.3 }, measure: { method: "extracted", confidence: 0.9 },
  merchant: "Poly & Bark", productUrl: "https://polyandbark.com/products/arc-lamp", price: null,
  extraction: { productId: "1", via: "api", imageUrl: "https://cdn.shopify.com/a.jpg", fits: true },
};

test("assertFindBody refuses a missing storefront, merchant or query", () => {
  for (const missing of ["storefront", "merchant", "query"]) {
    const bad = { ...body }; delete bad[missing];
    assert.throws(() => assertFindBody(bad), (e) => e.status === 400 && e.code === "missing_field" && e.message.includes(missing));
  }
  assert.deepEqual(assertFindBody(body), body);
});

test("runFind calls /find then /extract with browserbase on and the fit, and returns the measured rows", async () => {
  const calls = [];
  const call = async (path, req) => {
    calls.push([path, req]);
    if (path === "/find") return { query: "lamp", searchedFor: "lamp", searchUrl: "https://polyandbark.com/search?q=lamp", count: 1, handles: ["arc-lamp"], products: [product], fallbackSuspected: false, warning: null };
    if (path === "/extract") return { merchant: "Poly & Bark", count: 1, stats: { fitting: 1, too_big: 0 }, objects: [measured] };
    throw new Error(`unexpected ${path}`);
  };
  const out = await runFind(call, body);
  assert.equal(calls[0][0], "/find");
  assert.deepEqual(calls[0][1], { storefront: body.storefront, query: "lamp", limit: 12 });
  assert.equal(calls[1][0], "/extract");
  assert.deepEqual(calls[1][1], { products: [product], merchant: "Poly & Bark", storefront: body.storefront, browserbase: true, pageLimit: 12, fit: { maxH: 1.5 } });
  assert.equal(out.handles, 1);
  assert.equal(out.measured, 1);
  assert.equal(out.fitting, 1);
  assert.equal(out.searchUrl, "https://polyandbark.com/search?q=lamp");
  assert.deepEqual(out.listings, [measured]);
});

test("runFind returns early with no listings when the search page yields nothing, and never calls /extract", async () => {
  const calls = [];
  const call = async (path) => {
    calls.push(path);
    return { query: "lamp", searchedFor: "lamp", searchUrl: "https://x/search?q=lamp", count: 0, handles: [], products: [], fallbackSuspected: false, warning: null };
  };
  const out = await runFind(call, body);
  assert.deepEqual(calls, ["/find"]);
  assert.deepEqual(out.listings, []);
  assert.equal(out.products, 0);
});

test("runFind passes through fallbackSuspected and warning from the search page", async () => {
  const call = async (path) => path === "/find"
    ? { query: "lamp", searchedFor: "lamp", searchUrl: "u", count: 1, handles: ["h"], products: [product], fallbackSuspected: true, warning: "served popular products instead" }
    : { merchant: "Poly & Bark", count: 0, stats: { fitting: 0, too_big: 0 }, objects: [] };
  const out = await runFind(call, body);
  assert.equal(out.fallbackSuspected, true);
  assert.equal(out.warning, "served popular products instead");
  assert.equal(out.measured, 0);
});
