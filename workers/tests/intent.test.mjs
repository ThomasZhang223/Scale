import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { validateIntent, validateNeeds, productWords, FURNITURE_CATEGORIES } = await import("../src/lib/intent.ts");

const design = (over = {}) => ({ intent: "design", query: null, category: null, fit: null, ...over });

test("needs survives only for a design intent", () => {
  assert.deepEqual(validateIntent(design({ needs: ["armchair", "lamp"] })).needs, ["armchair", "lamp"]);
  // A library or shop turn places one thing; a needs list there would be the model volunteering
  // furniture nobody asked about.
  assert.equal(validateIntent({ intent: "library", query: "lamp", needs: ["desk"] }).needs, null);
});

test("a word outside the vocabulary is dropped, never passed on", () => {
  // "reading light" and "nook" are not categories the library can be asked for.
  assert.deepEqual(validateNeeds(["armchair", "reading light", "nook"]), ["armchair"]);
  assert.equal(validateNeeds(["nook"]), null);
  assert.equal(validateNeeds("armchair"), null);
  assert.equal(validateNeeds(null), null);
  assert.equal(validateNeeds([]), null);
});

test("needs is normalised: lowercased, deduped, at most four", () => {
  assert.deepEqual(validateNeeds(["Armchair", "ARMCHAIR", " lamp "]), ["armchair", "lamp"]);
  assert.deepEqual(validateNeeds(["desk", "chair", "lamp", "shelf", "rug"]), ["desk", "chair", "lamp", "shelf"]);
});

test("the vocabulary is the app's own category list", () => {
  // Verbatim from categoryOf()'s `known` in apps/xr/src/main.ts. If that list changes, this
  // test is the reminder that both copies move together.
  assert.deepEqual([...FURNITURE_CATEGORIES], [
    "coffee table", "side table", "sofa", "couch", "armchair", "chair", "stool", "bench", "dining",
    "table", "desk", "bed", "storage", "shelf", "bookcase", "cabinet", "dresser", "wardrobe",
    "lamp", "television", "tv", "plant", "rug",
  ]);
});

test("every other field keeps its old meaning", () => {
  const out = validateIntent({ intent: "shop", query: "couch", category: "seating", fit: { maxW: 0.8 } });
  assert.deepEqual(out, { intent: "shop", query: "couch", category: "seating", fit: { maxW: 0.8 }, needs: null });
  assert.throws(() => validateIntent({ intent: "rearrange" }), /intent was/);
});

test("a query that is a comment about the schema is rejected, not sent to a storefront", () => {
  // Verbatim from the deployed model on "Find me a side table on shopify".
  assert.equal(productWords("side table on shopify is not valid, query is null, category is null, fit is null"), null);
  assert.equal(productWords("couch is alre"), "couch is alre"); // short and useless, but the client's strip handles it
  assert.equal(productWords("walnut 6 drawer dresser"), "walnut 6 drawer dresser");
  assert.equal(productWords("a very long sentence that is plainly not a product name at all"), null);
  assert.equal(productWords(null), null);
  assert.equal(validateIntent({ intent: "shop", query: "sideboard" }).query, "sideboard");
  assert.equal(validateIntent({ intent: "shop", query: "side table is null, query is null" }).query, null);
});
