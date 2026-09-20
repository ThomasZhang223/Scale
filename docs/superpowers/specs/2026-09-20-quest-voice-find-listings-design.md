# Quest voice find → Browserbase listings → pick → Baseten mesh

Date: 2026-09-20. Owner: Justin (apps/xr). Touches workers/** (Thomas's path) with two small routes,
flagged in the commit message.

## Goal

In the headset, say "find me a lamp under 1.5 m". The headset shows Browserbase rendering each
verified merchant's search page, then a list of measured listings that fit. Selecting one enqueues
the Baseten mesh job, places a true-size box in the room immediately, and swaps in the GLB when the
job finishes.

## What exists (verified 2026-09-20)

- `apps/xr/src/main.ts` `routeRequest()` already sends utterances matching `isShoppingRequest()`
  (`listings.ts`) to `findFor(needFromText(text))`, which calls `POST /v1/search` (indexed catalog)
  and falls back to the bundled `/catalog.json`. Nothing reaches Browserbase.
- `services/ingest` `POST /find { storefront, query, limit? }` renders the merchant's search page
  via Browserbase Fetch and returns raw Shopify products. `POST /extract { products, merchant,
  storefront, browserbase, fit? }` returns Object v1 rows (`state:"measured"`, `glbUrl:null`) with
  `extraction.imageUrl` and `extraction.fits`. Both need `x-upstream-token`, so the headset cannot
  call them directly.
- The deployed Worker (`full-scale-workers.thomaszhangdev.workers.dev`) has `upstream:ingest` set
  and `UPSTREAM_TOKEN` present. `callUpstream(env, "ingest", path, body)` in
  `workers/src/lib/config.ts` already adds the token.
- `workers/src/lib/catalog-ingest.ts` `normalizeCatalogItem` + `enqueueCatalogItem` turn a
  catalogue row into a D1 object and a mesh job whose workflow downloads the product image first.
  `POST /v1/catalog/ingest` is token-gated. `POST /v1/objects/{id}/generate` cannot be used for a
  catalogue row because it does not pass the catalogue item, so the workflow finds no frames.
- Baseten secrets are unset on the deployed Worker. Accepted mesh jobs wait durably.
- Headset panels are canvas textures on `PlaneGeometry` (`hud.ts` `Hud`, `palette.ts` `Palette`).
  `interaction.ts` routes controller select to `palette.hitTest` and `hud.hitTest`.
- Verified storefronts (`services/ingest/merchants.verified.json`): Poly & Bark
  `https://polyandbark.com/` (247 usable), InStyle Home `https://instylehome.ca/` (106),
  Sabai Design `https://sabai.design/` (8).

## Architecture

```
Quest push-to-talk ──ElevenLabs STT──▶ routeRequest()
   │ isShoppingRequest
   ▼
findLive(need)  ── 3× parallel ──▶ POST /v1/find {storefront, merchant, query, fit, limit}
   │                                    │ callUpstream ingest /find   (Browserbase render)
   │  FindPanel stage updates           │ callUpstream ingest /extract (browserbase:true, fit)
   ◀────────────────────────────────────┘ {merchant, searchUrl, stages, fallbackSuspected, listings[]}
   ▼
FindPanel cards ── select ──▶ POST /v1/listings/generate {listing, roomId}
   │                               │ normalizeCatalogItem → enqueueCatalogItem(roomId)
   │  measuredBox placed now       ▼ {objectId, jobId}
   │                          GenerateMeshWorkflow → finalize → emitToRoom(roomId,"object")
   ◀── existing SSE watchRoom → addServerObject swaps box for GLB
```

## Worker (workers/src)

### `POST /v1/find`

Body: `{ storefront: string, merchant: string, query: string, fit?: {maxW?,maxH?,maxD?}, limit?: number }`.
All lengths metres. `storefront`, `merchant`, `query` required → 400 `missing_field` (standing rule 4).

Steps:
1. `callUpstream(env, "ingest", "/find", { storefront, query, limit })`, timeout 45 s.
2. If `products` empty, return early with `listings: []` and the ingest response's `searchUrl`,
   `fallbackSuspected`, `warning`.
3. `callUpstream(env, "ingest", "/extract", { products, merchant, storefront, browserbase: true,
   pageLimit: 12, fit })`, timeout 60 s.
4. Return `{ merchant, storefront, searchUrl, searchedFor, handles: n, products: n, measured: n,
   fitting: n, fallbackSuspected, warning, stats, listings }` where `listings` are the extract
   `objects` unchanged (Object v1 + `extraction`).

Nothing is written to D1. The route is a pure fan-in of two upstream calls. Stub (`X-Stub: 1`):
returns a committed body with two listings derived from `fixtures/object-macbook.json` shape, in
`workers/src/index.ts` route table.

Errors: upstream failures already become 502 `upstream_unreachable` / `upstream_error` via
`callUpstream`. `browserbase_unconfigured` (503 from ingest) surfaces as 502 `upstream_error` with
the detail text; the headset shows the detail.

### `POST /v1/listings/generate`

Body: `{ listing: <Object v1 row from /v1/find>, roomId?: string | null }`.
1. `normalizeCatalogItem(listing)` (existing). `imageUrl` is read from `listing.extraction.imageUrl`
   (already supported by the normaliser).
2. `enqueueCatalogItem(env, item, origin, roomId)` — add an optional `roomId` parameter to the
   existing function, default `null`, threaded into `enqueueMesh` so the workflow's `finalize`
   emits to the room.
3. Respond 202 `{ objectId, jobId }`.

Public, no token: it can only enqueue a job for a row the Worker itself normalised, and the jobId
is content-addressed so repeats never double-charge (existing behaviour). Stub returns
`{ objectId: objectMacbook.objectId, jobId: STUB_JOB_ID }`.

Both routes go in `workers/src/routes/index.ts` (handlers) and `workers/src/index.ts` (dispatch +
stub table). Commit message flags them for Thomas and notes they are not yet in contracts.md.

## Headset (apps/xr/src)

### `listings.ts`

- `STOREFRONTS = [{ merchant:"Poly & Bark", storefront:"https://polyandbark.com/" }, { merchant:"InStyle Home", storefront:"https://instylehome.ca/" }, { merchant:"Sabai Design", storefront:"https://sabai.design/" }]`.
- `productQuery(text)`: strips leading imperative/article noise (`find|show|get|recommend … (me)? (a|an|some)?`) and trailing length phrases already parsed into `Need`. Returns the remaining words. No LLM.
- `findLive(need, onStage)`: runs `POST /v1/find` for each storefront in parallel via
  `Promise.allSettled`. `onStage(merchant, stage, detail?)` is called with stages
  `'sent' | 'searching' | 'measuring' | 'done' | 'failed'`. `searching` fires on send,
  `measuring` when the response arrives (the Worker does both calls, so the client marks
  `measuring` at 55% of a 40 s expected duration if the response has not arrived — see
  ceiling comment), `done` with `{handles, measured, fitting}`, `failed` with the error text.
- Merges listings across stores, runs the existing `rank(rows, need, limit)`, returns
  `ListingsResult` with `source:'live'`. Falls back to bundled only when every store failed, and
  the note says so.
- `findListings` keeps its signature; `live` default becomes `findLive`.

Ceiling comment on stage timing: `/v1/find` is one round trip, so the headset cannot see the
find/extract boundary. Upgrade path: stream stages from the Worker as SSE.

### `findpanel.ts` (new)

`FindPanel` class, same construction as `Hud`: one canvas → `CanvasTexture` → `PlaneGeometry`,
`depthTest:false`, `renderOrder 999`, placed each frame on the eye ray at 0.9 m, offset right of
the transcript HUD so both are visible. Width 0.6 m.

States:
- `searching`: title "Searching Shopify via Browserbase — “<query>”", one row per store:
  merchant name, stage dot (grey → amber pulse → green/red), stage text ("rendering search
  page…", "measuring 12 products…", "8 fit", "failed: …").
- `results`: up to 6 cards, each 0.6 × 0.11 m: thumbnail 0.09 m square (left), name (1 line,
  ellipsis), merchant · W×H×D in cm (converted at draw time only), fit badge ("fits" green /
  "too big" amber / "size unverified" grey), price when present. First card outlined.
  "Nothing fits" row when empty. Close × like `Hud`.
- `generating`: after a pick, the chosen card stays with a progress line ("Queued for Baseten",
  "Generating mesh 42%", "Waiting on Baseten — box placed at true size").

Thumbnails: `Image` with `crossOrigin='anonymous'`, drawn when loaded, panel redraws. On error a
neutral placeholder square. Every card has a hit rect; `hitTest(raycaster)` returns
`{ kind:'card', objectId } | { kind:'close' } | null`.

### `main.ts`

- Construct `FindPanel`, add to scene, call `place(camera)` per frame beside `hud.place`.
- `findFor(need)`: `panel.showSearching(query, STOREFRONTS)`; pass `onStage` → `panel.setStage`.
  On result → `panel.showResults(recommendations)`; keep the wrist palette rows and laptop
  cards as today. `say()` the summary as today.
- `interaction.ts`: on `selectstart`, after HUD close check, test `findPanel.hitTest`; card →
  `pickListing(objectId)`, close → hide.
- `pickListing(objectId)`: 
  1. Place `measuredBox(l.bboxMeters, l.name)` now (existing `addListing` path, reused).
  2. `POST /v1/listings/generate { listing, roomId: SERVER_ROOM_ID }` → `{objectId, jobId}`.
  3. Poll `GET /v1/jobs/{jobId}` every 3 s, up to 10 min; update `panel.setProgress`. On
     `done`, `GET /v1/objects/{objectId}` and replace the placed box's `loaded` with the GLB
     (scale 1, `boundsMismatch` check as in `addServerObject`), keeping position. On `failed`,
     `say()` the error and keep the box. If SSE delivers the `object` first, `addServerObject`'s
     dedupe by objectId wins and the poller stops.
  4. If the job stays `queued` past 20 s, the panel line reads "Waiting on Baseten — box placed
     at true size" (secrets unset today).

### Desktop mirror

The laptop sidebar already renders listing cards; add the per-store stage lines to `listingNote`.

## Testing

- Worker: `vitest` unit tests for `postFind` (mock `callUpstream`: happy path, empty find,
  extract error) and `postListingsGenerate` (normaliser rejects missing image; roomId threaded).
  Stub table answers with `X-Stub: 1`.
- Headset: unit tests for `productQuery` and `findLive` stage sequencing with a fake `fetch`.
  `FindPanel` draw is exercised in the desktop browser; `hitTest` unit-tested with a raycaster
  aimed at a card centre.
- Manual: `wrangler dev` in `workers/` against the live ingest tunnel; `npm run dev` in
  `apps/xr` with `VITE_API_STUB=0`; type "find me a lamp under 1.5 m" in the laptop textarea;
  confirm three stage rows resolve and cards render; click a card; confirm a job row appears
  and the box is placed.

## Out of scope

- Configuring Baseten secrets (Ani).
- Streaming find/extract stages from the Worker (ceiling noted).
- Adding `Listing` or the two routes to `.claude/contracts.md` (propose to Thomas).
- Marketplace or non-Shopify sources.
