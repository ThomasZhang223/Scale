# Quest Voice Find → Browserbase Listings → Baseten Mesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Say "find me a lamp under 1.5 m" in the Quest, watch Browserbase search three Shopify stores in a head-locked panel, pick a listing card, and get a true-size box now and the Baseten GLB when the job finishes.

**Architecture:** Two new Worker routes fan the headset into the existing ingest service (`/find` via Browserbase, then `/extract`) and into the existing catalogue mesh queue. The headset gets a new `FindPanel` canvas panel (same technique as `Hud`) driven by per-store stage callbacks from a new `findLive()` in `listings.ts`, plus a pick flow that places a measured box, polls the job, and swaps in the GLB.

**Tech Stack:** Cloudflare Workers (TypeScript, `wrangler`), FastAPI ingest service (already deployed behind a quick tunnel), three.js WebXR app (Vite, TypeScript, `node --test`).

**Spec:** `docs/superpowers/specs/2026-09-20-quest-voice-find-listings-design.md`

## Global Constraints

- Metres everywhere in schemas, variables, request bodies. Convert to cm only inside draw code.
- Never rescale a GLB: `loader.load(url, 1)` always.
- Fail loud: missing `storefront`, `merchant`, or `query` is a 400, never a default.
- No LLM anywhere in this feature; query parsing is regex.
- Every new `/v1` route answers a stub when the request carries `X-Stub: 1`.
- Corner cuts get a `// ceiling:` comment with the upgrade path.
- No Claude or Anthropic co-author trailer on commits (project CLAUDE.md rule 7).
- `workers/**` is Thomas's path: commit messages for Tasks 1–2 start with `workers(find):` and end with the line `Flag for Thomas: two routes not yet in contracts.md.`
- Tests: Worker tests use `node --experimental-transform-types --test tests/<name>.test.mjs` with the `registerHooks` resolver copied from `workers/tests/solve-translate.test.mjs`. XR tests are `apps/xr/src/*.test.ts` run by `npm test` in `apps/xr`.

---

### Task 1: Worker `runFind` — pure fan-in of ingest `/find` then `/extract`

**Files:**
- Create: `workers/src/lib/find.ts`
- Test: `workers/tests/find.test.mjs`

**Interfaces:**
- Consumes: nothing new. `callUpstream` is injected as a function so the unit test needs no `Env`.
- Produces:
  ```ts
  export interface FindBody { storefront: string; merchant: string; query: string; fit?: { maxW?: number; maxH?: number; maxD?: number }; limit?: number }
  export interface FindListing { objectId: string; name: string; category: string | null; bboxMeters: {w:number;h:number;d:number}; merchant: string; productUrl: string | null; price: {cents:number;currency:string} | null; measure: {method:string;confidence:number}; extraction: { imageUrl: string | null; fits: boolean; via: string; productId: string | null }; [k: string]: unknown }
  export interface FindResult { merchant: string; storefront: string; searchUrl: string | null; searchedFor: string | null; handles: number; products: number; measured: number; fitting: number; fallbackSuspected: boolean; warning: string | null; listings: FindListing[] }
  export type UpstreamCall = <T>(path: string, body: unknown, timeoutMs?: number) => Promise<T>;
  export function assertFindBody(body: unknown): FindBody   // throws HttpError 400 missing_field
  export async function runFind(call: UpstreamCall, body: FindBody): Promise<FindResult>
  ```

- [ ] **Step 1: Write the failing test**

Create `workers/tests/find.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers && node --experimental-transform-types --test tests/find.test.mjs`
Expected: FAIL, cannot find module `../src/lib/find.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `workers/src/lib/find.ts`:

```ts
// POST /v1/find: the headset's "find me a lamp" against one Shopify storefront, live.
//
// Two upstream calls into services/ingest, both token-gated there, which is why the headset
// cannot make them itself: /find renders the merchant's own search page through Browserbase and
// returns raw Shopify products; /extract measures them into Object v1 rows. Nothing is written
// to D1 here — a listing becomes an object only when someone picks it (POST /v1/listings/generate).
//
// Not in contracts.md yet — see workers/DEPLOY.md "Schema proposals".

import { HttpError } from "./http";

export interface FindBody {
  storefront: string;
  merchant: string;
  query: string;
  fit?: { maxW?: number; maxH?: number; maxD?: number };
  limit?: number;
}

export interface FindListing {
  objectId: string;
  name: string;
  category: string | null;
  bboxMeters: { w: number; h: number; d: number };
  merchant: string;
  productUrl: string | null;
  price: { cents: number; currency: string } | null;
  measure: { method: string; confidence: number };
  extraction: { imageUrl: string | null; fits: boolean; via: string; productId: string | null };
  [k: string]: unknown;
}

export interface FindResult {
  merchant: string;
  storefront: string;
  searchUrl: string | null;
  searchedFor: string | null;
  handles: number;
  products: number;
  measured: number;
  fitting: number;
  fallbackSuspected: boolean;
  warning: string | null;
  listings: FindListing[];
}

export type UpstreamCall = <T>(path: string, body: unknown, timeoutMs?: number) => Promise<T>;

interface IngestFind {
  query: string; searchedFor: string; searchUrl?: string; count: number;
  handles: string[]; products: unknown[]; fallbackSuspected?: boolean; warning?: string | null;
}
interface IngestExtract { merchant: string; count: number; stats: Record<string, number>; objects: FindListing[] }

const FIND_TIMEOUT_MS = 45_000;    // one Browserbase render plus a catalogue join
const EXTRACT_TIMEOUT_MS = 60_000; // up to pageLimit rendered product pages
const PAGE_LIMIT = 12;             // ceiling: rendered pages per store; raise once stages stream

export function assertFindBody(body: unknown): FindBody {
  const b = (body ?? {}) as Record<string, unknown>;
  for (const key of ["storefront", "merchant", "query"] as const) {
    if (typeof b[key] !== "string" || !(b[key] as string).trim()) {
      throw new HttpError(400, "missing_field", `${key} is required.`); // standing rule 4
    }
  }
  return b as unknown as FindBody;
}

export async function runFind(call: UpstreamCall, body: FindBody): Promise<FindResult> {
  const limit = Math.min(50, Math.max(1, body.limit ?? 12));
  const found = await call<IngestFind>("/find", { storefront: body.storefront, query: body.query, limit }, FIND_TIMEOUT_MS);
  const base: Omit<FindResult, "measured" | "fitting" | "listings"> = {
    merchant: body.merchant,
    storefront: body.storefront,
    searchUrl: found.searchUrl ?? null,
    searchedFor: found.searchedFor ?? null,
    handles: found.handles?.length ?? 0,
    products: found.products?.length ?? 0,
    fallbackSuspected: Boolean(found.fallbackSuspected),
    warning: found.warning ?? null,
  };
  if (!found.products?.length) return { ...base, measured: 0, fitting: 0, listings: [] };

  const extracted = await call<IngestExtract>("/extract", {
    products: found.products,
    merchant: body.merchant,
    storefront: body.storefront,
    browserbase: true,
    pageLimit: PAGE_LIMIT,
    fit: body.fit,
  }, EXTRACT_TIMEOUT_MS);
  return {
    ...base,
    measured: extracted.objects.length,
    fitting: extracted.stats?.fitting ?? extracted.objects.length,
    listings: extracted.objects,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers && node --experimental-transform-types --test tests/find.test.mjs`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add workers/src/lib/find.ts workers/tests/find.test.mjs
git commit -m "workers(find): runFind fans the headset into ingest /find then /extract

Flag for Thomas: two routes not yet in contracts.md."
```

---

### Task 2: Worker routes `POST /v1/find` and `POST /v1/listings/generate`, with stubs

**Files:**
- Modify: `workers/src/routes/index.ts` (add two handlers after `postSearch`, around line 494; add import of `./lib/find` and `./lib/catalog-ingest`)
- Modify: `workers/src/index.ts:128-171` (stub table) and `:213` (dispatch, after the `/v1/search` line)
- Modify: `workers/src/lib/catalog-ingest.ts:50-56` (`enqueueCatalogItem` gains `roomId`)
- Modify: `workers/package.json` (add `"test:find"` script)

**Interfaces:**
- Consumes: `runFind`, `assertFindBody` (Task 1); `callUpstream(env, "ingest", path, body, timeoutMs)` from `lib/config`; `normalizeCatalogItem`, `enqueueCatalogItem` from `lib/catalog-ingest`.
- Produces: HTTP `POST /v1/find` → `FindResult`; `POST /v1/listings/generate { listing, roomId? }` → 202 `{ objectId, jobId }`.

- [ ] **Step 1: Thread `roomId` through `enqueueCatalogItem`**

In `workers/src/lib/catalog-ingest.ts` replace the function:

```ts
export async function enqueueCatalogItem(env: Env, item: CatalogItem, apiOrigin: string, roomId: string | null = null) {
  // A repeated scrape cannot start another paid inference for the same input.
  const jobId = await stableId([item.objectId, item.imageUrl, item.bboxMeters]);
  const existing = await env.DB.prepare("SELECT id FROM objects WHERE id = ?").bind(item.objectId).first();
  if (!existing) await insertObject(env, { ...item, source: "catalog", state: "measured", createdAt: new Date().toISOString() });
  // roomId: the headset that picked this listing; the Workflow's finalize emits the ready
  // object over that room's SSE feed so the box is swapped for the mesh without polling.
  await enqueueMesh(env, { jobId, objectId: item.objectId, tier: "live", apiOrigin, roomId, catalog: item });
  return { objectId: item.objectId, jobId };
}
```

- [ ] **Step 2: Add the two handlers to `workers/src/routes/index.ts`**

Add to the imports at the top:

```ts
import { assertFindBody, runFind } from "../lib/find";
import { enqueueCatalogItem, normalizeCatalogItem } from "../lib/catalog-ingest";
```

Add after `postSearch` (before the `// --- Fit` section, around line 496):

```ts
// POST /v1/find  { storefront, merchant, query, fit?, limit? }
//
// The headset's live "find me a lamp" against one storefront. Fans into services/ingest
// (/find via Browserbase, then /extract) with the upstream token the browser must never hold.
// One call per storefront; the headset runs three in parallel and shows each as a stage row.
// Not in contracts.md yet — see workers/DEPLOY.md "Schema proposals".
export async function postFind(req: Request, env: Env): Promise<Response> {
  const body = assertFindBody(await readJson<unknown>(req));
  const call = <T,>(path: string, payload: unknown, timeoutMs?: number) =>
    callUpstream<T>(env, "ingest", path, payload, timeoutMs);
  return json(await runFind(call, body));
}

// POST /v1/listings/generate  { listing, roomId? }
//
// A picked /v1/find row becomes a D1 object and a mesh job. Reuses the catalogue-ingest
// normaliser so the Workflow downloads the product image before Baseten runs — the plain
// /objects/{id}/generate route cannot do that for a catalogue row (no frames in R2 yet).
// Public: it only enqueues a row the Worker itself normalised, and the job id is
// content-addressed, so repeats never start a second paid inference.
export async function postListingsGenerate(req: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJson<{ listing?: unknown; roomId?: string | null }>(req);
  if (!body.listing) throw new HttpError(400, "missing_field", "listing is required.");
  const item = await normalizeCatalogItem(body.listing);
  const roomId = typeof body.roomId === "string" && body.roomId ? body.roomId : null;
  return json(await enqueueCatalogItem(env, item, origin, roomId), 202);
}
```

- [ ] **Step 3: Register dispatch and stubs in `workers/src/index.ts`**

In the stub `routes` table, after the `POST /v1/search` entry:

```ts
  route("POST", "/v1/find", () => ({
    merchant: "Stub Merchant",
    storefront: "https://stub.local/",
    searchUrl: "https://stub.local/search?q=stub",
    searchedFor: "stub",
    handles: 1, products: 1, measured: 1, fitting: 1,
    fallbackSuspected: false, warning: null,
    listings: [{
      ...objectMacbook,
      merchant: "Stub Merchant",
      productUrl: "https://stub.local/products/macbook",
      price: { cents: 129900, currency: "USD" },
      measure: { method: "extracted", confidence: 0.9 },
      extraction: { productId: "1", via: "api", imageUrl: "https://stub.local/macbook.jpg", fits: true },
    }],
  })),
  route("POST", "/v1/listings/generate", () => ({ objectId: objectMacbook.objectId, jobId: STUB_JOB_ID })),
```

In `dispatch`, after the `/v1/search` line:

```ts
  if (m("POST", /^\/v1\/find$/)) return real.postFind(req, env);
  if (m("POST", /^\/v1\/listings\/generate$/)) return real.postListingsGenerate(req, env, origin);
```

- [ ] **Step 4: Add the test script and typecheck**

In `workers/package.json` scripts add:
```json
"test:find": "node --experimental-transform-types --test tests/find.test.mjs",
```

Run: `cd workers && npm run typecheck && npm run test:find`
Expected: tsc clean, 4 tests passing.

- [ ] **Step 5: Verify the stubs and the live route with `wrangler dev`**

Run in one terminal: `cd workers && npm run dev` (listens on 8787).
Run in another:

```bash
curl -s -X POST localhost:8787/v1/find -H 'X-Stub: 1' -H 'content-type: application/json' -d '{}' | head -c 300; echo
curl -s -X POST localhost:8787/v1/find -H 'content-type: application/json' -d '{"storefront":"https://polyandbark.com/"}' ; echo
curl -s -X POST localhost:8787/v1/listings/generate -H 'X-Stub: 1' -H 'content-type: application/json' -d '{}' ; echo
```

Expected: first prints the stub body with one listing; second is `{"error":"missing_field","message":"merchant is required."...}` (400); third is `{"objectId":"...","jobId":"9c9f709a-..."}`.

Live check (needs the deployed Worker's upstream KV; local dev without `upstream:ingest` will answer 503 which is correct fail-loud behaviour — record which you saw):

```bash
curl -s -m 120 -X POST https://full-scale-workers.thomaszhangdev.workers.dev/v1/find -H 'content-type: application/json' \
  -d '{"storefront":"https://polyandbark.com/","merchant":"Poly & Bark","query":"lamp","limit":6}' | head -c 600; echo
```

This only works after Thomas deploys; before that, note in the commit body that the live check is pending deploy.

- [ ] **Step 6: Commit**

```bash
git add workers/src/routes/index.ts workers/src/index.ts workers/src/lib/catalog-ingest.ts workers/package.json
git commit -m "workers(find): POST /v1/find and POST /v1/listings/generate, stubbed

/find fans into ingest /find (Browserbase) then /extract. /listings/generate
reuses the catalogue-ingest normaliser and threads roomId so the ready mesh
is announced over the room's SSE feed.

Flag for Thomas: two routes not yet in contracts.md."
```

---

### Task 3: Headset `productQuery` and `findLive` with per-store stages

**Files:**
- Modify: `apps/xr/src/listings.ts` (add after `needFromText`, before `fitsNeed`; change `findListings` default `live`)
- Test: `apps/xr/src/listings.test.ts` (append)

**Interfaces:**
- Consumes: `Need`, `Listing`, `rank`, `API_BASE`, `STUB` (existing).
- Produces:
  ```ts
  export const STOREFRONTS: readonly { merchant: string; storefront: string }[]
  export function productQuery(text: string): string
  export type FindStage = 'searching' | 'measuring' | 'done' | 'failed'
  export interface StageInfo { merchant: string; stage: FindStage; detail: string }
  export type OnStage = (info: StageInfo) => void
  export async function findLive(need: Need, limit: number, onStage?: OnStage, fetchFn?: typeof fetch): Promise<Listing[]>
  ```
  `findListings(need, limit, opts)` keeps its signature; its default `live` becomes `(n, l) => findLive(n, l)`. Add `opts.onStage?: OnStage` and pass it through.

- [ ] **Step 1: Write the failing tests**

Append to `apps/xr/src/listings.test.ts`:

```ts
import { productQuery, findLive, STOREFRONTS } from './listings.ts';

test('productQuery strips the imperative and the length phrases, keeping the product words', () => {
  assert.equal(productQuery('find me a lamp under 1.5 m tall'), 'lamp');
  assert.equal(productQuery('Find a red chair for the 80 cm gap beside my desk'), 'red chair beside my desk');
  assert.equal(productQuery('recommend some floor lamps'), 'floor lamps');
  assert.equal(productQuery('lamp'), 'lamp');
});

test('findLive posts one /find per storefront in parallel, reports stages, and merges listings', async () => {
  const bodies: Record<string, unknown>[] = [];
  const stages: string[] = [];
  const row = (merchant: string, i: number) => ({
    schemaVersion: 1, objectId: `${merchant}-${i}`, source: 'catalog', state: 'measured', name: `Lamp ${i}`, category: 'lighting',
    glbUrl: null, bboxMeters: { w: 0.3, h: 1.2, d: 0.3 }, merchant, productUrl: null, price: null,
    measure: { method: 'extracted', confidence: 0.9 }, extraction: { imageUrl: `https://cdn/${i}.jpg`, fits: true, via: 'api', productId: String(i) },
  });
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    if (body.merchant === 'Sabai Design') return new Response(JSON.stringify({ error: 'upstream_error', message: 'ingest answered 502' }), { status: 502 });
    return new Response(JSON.stringify({ merchant: body.merchant, storefront: body.storefront, searchUrl: 'u', searchedFor: 'lamp', handles: 2, products: 2, measured: 2, fitting: 2, fallbackSuspected: false, warning: null, listings: [row(body.merchant, 1), row(body.merchant, 2)] }));
  }) as unknown as typeof fetch;

  const rows = await findLive({ text: 'find me a lamp under 1.5 m', bucket: 'lighting', categoryWords: ['lamp'], maxH: 1.5 }, 8, (s) => stages.push(`${s.merchant}:${s.stage}`), fetchFn);
  assert.equal(bodies.length, STOREFRONTS.length);
  assert.equal(bodies[0].query, 'lamp');
  assert.deepEqual(bodies[0].fit, { maxH: 1.5 });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.imageUrl?.startsWith('https://cdn/')));
  for (const { merchant } of STOREFRONTS) assert.ok(stages.includes(`${merchant}:searching`), `${merchant} never started`);
  assert.ok(stages.includes('Poly & Bark:done'));
  assert.ok(stages.includes('Sabai Design:failed'));
});

test('findLive throws when every store failed, so findListings can fall back and say so', async () => {
  const fetchFn = (async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as unknown as typeof fetch;
  await assert.rejects(findLive({ text: 'lamp' }, 8, undefined, fetchFn), /every store failed/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/xr && npm test -- src/listings.test.ts` (or `node --test src/listings.test.ts`)
Expected: FAIL, `productQuery` / `findLive` / `STOREFRONTS` not exported.

- [ ] **Step 3: Implement in `apps/xr/src/listings.ts`**

Insert after `needFromText` (before `fitsNeed`):

```ts
/** The verified Shopify storefronts (services/ingest/merchants.verified.json), searched live. */
// ceiling: a fixed list; the upgrade is GET /v1/merchants once Paul's scout table is seeded.
export const STOREFRONTS: readonly { merchant: string; storefront: string }[] = [
  { merchant: 'Poly & Bark', storefront: 'https://polyandbark.com/' },
  { merchant: 'InStyle Home', storefront: 'https://instylehome.ca/' },
  { merchant: 'Sabai Design', storefront: 'https://sabai.design/' },
];

const IMPERATIVE = /^\s*(?:(?:please|can you|could you)\s+)?(?:find|show|get|recommend|suggest|search(?: for)?|look for|buy|shop for)\s+(?:me\s+)?(?:a|an|some|the)?\s*/i;
const LENGTH_PHRASE = /\b(?:under|below|less than|no more than|up to|max(?:imum)?|at most|no (?:wider|deeper|taller) than)?\s*\d+(?:\.\d+)?\s*(?:cm|centimet\w*|m|metres?|meters?|mm|millimet\w*|in|inch\w*|"|ft|feet|foot|')\s*(?:wide|deep|tall|high|long)?\b/gi;
const GAP_PHRASE = /\b(?:for|in|into)\s+the\s+gap\b/gi;

/**
 * The product words the merchant's own search should see: the sentence minus the imperative
 * ("find me a") and minus the lengths needFromText already turned into bounds. No LLM; the
 * merchant's search knows its own vocabulary better than a parser here would.
 */
export function productQuery(text: string): string {
  return text
    .replace(IMPERATIVE, '')
    .replace(LENGTH_PHRASE, ' ')
    .replace(GAP_PHRASE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.]+|[\s,.]+$/g, '')
    .trim();
}

export type FindStage = 'searching' | 'measuring' | 'done' | 'failed';
export interface StageInfo { merchant: string; stage: FindStage; detail: string }
export type OnStage = (info: StageInfo) => void;

interface FindResponse {
  merchant: string; searchUrl: string | null; handles: number; products: number; measured: number; fitting: number;
  fallbackSuspected: boolean; warning: string | null;
  listings: (Listing & { extraction?: { imageUrl?: string | null; fits?: boolean } })[];
}

// ceiling: /v1/find is one round trip, so the headset cannot see the find→extract boundary.
// The row flips to "measuring" on a timer instead. Upgrade path: stream stages from the Worker.
const MEASURING_AFTER_MS = 12_000;

/**
 * Live search: POST /v1/find per storefront, in parallel, through Browserbase on the server.
 * Reports each store's stage as it goes; resolves with every store's measured rows merged.
 * Throws only when every store failed, so the caller can fall back and say why.
 */
export async function findLive(need: Need, limit: number, onStage: OnStage = () => {}, fetchFn: typeof fetch = fetch): Promise<Listing[]> {
  const query = productQuery(need.text ?? need.categoryWords?.[0] ?? '');
  if (!query) throw new Error('nothing to search for');
  const fit: Record<string, number> = {};
  if (need.maxW != null) fit.maxW = need.maxW;
  if (need.maxH != null) fit.maxH = need.maxH;
  if (need.maxD != null) fit.maxD = need.maxD;

  const one = async ({ merchant, storefront }: { merchant: string; storefront: string }): Promise<Listing[]> => {
    onStage({ merchant, stage: 'searching', detail: 'rendering the search page…' });
    const timer = setTimeout(() => onStage({ merchant, stage: 'measuring', detail: 'measuring products…' }), MEASURING_AFTER_MS);
    try {
      const res = await fetchFn(`${API_BASE}/find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(STUB ? { 'X-Stub': '1' } : {}) },
        body: JSON.stringify({ storefront, merchant, query, limit, ...(Object.keys(fit).length ? { fit } : {}) }),
      });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try { detail = ((await res.json()) as { message?: string }).message ?? detail; } catch { /* not JSON */ }
        throw new Error(detail);
      }
      const out = (await res.json()) as FindResponse;
      const rows = out.listings.map((l) => ({ ...l, merchant: l.merchant ?? merchant, imageUrl: l.imageUrl ?? l.extraction?.imageUrl ?? null }));
      const fits = out.listings.filter((l) => l.extraction?.fits !== false).length;
      onStage({ merchant, stage: 'done', detail: out.fallbackSuspected ? `${out.measured} measured, none match — ${out.warning ?? 'store fallback'}` : `${out.handles} found, ${out.measured} measured, ${fits} fit` });
      return rows;
    } catch (err) {
      onStage({ merchant, stage: 'failed', detail: (err as Error).message });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  const settled = await Promise.allSettled(STOREFRONTS.map(one));
  const rows = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  if (settled.every((s) => s.status === 'rejected')) {
    const reasons = settled.map((s, i) => `${STOREFRONTS[i].merchant}: ${(s as PromiseRejectedResult).reason?.message ?? 'failed'}`).join('; ');
    throw new Error(`every store failed (${reasons})`);
  }
  return rows;
}
```

Then change `findListings`:

```ts
export async function findListings(
  need: Need,
  limit = 8,
  opts: { live?: (n: Need, l: number) => Promise<Listing[]>; bundled?: () => Promise<Listing[]>; onStage?: OnStage } = {},
): Promise<ListingsResult> {
  const live = opts.live ?? ((n: Need, l: number) => findLive(n, l, opts.onStage));
```

(The rest of `findListings` is unchanged.) Leave `liveSearch` in place; it is still used by `api.ts`'s scan search. If `tsc` reports it unused, keep it exported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/xr && npm test`
Expected: all listings tests pass, including the three new ones. The existing `findListings` tests still pass because they inject `live`.

- [ ] **Step 5: Commit**

```bash
git add apps/xr/src/listings.ts apps/xr/src/listings.test.ts
git commit -m "xr(listings): findLive searches the three storefronts via /v1/find with per-store stages"
```

---

### Task 4: `FindPanel` — the head-locked Browserbase progress and listing-card panel

**Files:**
- Create: `apps/xr/src/findpanel.ts`
- Test: `apps/xr/src/findpanel.test.ts`

**Interfaces:**
- Consumes: `wrap` from `./hud`, `Recommendation`, `StageInfo`, `STOREFRONTS` from `./listings`.
- Produces:
  ```ts
  export type PanelHit = { kind: 'card'; objectId: string } | { kind: 'close' } | null
  export function cardRects(count: number): { y: number; h: number }[]   // metres from the panel top, pure
  export class FindPanel {
    readonly group: THREE.Group
    attachTo(scene: THREE.Object3D): void
    place(head: THREE.Object3D): void          // once a frame: 0.9 m ahead, 0.28 m right, facing the eyes
    setPresenting(on: boolean): void
    showSearching(query: string, merchants: readonly string[]): void
    setStage(info: StageInfo): void
    showResults(recs: Recommendation[], note: string | null): void
    setProgress(objectId: string, text: string): void   // the picked card's status line
    hitTest(raycaster: THREE.Raycaster): PanelHit
    dismiss(): void
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/xr/src/findpanel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FindPanel, cardRects } from './findpanel.ts';
import type { Recommendation } from './listings.ts';

const rec = (id: string): Recommendation => ({
  score: 0.8, reasons: ['matches "lamp"'],
  listing: { schemaVersion: 1, objectId: id, source: 'catalog', state: 'measured', name: `Lamp ${id}`, category: 'lighting', glbUrl: null, bboxMeters: { w: 0.3, h: 1.2, d: 0.3 }, merchant: 'Poly & Bark', imageUrl: null },
});

test('cardRects stacks cards downward from the title with a constant pitch', () => {
  const rects = cardRects(3);
  assert.equal(rects.length, 3);
  assert.ok(rects[0].y > 0, 'first card sits below the title');
  assert.ok(rects[1].y > rects[0].y && rects[2].y > rects[1].y);
  assert.ok(rects.every((r) => r.h > 0.08 && r.h < 0.15));
});

test('hitTest finds the card under a ray and null beside the panel', () => {
  const panel = new FindPanel();
  panel.setPresenting(true);
  panel.showResults([rec('a'), rec('b')], null);
  panel.group.position.set(0, 0, 0);
  panel.group.updateMatrixWorld(true);
  const [first, second] = cardRects(2);
  const ray = (y: number) => {
    const r = new THREE.Raycaster();
    r.set(new THREE.Vector3(0, y, 1), new THREE.Vector3(0, 0, -1));
    return r;
  };
  assert.deepEqual(panel.hitTest(ray(-(first.y + first.h / 2))), { kind: 'card', objectId: 'a' });
  assert.deepEqual(panel.hitTest(ray(-(second.y + second.h / 2))), { kind: 'card', objectId: 'b' });
  assert.equal(panel.hitTest(ray(5)), null);
});

test('a searching panel has no card hits, and dismiss hides everything', () => {
  const panel = new FindPanel();
  panel.setPresenting(true);
  panel.showSearching('lamp', ['Poly & Bark']);
  panel.group.updateMatrixWorld(true);
  const r = new THREE.Raycaster();
  r.set(new THREE.Vector3(0, -0.1, 1), new THREE.Vector3(0, 0, -1));
  assert.equal(panel.hitTest(r), null);
  panel.dismiss();
  assert.equal(panel.group.visible, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/xr && node --test src/findpanel.test.ts`
Expected: FAIL, cannot find `./findpanel.ts`.

- [ ] **Step 3: Implement `apps/xr/src/findpanel.ts`**

```ts
import * as THREE from 'three';
import { wrap } from './hud';
import type { Recommendation, StageInfo, FindStage } from './listings';

/*
 * The find panel: what Browserbase is doing on each store, then the listings that came back.
 * A canvas texture on a plane, like hud.ts, but head-locked ahead and to the right so it sits
 * beside the transcript rather than behind the phone. Three states: searching (one stage row
 * per store), results (cards you can point at), generating (the picked card's progress line).
 * Only the cards and the × are hittable; everything else ignores the ray.
 */

export type PanelHit = { kind: 'card'; objectId: string } | { kind: 'close' } | null;

const PX = 2400;
const WIDTH = 0.6;
const PAD = 0.024;
const TITLE_H = 0.05;
const ROW_H = 0.036;       // a stage row
const CARD_H = 0.11;       // a listing card
const CARD_GAP = 0.008;
const THUMB = 0.09;
const RADIUS = 0.024;
const MAX_CARDS = 6;
const AHEAD = 0.9;         // metres in front of the eyes
const RIGHT = 0.28;        // metres to the right of the gaze line
const DOWN = 0.05;
const CLOSE_R = 0.022;
const CLOSE_INSET = 0.034;

const BACKGROUND = 'rgba(28,28,30,0.90)';
const CARD_BG = 'rgba(44,44,46,0.95)';
const TEXT = '#FFFFFF';
const SECONDARY = 'rgba(235,235,245,0.60)';
const ACCENT = '#0A84FF';
const STAGE_COLOR: Record<FindStage, string> = { searching: '#FF9F0A', measuring: '#FFD60A', done: '#30D158', failed: '#FF453A' };
const FONT = (size: number, weight = 400) => `${weight} ${size * PX}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`;

interface StageRow { merchant: string; stage: FindStage | 'queued'; detail: string }

/** Card i occupies [y, y+h) metres below the panel's top edge. Pure, so hit tests are testable. */
export function cardRects(count: number): { y: number; h: number }[] {
  const out: { y: number; h: number }[] = [];
  for (let i = 0; i < Math.min(count, MAX_CARDS); i++) out.push({ y: PAD + TITLE_H + i * (CARD_H + CARD_GAP), h: CARD_H });
  return out;
}

export class FindPanel {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private readonly close: THREE.Mesh;
  private cardMeshes: THREE.Mesh[] = [];
  private presenting = false;
  private dismissed = false;
  private mode: 'hidden' | 'searching' | 'results' = 'hidden';
  private query = '';
  private rows: StageRow[] = [];
  private recs: Recommendation[] = [];
  private note: string | null = null;
  private progress = new Map<string, string>();
  private thumbs = new Map<string, HTMLImageElement>();

  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor() {
    this.group.name = 'find-panel';
    this.group.visible = false;
    this.close = closeDisc();
    this.group.add(this.close);
  }

  attachTo(scene: THREE.Object3D) { scene.add(this.group); }

  setPresenting(on: boolean) {
    this.presenting = on;
    this.group.visible = on && this.mode !== 'hidden' && !this.dismissed;
  }

  dismiss() {
    this.dismissed = true;
    this.group.visible = false;
  }

  /** Once a frame: ahead of the eyes, offset right, facing them. Head-locked, so it never gets lost. */
  place(head: THREE.Object3D) {
    if (this.mode === 'hidden' || this.dismissed) { this.group.visible = false; return; }
    head.getWorldPosition(this.eye);
    head.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    this.right.crossVectors(this.forward, new THREE.Vector3(0, 1, 0)).normalize();
    this.group.position.copy(this.eye).addScaledVector(this.forward, AHEAD).addScaledVector(this.right, RIGHT);
    this.group.position.y -= DOWN;
    this.group.lookAt(this.eye);
    this.group.visible = this.presenting && this.mesh !== null;
  }

  showSearching(query: string, merchants: readonly string[]) {
    this.mode = 'searching';
    this.dismissed = false;
    this.query = query;
    this.rows = merchants.map((merchant) => ({ merchant, stage: 'queued', detail: 'waiting…' }));
    this.recs = [];
    this.progress.clear();
    this.redraw();
  }

  setStage(info: StageInfo) {
    const row = this.rows.find((r) => r.merchant === info.merchant);
    if (row) { row.stage = info.stage; row.detail = info.detail; }
    else this.rows.push({ ...info });
    if (this.mode === 'searching') this.redraw();
  }

  showResults(recs: Recommendation[], note: string | null) {
    this.mode = 'results';
    this.dismissed = false;
    this.recs = recs.slice(0, MAX_CARDS);
    this.note = note;
    this.loadThumbs();
    this.redraw();
  }

  setProgress(objectId: string, text: string) {
    this.progress.set(objectId, text);
    if (this.mode === 'results') this.redraw();
  }

  hitTest(raycaster: THREE.Raycaster): PanelHit {
    if (!this.group.visible) return null;
    if (raycaster.intersectObject(this.close, false).length) return { kind: 'close' };
    const [hit] = raycaster.intersectObjects(this.cardMeshes, false);
    return hit ? { kind: 'card', objectId: hit.object.userData.objectId as string } : null;
  }

  private loadThumbs() {
    if (typeof Image === 'undefined') return;
    for (const { listing } of this.recs) {
      if (!listing.imageUrl || this.thumbs.has(listing.objectId)) continue;
      const img = new Image();
      img.crossOrigin = 'anonymous'; // Shopify's CDN sends CORS headers; without this the canvas taints
      img.onload = () => this.redraw();
      img.onerror = () => { this.thumbs.delete(listing.objectId); };
      img.src = listing.imageUrl;
      this.thumbs.set(listing.objectId, img);
    }
  }

  private height(): number {
    if (this.mode === 'searching') return PAD + TITLE_H + this.rows.length * ROW_H + PAD;
    const n = Math.max(1, this.recs.length);
    return PAD + TITLE_H + n * (CARD_H + CARD_GAP) - CARD_GAP + (this.note ? ROW_H : 0) + PAD;
  }

  private redraw() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      ((this.mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture | null)?.dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
    for (const m of this.cardMeshes) { m.geometry.dispose(); m.removeFromParent(); }
    this.cardMeshes = [];
    if (this.mode === 'hidden') { this.group.visible = false; return; }

    const height = this.height();
    // Invisible hit planes for the cards exist even without a document, so hitTest is testable.
    if (this.mode === 'results') {
      cardRects(this.recs.length).forEach((r, i) => {
        // opacity 0, not visible:false — three.js skips raycasting a mesh whose material is invisible.
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH - 2 * PAD, r.h), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
        plane.position.set(0, -(r.y + r.h / 2), 0.001);
        plane.userData.objectId = this.recs[i].listing.objectId;
        this.cardMeshes.push(plane);
        this.group.add(plane);
      });
    }
    this.close.position.set(-WIDTH / 2 + CLOSE_INSET, -CLOSE_INSET, 0.002);

    if (typeof document === 'undefined') { this.group.visible = this.presenting && !this.dismissed; return; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(WIDTH * PX);
    canvas.height = Math.round(height * PX);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = BACKGROUND;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, RADIUS * PX);
    ctx.fill();
    ctx.textBaseline = 'middle';

    // Title
    ctx.fillStyle = TEXT;
    ctx.font = FONT(0.022, 600);
    const title = this.mode === 'searching' ? `Searching Shopify via Browserbase — “${this.query}”` : `${this.recs.length ? this.recs.length : 'No'} listings for “${this.query}”`;
    ctx.fillText(ellipsis(ctx, title, (WIDTH - 2 * PAD - 0.06) * PX), (PAD + 0.05) * PX, (PAD + TITLE_H / 2) * PX);

    if (this.mode === 'searching') {
      this.rows.forEach((row, i) => {
        const cy = (PAD + TITLE_H + i * ROW_H + ROW_H / 2) * PX;
        ctx.fillStyle = row.stage === 'queued' ? SECONDARY : STAGE_COLOR[row.stage];
        ctx.beginPath();
        ctx.arc((PAD + 0.012) * PX, cy, 0.008 * PX, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = TEXT;
        ctx.font = FONT(0.019, 500);
        ctx.fillText(row.merchant, (PAD + 0.032) * PX, cy);
        ctx.fillStyle = SECONDARY;
        ctx.font = FONT(0.017);
        ctx.fillText(ellipsis(ctx, row.detail, (WIDTH - PAD - 0.24 - PAD) * PX), (PAD + 0.24) * PX, cy);
      });
    } else {
      if (!this.recs.length) {
        ctx.fillStyle = SECONDARY;
        ctx.font = FONT(0.018);
        ctx.fillText('Nothing fits that. Try a wider gap or another kind.', PAD * PX, (PAD + TITLE_H + CARD_H / 2) * PX);
      }
      cardRects(this.recs.length).forEach((r, i) => {
        const { listing: l, reasons } = this.recs[i];
        const x0 = PAD * PX, y0 = r.y * PX, w = (WIDTH - 2 * PAD) * PX, h = r.h * PX;
        ctx.fillStyle = CARD_BG;
        ctx.beginPath();
        ctx.roundRect(x0, y0, w, h, 0.012 * PX);
        ctx.fill();
        if (i === 0) { ctx.strokeStyle = ACCENT; ctx.lineWidth = 0.002 * PX; ctx.stroke(); }
        // Thumbnail
        const img = this.thumbs.get(l.objectId);
        const tx = x0 + 0.01 * PX, ty = y0 + (r.h - THUMB) / 2 * PX, ts = THUMB * PX;
        ctx.fillStyle = 'rgba(120,120,128,0.35)';
        ctx.fillRect(tx, ty, ts, ts);
        if (img?.complete && img.naturalWidth) {
          const s = Math.max(ts / img.naturalWidth, ts / img.naturalHeight);
          ctx.save(); ctx.beginPath(); ctx.rect(tx, ty, ts, ts); ctx.clip();
          ctx.drawImage(img, tx + (ts - img.naturalWidth * s) / 2, ty + (ts - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
          ctx.restore();
        }
        // Text column
        const cx = tx + ts + 0.014 * PX;
        const cw = x0 + w - cx - 0.01 * PX;
        ctx.fillStyle = TEXT;
        ctx.font = FONT(0.019, 600);
        ctx.fillText(ellipsis(ctx, l.name, cw), cx, y0 + 0.022 * PX);
        const { w: bw, h: bh, d: bd } = l.bboxMeters;
        const cm = (m: number) => Math.round(m * 100); // UI edge: the only place metres become cm
        const price = l.price ? ` · ${(l.price.cents / 100).toFixed(0)} ${l.price.currency}` : '';
        ctx.fillStyle = SECONDARY;
        ctx.font = FONT(0.016);
        ctx.fillText(ellipsis(ctx, `${l.merchant ?? 'catalogue'} · ${cm(bw)} × ${cm(bh)} × ${cm(bd)} cm${price}`, cw), cx, y0 + 0.05 * PX);
        const conf = l.measure?.confidence ?? 0.5;
        const badge = conf < 0.7 ? { text: 'size unverified', color: SECONDARY } : { text: 'fits', color: STAGE_COLOR.done };
        const status = this.progress.get(l.objectId);
        ctx.fillStyle = status ? ACCENT : badge.color;
        ctx.font = FONT(0.016, 500);
        ctx.fillText(ellipsis(ctx, status ?? `${badge.text} · ${reasons[0] ?? ''}`, cw), cx, y0 + 0.078 * PX);
      });
      if (this.note) {
        ctx.fillStyle = STAGE_COLOR.searching;
        ctx.font = FONT(0.016);
        const lines = wrap(ctx, this.note, (WIDTH - 2 * PAD) * PX);
        ctx.fillText(lines[0], PAD * PX, (height - PAD - ROW_H / 2) * PX);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, height),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 998;
    this.mesh.raycast = () => {};
    this.mesh.position.y = -height / 2;
    this.group.add(this.mesh);
    this.group.visible = this.presenting && !this.dismissed;
  }
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(text.slice(0, cut) + '…').width > maxPx) cut--;
  return text.slice(0, cut) + '…';
}

/** Same grey × as hud.ts, drawn once. */
function closeDisc(): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
  if (typeof document !== 'undefined') {
    const px = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(120,120,128,0.7)';
    ctx.beginPath(); ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 10; ctx.lineCap = 'round';
    const a = px * 0.33, b = px * 0.67;
    ctx.beginPath(); ctx.moveTo(a, a); ctx.lineTo(b, b); ctx.moveTo(b, a); ctx.lineTo(a, b); ctx.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    material.map = texture;
  }
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(CLOSE_R, 32), material);
  mesh.renderOrder = 1000;
  mesh.name = 'find-close';
  return mesh;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/xr && node --test src/findpanel.test.ts && npx tsc --noEmit`
Expected: 3 passing, tsc clean. If `wrap`'s ctx type complains, the `CanvasRenderingContext2D` satisfies `{ measureText }`.

- [ ] **Step 5: Commit**

```bash
git add apps/xr/src/findpanel.ts apps/xr/src/findpanel.test.ts
git commit -m "xr(findpanel): head-locked panel for Browserbase stages and listing cards"
```

---

### Task 5: Wire the panel, the stages, and the pick → generate → poll → swap flow

**Files:**
- Modify: `apps/xr/src/interaction.ts:83-86` (constructor's last param) and `:252-253` (selectstart)
- Modify: `apps/xr/src/main.ts`: imports (`:23`), panel construction (after `:112`), `onAction` (`:243`), `findFor` (`:329-352`), new `pickListing` + `swapLoaded` after `addListing` (`:357-380`), the Interaction constructor call (`:237`), the animation loop (`:1347`), and `renderListings` note (`:421-425`)
- Modify: `apps/xr/src/api.ts` (add `getJob`, `postListingsGenerate`)

**Interfaces:**
- Consumes: `FindPanel`, `PanelHit` (Task 4); `findLive`, `productQuery`, `STOREFRONTS`, `StageInfo` (Task 3); `POST /v1/listings/generate`, `GET /v1/jobs/{id}` (Task 2).
- Produces: `Interaction`'s last constructor param becomes `panelHit: (r: THREE.Raycaster) => string | null` returning an action string or null.

- [ ] **Step 1: Generalise the HUD hit hook in `interaction.ts`**

Replace the constructor's last parameter:

```ts
    /** An action for a ray on one of the head-locked panels ('hud:close', 'find:close', 'find:pick:<objectId>'), or null. */
    private panelHit: (raycaster: THREE.Raycaster) => string | null = () => null,
```

In `update()` replace `const onClose = !item && this.hudHit(this.raycaster);` with `const onClose = !item && this.panelHit(this.raycaster) !== null;`.

In `selectstart` replace `if (this.hudHit(this.raycaster)) return this.onAction('hud:close');` with:

```ts
        const panelAction = this.panelHit(this.raycaster);
        if (panelAction) return this.onAction(panelAction);
```

Grep for any other `hudHit` use and update it the same way.

- [ ] **Step 2: Add the two API helpers to `apps/xr/src/api.ts`**

After `getObject`:

```ts
export interface JobV1 { state: 'queued' | 'running' | 'done' | 'failed'; progressPct: number; objectId: string; error: string | null }

export function getJob(jobId: string): Promise<JobV1> {
  return get(`/jobs/${jobId}`);
}

/** POST /listings/generate: a picked /find row becomes an object and a mesh job. Not in contracts.md yet. */
export function postListingsGenerate(listing: unknown, roomId: string | null): Promise<{ objectId: string; jobId: string }> {
  return post('/listings/generate', { listing, roomId });
}
```

(`post` is defined further down in the file; function declarations hoist, so order does not matter.)

- [ ] **Step 3: Wire `main.ts`**

Imports (line 23 area):

```ts
import { findListings, needFromDetected, needFromText, isShoppingRequest, productQuery, STOREFRONTS, type Listing, type ListingsResult, type Need, type StageInfo } from './listings';
import { FindPanel } from './findpanel';
import { getJob, getObject, postListingsGenerate, objectToItem, boundsMismatch } from './api';
```

(Merge with the existing `./api` import rather than duplicating it.)

After the `hud` block (line 112):

```ts
const findPanel = new FindPanel();
findPanel.attachTo(scene);
renderer.xr.addEventListener('sessionstart', () => findPanel.setPresenting(true));
renderer.xr.addEventListener('sessionend', () => findPanel.setPresenting(false));
```

The Interaction constructor call (line 237), last argument:

```ts
(r) => {
  if (hud.hitTest(r)) return 'hud:close';
  const hit = findPanel.hitTest(r);
  if (!hit) return null;
  return hit.kind === 'close' ? 'find:close' : `find:pick:${hit.objectId}`;
}
```

In `onAction` after the `hud:close` line:

```ts
    if (action === 'find:close') findPanel.dismiss();
    if (action.startsWith('find:pick:')) void pickListing(action.slice(10));
```

Replace `findFor`:

```ts
  async function findFor(need: Need) {
    listingsNeed = need;
    listingsBusy = true;
    stageLines = [];
    const query = need.text ? productQuery(need.text) : need.categoryWords?.[0] ?? '';
    findPanel.showSearching(query, STOREFRONTS.map((s) => s.merchant));
    showPalette();
    renderListings();
    const onStage = (s: StageInfo) => {
      findPanel.setStage(s);
      stageLines = [...stageLines.filter((l) => !l.startsWith(`${s.merchant}:`)), `${s.merchant}: ${s.detail}`];
      renderListings();
    };
    try {
      listings = await findListings(need, 8, { onStage });
    } catch (err) {
      listings = { recommendations: [], source: 'bundled', note: `Listings unavailable: ${(err as Error).message}` };
    } finally {
      listingsBusy = false;
    }
    findPanel.showResults(listings.recommendations, listings.note);
    showPalette();
    renderListings();
    const top = listings.recommendations[0];
    const what = need.replaces ? `for the ${need.replaces.category}` : need.text ? `for "${need.text}"` : '';
    const spoken = top
      ? `${listings.recommendations.length} listings ${what}. Top pick: ${top.listing.name} from ${top.listing.merchant ?? 'the catalogue'}, ${top.reasons.join(', ')}.`
      : `Nothing for sale fits ${what}.`;
    tell(spoken, top ? 'info' : 'warn');
    if (need.text && lastHeard === need.text) speak(concise(spoken)); // only answer aloud when it was asked aloud
    return listings;
  }
```

Add near the other `let listings…` state (line 183):

```ts
let stageLines: string[] = []; // per-store Browserbase progress, mirrored on the laptop
```

In `renderListings`, change the busy text: `listingsBusy ? ['Searching via Browserbase…', ...stageLines].join(' · ')`.

Also in `renderListings`, make the laptop card's Add button run the same pick flow as the headset so it can be exercised on the desktop:

```ts
      add.textContent = l.glbUrl ? 'Add' : 'Add + generate mesh';
      add.addEventListener('click', () => void pickListing(l.objectId));
```

After `addListing`, add:

```ts
  /**
   * A card was picked in the headset: the box goes in now at true size, the Worker enqueues the
   * Baseten job, and the mesh replaces the box when the job is done — by SSE if the room is
   * live, else by polling GET /jobs/{id}.
   */
  async function pickListing(objectId: string) {
    const rec = listings?.recommendations.find((r) => r.listing.objectId === objectId);
    if (!rec) return say('That listing is no longer in the results.');
    const l = rec.listing;
    await addListing(objectId); // the measured box, placed where it belongs
    const placed = [...objects.values()].reverse().find((o) => o.objectId === objectId);
    findPanel.setProgress(objectId, 'Queued for Baseten…');
    let job: { objectId: string; jobId: string };
    try {
      job = await postListingsGenerate(l, SERVER_ROOM_ID);
    } catch (err) {
      findPanel.setProgress(objectId, `Couldn’t queue the mesh: ${(err as Error).message}`);
      return tell(`${l.name}: couldn’t queue the mesh — ${(err as Error).message}`, 'error');
    }
    // The server mints a stable id; the placed box keeps tracking it so SSE dedupe works.
    if (placed) placed.objectId = job.objectId;
    tell(`${l.name}: mesh job queued. It’s in the room as a box until Baseten answers.`, 'info');
    const started = Date.now();
    // ceiling: 3 s polling for up to 10 min; the SSE `object` event usually lands first and
    // addServerObject dedupes by objectId, so the poll only matters when the room feed is stubbed.
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      let j;
      try { j = await getJob(job.jobId); } catch (err) { findPanel.setProgress(objectId, `Job status unavailable: ${(err as Error).message}`); continue; }
      if (j.state === 'done') {
        try {
          const obj = await getObject(job.objectId);
          const item = objectToItem(obj);
          const loaded = await loader.load(item.url, 1); // scale 1: the mesh normalisation contract
          const mismatch = boundsMismatch(loaded.size, item.expected);
          if (mismatch) tell(`${item.name}: ${mismatch}.`, 'warn');
          if (placed && objects.has(placed.id)) swapLoaded(placed, loaded);
          findPanel.setProgress(objectId, 'Mesh placed at true scale');
          tell(`${l.name}: mesh ready and placed.`, 'info');
        } catch (err) {
          findPanel.setProgress(objectId, `Mesh failed to load: ${(err as Error).message}`);
          tell(`${l.name}: ${(err as Error).message}`, 'error');
        }
        return;
      }
      if (j.state === 'failed') {
        findPanel.setProgress(objectId, `Generation failed: ${j.error ?? 'unknown'}`);
        return tell(`${l.name}: generation failed — ${j.error ?? 'unknown error'}. The box stays.`, 'error');
      }
      const waiting = j.state === 'queued' && Date.now() - started > 20_000;
      findPanel.setProgress(objectId, waiting ? 'Waiting on Baseten — box placed at true size' : `Generating mesh ${j.progressPct}%`);
      if (Date.now() - started > 600_000) return findPanel.setProgress(objectId, 'Still waiting on Baseten; the box stays.');
    }
  }

  /** Replaces a placed object's mesh in place: same id, same spot, same heading. */
  function swapLoaded(obj: PlacedObject, loaded: LoadedObject) {
    const node = physics.nodeOf(obj.id);
    const x = node?.position.x ?? 0, z = node?.position.z ?? -1;
    const rotY = physics.rotationY(obj.id);
    physics.remove(obj.id);
    obj.loaded.node.removeFromParent();
    obj.loaded = loaded;
    scene.add(loaded.node);
    physics.addObject(obj.id, loaded.node, loaded.size, loaded.hull, { x, z }, rotY);
    showPalette();
    layoutChanged(obj.id);
  }
```

In the animation loop after `hud.place(...)`:

```ts
    findPanel.place(renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
```

- [ ] **Step 4: Typecheck and run the existing tests**

Run: `cd apps/xr && npx tsc --noEmit && npm test`
Expected: clean; every test passes. Fix any `hudHit` leftovers tsc reports.

- [ ] **Step 5: Desktop smoke test against the stub**

Run: `cd apps/xr && npm run dev` and open the printed URL with `?room=<any>` omitted (stub mode is on by default).
In the laptop sidebar, type `find me a lamp under 1.5 m` and click Search. Expected: the laptop note line reads "Searching via Browserbase… · Poly & Bark: 1 found, 1 measured, 1 fit · …" as each stub answers, then three MacBook cards render (one per storefront, same stub row). The head-locked panel only shows while presenting in VR; to see it on the desktop, temporarily run `findPanel.setPresenting(true)` from a `window.__findPanel = findPanel` line you remove before committing.

Click "Add + generate mesh" on the first card. Expected: a translucent box of the MacBook's size appears in the room, the note line and the card status read "Queued for Baseten…", then (the stub job answers `running 42%` forever) "Generating mesh 42%". Reload to stop the poll.

- [ ] **Step 6: Commit**

```bash
git add apps/xr/src/main.ts apps/xr/src/interaction.ts apps/xr/src/api.ts
git commit -m "xr(find): voice find shows Browserbase stages in a head-locked panel; picking a card queues the mesh and swaps the box"
```

---

### Task 6: End-to-end verification against the live stack

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-quest-voice-find-listings-design.md` (append a "Verified" section with what was observed)

- [ ] **Step 1: Run the Worker locally against the live ingest tunnel**

The deployed Worker's KV holds `upstream:ingest`; `wrangler dev` uses local KV. Either run against the deployed Worker (after Thomas deploys Task 2) or set the local KV:

```bash
cd workers && npx wrangler kv key put --binding CONFIG upstream:ingest "$(curl -s https://full-scale-workers.thomaszhangdev.workers.dev/v1/health | python3 -c 'import json,sys;print(json.load(sys.stdin)["upstreams"]["ingest"])')" --local
```

and put `UPSTREAM_TOKEN` in `workers/.dev.vars` (ask Thomas for the value; do not commit it). Then `npm run dev`.

- [ ] **Step 2: Real find**

```bash
curl -s -m 120 -X POST localhost:8787/v1/find -H 'content-type: application/json' \
  -d '{"storefront":"https://polyandbark.com/","merchant":"Poly & Bark","query":"floor lamp","limit":6}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["handles"],d["measured"],d["fitting"],d["searchUrl"]);[print(l["name"],l["bboxMeters"],l["extraction"]["imageUrl"]) for l in d["listings"]]'
```

Expected: non-zero handles, at least one measured row with an `https://cdn.shopify.com/...` image. Record the numbers.

- [ ] **Step 3: Real pick**

Take one listing from Step 2 and:

```bash
curl -s -X POST localhost:8787/v1/listings/generate -H 'content-type: application/json' -d '{"listing": <that row>, "roomId": null}'
curl -s localhost:8787/v1/jobs/<jobId>
```

Expected: 202 with `objectId` and `jobId`; the job is `queued` and stays queued because Baseten secrets are unset. That is the correct fail-loud state. Note it.

- [ ] **Step 4: Headset run**

`cd apps/xr && VITE_API_STUB=0 npm run dev`, open on the Quest, Enter VR, hold the talk tile and say "find me a floor lamp". Expected: the panel appears ahead-right, three rows animate, cards appear with thumbnails, pointing at a card and pressing the trigger drops a box at true size and the card line reads "Queued for Baseten…" then "Waiting on Baseten — box placed at true size".

- [ ] **Step 5: Record and commit**

Append to the spec:

```markdown
## Verified 2026-09-20

- `/v1/find` against Poly & Bark "floor lamp": <handles> handles, <measured> measured, <fitting> fit, <seconds> s.
- `/v1/listings/generate`: 202, job stays `queued` (Baseten secrets unset on the Worker).
- Headset: stages, cards, pick → box, progress line. Thumbnails: <loaded | placeholder>.
```

```bash
git add docs/superpowers/specs/2026-09-20-quest-voice-find-listings-design.md
git commit -m "docs: record verified find → listings → pick run"
```
