# Interface contracts — the authority

If this file and any other file disagree, this file wins. Changing anything here is a contract
change: say so in the group chat before you push it, because someone is building against it.

Extracted from `BUILD_DOC.md`. Edit here, then re-sync the design doc — never the other way.

---

## The four schemas

Write these four schemas before you write anything else. Every component in `BUILD_DOC.md` is an implementation detail behind them.

### Global conventions

These are not negotiable per component. A component that breaks one of them corrupts every other component silently.

| Thing | Convention |
| --- | --- |
| Length | Metres, float. Never centimetres, never inches, never millimetres. Convert at the UI edge only. |
| Angle | Degrees, float, counter-clockwise seen from +Y. |
| Money | Integer cents plus an ISO 4217 code. Never a float. |
| Time | ISO 8601 with a `Z` suffix. Compute in UTC, convert once for display. |
| Axes | Right-handed, +Y up. The ARKit world frame with `.gravityAndHeading`, so −Z points to true north and +X points east. |
| Transform | 16 floats, column-major. This matches `simd_float4x4` memory order and `THREE.Matrix4.fromArray` with no transpose. |
| Id | UUID v4 string, minted by the client, so a scan works offline and reconciles later. |

### RoomCapture v1 — Thomas writes and stores, Justin reads

```json
{
  "schemaVersion": 1,
  "roomId": "uuid",
  "capturedAt": "2026-09-20T02:11:04Z",
  "worldAlignment": "gravityAndHeading",
  "northBearingDeg": 0.0,
  "floor": { "polygon": [[x, z]], "areaM2": 18.4 },
  "walls": [{
    "id": "uuid",
    "transform": [16 floats],
    "dimensions": [width, height, thickness],
    "confidence": "high|medium|low"
  }],
  "openings": [{
    "id": "uuid",
    "kind": "door|window|opening",
    "wallId": "uuid",
    "transform": [16 floats],
    "dimensions": [width, height, 0],
    "hingeSide": "left|right|unknown",
    "swingDeg": 90
  }],
  "objects": [{
    "id": "uuid",
    "category": "table|chair|bed|sofa|storage|…",
    "transform": [16 floats],
    "dimensions": [w, h, d],
    "confidence": "high|medium|low"
  }]
}
```

Optional, added post-launch — absent renders exactly as today, boxes with no colour:

```json
"appearance": {
  "surfaces": {
    "<wallId>": { "hex": "#9a968e", "textureKey": "rooms/{roomId}/appearance/front.jpg",
                  "textureUrl": null, "rotationDeg": 0, "mirrored": false },
    "floor":    { "hex": "#666560", "textureKey": null, "textureUrl": null,
                  "repeat": [2.2623, 2.5792] },
    "ceiling":  { "hex": "#80766e", "textureKey": null, "textureUrl": null, "rotationDeg": 180 }
  }
}
```

A surface key is present only when A actually sampled a colour for it — RoomPlan has no ceiling
category, so `"ceiling"` is often absent, not a guessed default. **Appearance is never a source
of dimensions.** When the shell and the parametric wall disagree, the parametric wall is right.
Justin renders the visual on layer 0 and the parametric boxes on layer 1 at `visible = false`, so
`raycaster.layers.set(1)` still hits them — that is for a baked shell mesh arriving beside the
walls. A per-surface photo needs no such split: it rides on the inward face of the parametric box
itself, which is already the visual, the collider and the raycast target.

Four fields, all optional, all additive — a surface with none of them renders exactly as before:

| Field | Meaning |
| --- | --- |
| `textureKey` | The R2 key of that surface's rectified photo, `rooms/{roomId}/appearance/{surface}.jpg`. Stored in the capture. |
| `textureUrl` | The same photo as a URL. **`GET /rooms/{id}` fills this in from `textureKey`**; a stored capture leaves it `null`. Key in the database, URL in the API, as for `glb_key` → `glbUrl`. A client never resolves a key. |
| `rotationDeg` | `0`, `90`, `180` or `270`. Which image edge meets which wall. Any other value is rejected. |
| `mirrored` | Mirrors the photo across its own vertical axis. The escape hatch; `false` everywhere today. |
| `repeat` | `[u, v]`. How many times the photo covers the surface. **Absent means once, and once is the normal case.** Present only when the photo turned out to cover a sub-region, and then the factor comes from a measured physical size. A repeating photo wraps `MirroredRepeatWrapping`, so each copy meets its neighbour in its own reflection; a non-repeating one clamps. A quarter turn of 90° or 270° needs `u === v`, or the photo stretches along the wrong axis. |

The photo is a four-point transform of the surface rectangle onto the WHOLE image, so **the image
aspect is not the surface aspect**. It fills the surface's true metre rectangle exactly once —
UV 0..1, never aspect-fitted. That stretch is what undoes the transform.

`repeat` is the one exception, and it is a measurement, not a preference. The demo room's floor
photo covers 2 × 3 carpet tiles rather than the whole floor, so stretched once the tiles rendered
1.38 × 1.57 m. Taking the tile as **0.61 m square (24 in, the North American standard — nobody has
put a tape on it)**, `repeat = [2.76 / (2 × 0.61), 4.72 / (3 × 0.61)]` puts it back at 0.61 m
square. The two factors differ because the tiles are not square in the rectified photo; that is
the warp, and separate u and v is what undoes it. **`repeat` is appearance, never a dimension.**

A wall that carries a photo is drawn whole: its door and window are in the picture already, so
nothing is cut out of it. A wall with no photo still gets its openings cut, as before.

Notes that matter:

- `worldAlignment` must be the literal `"gravityAndHeading"`. If A ever emits anything else, B rejects the upload with HTTP 422. Without true north the sun simulation is invented, and retrofitting means re-scanning every room.
- `northBearingDeg` is redundant with the frame, but store it anyway. It is the one value a reviewer can check against a compass on the table.
- RoomPlan already gives segmentation. Object removal is `object.visible = false` on a thing the API labelled. Nobody implements segmentation.
- Transport is JSON, never USDZ. D rebuilds walls as boxes, openings as gaps, and objects as per-category proxies. The USDZ → GLB conversion chain is where the weekend dies.

### Object v1 — the convergence type

Every object, from a phone scan, a Shopify product, or a primitive fallback, is this shape. The fit engine reads `bboxMeters` and nothing else.

```json
{
  "schemaVersion": 1,
  "objectId": "uuid",
  "source": "scan|catalog|primitive",
  "state": "measured|generating|ready|failed",
  "name": "MacBook Pro 14",
  "category": "laptop",
  "glbUrl": null,
  "bboxMeters": { "w": 0.3126, "h": 0.0155, "d": 0.2212 },
  "measure": { "method": "lidar|extracted|declared", "confidence": 0.94 },
  "caption": "matte space-grey aluminium laptop, closed",
  "palette": ["#3a3a3c", "#8e8e93"],
  "price": { "cents": 199900, "currency": "CAD" },
  "productUrl": null,
  "merchant": null,
  "createdAt": "2026-09-20T02:12:09Z"
}
```

A `source:"scan"` object whose mesh came from the phone's Object Capture has no binding step —
Object Capture writes metres at true size, so `bboxMeters` is the exported mesh's own bounding box
and invariant 1 below holds by construction — and its GLB lives under `scans/`, not `objects/`.
`source` is `"scan"`, never `"capture"`. Such an object carries `measure.method: "declared"`.

`state` is the perceived-latency fix, and it lives in the schema rather than in the UI. A returns `state:"measured"` with a real `bboxMeters` and a null `glbUrl` in under one second. The client renders the measured box with its numbers straight away. `glbUrl` arrives later, over SSE, when `state` becomes `ready`.

### The mesh normalisation contract

C guarantees all four of these for every GLB it publishes. This is the single most important sentence in the document for anyone downstream.

1. The mesh axis-aligned bounding box equals `bboxMeters`, to within 1 mm.
2. The origin sits at the bottom-centre of that box, so a placement `y` of 0 means "on the floor".
3. +Y is up and −Z is the front face.
4. Units in the GLB are metres, so the glTF node scale is 1.

A consumer that applies its own scale factor is a bug, not a preference.

### Placement v1 and Version v1 — Thomas stores, Justin renders and validates

```json
{
  "placementId": "uuid",
  "objectId": "uuid",
  "p": [x, y, z],
  "yawDeg": 0.0,
  "scale": 1.0,
  "lockedToWallId": null,
  "flags": ["blocks_door_swing"]
}
```

```json
{
  "schemaVersion": 1,
  "versionId": "uuid",
  "roomId": "uuid",
  "parentId": "uuid|null",
  "label": "under $1200",
  "createdAt": "2026-09-20T04:40:00Z",
  "placements": [],
  "materials": { "wall": "#8a9a7b", "floor": "oak-natural", "trim": "#ffffff" },
  "contentHash": "sha256 of placements + materials, keys sorted"
}
```

`scale` exists only for an explicit user override and must be 1.0 everywhere else. E raises a warning when it sees any other value, because a non-unit scale means somebody broke the normalisation contract upstream.

A version is immutable. An edit writes a new version with `parentId` set to the old one. That is what makes history free: hash the layout, keep parent pointers, diff two versions into added, removed, and moved.

## API, storage, and stubs

B ships this surface as stubs in hours 0–2. Real logic lands behind it afterwards. Nobody waits.

### HTTP surface (Cloudflare Workers, base `/v1`)

| Method + path | Body | Returns | Consumer |
| --- | --- | --- | --- |
| `POST /rooms` | `RoomCapture v1` | `{ roomId }` | A |
| `GET /rooms/{id}` | — | `RoomCapture v1` | D, E |
| `POST /rooms/{id}/versions` | Version without ids | `Version v1` | A, D, F |
| `GET /rooms/{id}/versions` | — | `[{ versionId, label, createdAt, parentId }]` | A, D |
| `GET /versions/{id}` | — | `Version v1` | D |
| `POST /uploads` | `{ kind, ext?, objectId?, roomId?, n?, merchant?, productId? }` | `{ key, putUrl }` — `putUrl` points back at the Worker, which streams the PUT into R2 | A, C |
| `POST /objects` | `{ source, name, category, bboxMeters, measure, frameKeys[] }` | `Object v1` with `state:"measured"` | A |
| `GET /objects?source=&merchant=&limit=` | — | `[Object v1]`, newest first, `state != 'failed'`; `limit` 1-500, default 100 | A, D |
| `GET /objects/{id}` | — | `Object v1`. Response headers `X-Scan-Thumb: none\|pending\|done\|failed`, plus `X-Scan-Thumb-Attempts` and `X-Scan-Thumb-Error` when there is one — the state of the row's rendered picture. Headers and not body, because `Object v1` is a shared schema and this is operational detail | all |
| `POST /objects/{id}/generate` | `{ tier: "live" \| "quality" }` | `{ jobId }` | A, C |
| `POST /objects/{id}/mesh` | `{ key, roomId? }` — `key` must be `scans/{id}/mesh.glb` for a `source:"scan"` object and `objects/{id}/mesh.glb` for `catalog` or `primitive` | `Object v1` with `state:"ready"` | A, C |
| `POST /objects/{id}/index` | `{ imageKey }` or `{ text }` (exactly one), `X-Upstream-Token` | `{ objectId, fingerprint, modality }` | backfill, retry |
| `GET /jobs/{id}` | — | `{ state, progressPct, objectId, error }` | A |
| `POST /search` | `{ text?, imageKey?, fit?, source?, limit }` | `[{ objectId, score, object }]` | F |
| `POST /fit` | `{ roomId, versionId }`, `{ roomId, placements }`, or `{ roomId }` alone (the newest version's placements) | `FitReport v1` | A, D |
| `POST /solve` | `{ roomId, intent, budgetCents?, fixed[] }` | `{ answer, plan, placements, version, toolCalls }` — `answer` the agent's prose; `plan` the rules it gave the solver, `{ summary, movable?, rules }`, or `null`; `placements` `[Placement v1]` (empty when nothing was placed); `version` the committed `Version v1` or `null`; `toolCalls` `[{ name, arguments }]`. There is no `objective` or `infeasible` field: an infeasible plan is reported inside `answer`. A body `objectIds` is accepted and ignored | F |
| `POST /push/{roomId}` | `{ versionId }` | `204` | A, F |
| `GET /sync/{roomId}` | — | SSE stream | D |
| `POST /ingest` | `{ merchant, storefront, collection?, browserbase?, llm?, vlm? }`, `X-Upstream-Token` | `202 { workflowId, merchant, storefront }` | operator, P3 |
| `POST /catalog/ingest` | `[item]` or `{ products \| objects \| items }`, 1-100, `X-Upstream-Token` | `202 { accepted, jobs: [{ objectId, jobId }] }` | scrapers |
| `POST /find` | `{ storefront, merchant, query, fit?, limit? }` — one live storefront; the Worker fans into `services/ingest` `/find` then `/extract` with the upstream token the browser never holds | `{ merchant, storefront, searchUrl, searchedFor, handles, products, measured, fitting, fallbackSuspected, warning, listings: [Object v1-shaped row + imageUrl] }`. Writes nothing. With `FIND_READY_ONLY="1"` each row also carries `findSource` (`"storefront"` \| `"catalog"`) and the response carries `X-Find-Source: storefront=N,catalog=N,dropped=N,unidentified=N,stretched=N,unrated=N` — see below | F (headset, three stores in parallel) |
| `POST /objects/{id}/thumbnail` | Raw JPEG or PNG bytes, no wrapper. `?force=1` replaces an existing one | `202 { objectId, key, stored, indexed:"pending" }`, or `200 { stored:false }` when one already exists. Scans only (`422 not_a_scan` otherwise): stores `scans/{id}/thumb.jpg` and IMAGE-embeds it through `indexObject`, so a text query can finally rank scans apart. The vector takes 20-30 s to appear | F (headset thumbnail cache) |
| `POST /listings/generate` | `{ listing, roomId? }` — a row picked from `/find` | `202 { objectId, jobId }`. Reuses the catalogue intake: one D1 object (`source:"catalog"`) and one mesh job; `roomId` makes the ready mesh arrive on that room's SSE feed. When the object is ALREADY `ready` with a mesh: `200 { objectId, jobId: null, state, glbUrl }` — no second job, no state change | F |

**`FIND_READY_ONLY` (Worker `[vars]`, additive and optional).** `"1"`: `/find` still runs the
merchant's own search, then keeps only the products whose catalogue row is already
`state='ready'` with a `glb_key`, joined on the one catalogue identity rule (`catalogObjectId`
in `workers/src/lib/catalog-ingest.ts` — `productUrl` first, `merchant:productId` as fallback,
the merchant label in both its raw and its slugged spelling). A short result is topped up from
the same meshed catalogue through `/v1/search` restricted to `source:"catalog"`, for the same
query text. Every kept row is `state:"ready"` with a `glbUrl`, so a client places the mesh at
once and never draws a measured box for it. Rows are then ordered least-distorted first — at or
below the binder's 1.5 ratio, then unrated, then above it — from a committed fixture
(`workers/src/lib/distortion-ratios.ts`). Nothing is hidden by that ordering. `"0"`: the fully live path — every found row, mesh
generated on pick. Unset or any other value is a `500 bad_config`, never a guessed side.

Notes on the rows above that are not in the table:

- `POST /uploads` `kind` is one of `roomCapture`, `objectFrame`, `objectMesh`, `objectThumb`,
  `scanMesh`, `catalogSource`. `scanMesh` is the phone's Object Capture GLB and lands under
  `scans/`; `objectMesh` is the generated mesh's key under `objects/` and is Ani's, unchanged.
- `POST /objects/{id}/mesh` loads the row first (404 if absent), then expects the key that matches
  the row's `source` and no other — never a scan under `objects/`, never a catalogue object under
  `scans/` (400 `bad_mesh_key`, naming the expected key and the source). It refuses bytes that are not a binary glTF — bad magic, version or declared length — with 422
  `not_a_glb`, leaving the row `measured`. It answers before the object is searchable: the
  response carries `X-Indexed: pending` (indexing runs in the background),
  or `X-Indexed: false` with `X-Index-Skipped: no-embeddable-text` when a catalogue or library row
  has no name or category to embed. A `source:"scan"` row answers `X-Indexed: scan-thumb-pending`
  instead and is NOT indexed from text — see "Every scan is searchable" below.
**Every scan is searchable, with no headset in the loop (additive).** Object Capture uploads a
mesh and no photo, so a scan's only text is "Captured object" / "unknown" — the same words on
every row, one point in the embedding space, and no query can tell two scans apart. So the
picture is made instead, in the pipeline:

1. `POST /objects/{id}/mesh` on a `source:"scan"` row writes one `scan_thumb_jobs` row
   **before it answers**, and answers `X-Indexed: scan-thumb-pending`. That row is the
   acceptance; nothing after it is best-effort.
2. A background step opens `GET {RENDER_ORIGIN}/thumb?glb=/v1/assets/scans/{id}/mesh.glb` in
   Cloudflare Browser Rendering. The page is `apps/xr/thumb.html`, and it calls the same
   `renderThumbnail()` the headset calls, so the framing is shared by construction: 512 square,
   JPEG q0.9, white, camera (1, 0.65, 1), box framed to 88%. The completion signal is the page's
   CANVAS, which it appends only on success — `quickAction` cannot evaluate JavaScript, so
   `window.__thumb` is out of reach and `waitForSelector` waits for the element instead.
3. The JPEG is stored at `scans/{id}/thumb.jpg` and IMAGE-embedded through `indexObject` — the
   same key and the same indexer `POST /objects/{id}/thumbnail` uses. There is one render
   implementation and one index implementation, called from two places.

`RENDER_ORIGIN` is a Worker `[vars]` entry: the origin that serves `/thumb`. Unset, or not
`https://`, is never guessed — the step records `failed` naming the var, and `/v1/health` says
`scanThumbs.renderOriginConfigured: false`.

The headset's own upload stays as the second path. Whichever finishes first wins, and the other
is cheap: an existing `scans/{id}/thumb.jpg` skips the render but still re-runs the index, which
is an upsert on the same vector id — that is what repairs a stored picture whose background
index failed.

Retries are bounded: 4 attempts, backing off 60 s, 120 s, 240 s, driven by the one-minute cron,
one object per tick (a second Browser Rendering action fired immediately answers HTTP 429). On
the last attempt the row stops at `failed` with the reason, and a text vector is written as a
floor so the object is no worse off than before this existed. Every state is readable on
`GET /objects/{id}` headers and on `GET /health` under `scanThumbs`.

- When `POST /objects/{id}/mesh` succeeds for a non-scan object (a reviewed hero mesh attached to a
  catalogue object), that object's parked mesh jobs — `kind:"mesh"`, `state:"queued"` — become
  `done` at 100% with the note `mesh attached via POST /mesh (reviewed offline); generation
  skipped`, and their undelivered outbox rows are marked delivered. A generation job that already
  reached the workflow is refused by its first step when the object is `ready` with a `glb_key`, so
  an attached mesh is never overwritten.
- `POST /search` with `text` and no `source` searches `source:"catalog"` only and answers
  `X-Search-Scope: catalog-default`; the index holds catalogue rows as image vectors and scans and
  primitives as text vectors, which score on different scales, so an unscoped text query would rank
  every placeholder above every product. An explicit `source` is always honoured and adds no header.
- `POST /objects/{id}/index`, `POST /ingest` and `POST /catalog/ingest` spend money or write a
  shared index, so all three need `X-Upstream-Token`.
- Object ids on the catalogue intake are computed by the Worker, whichever route the row came
  through: a hash of `productUrl`, else of `merchant:productId`, else of the sender's `objectId`.
  An id the sender supplies is advisory, never stored as given.
- `POST /solve` places by rule: the model's rule targets are resolved against the room by the
  Worker, and a target that resolves to nothing is a 422 `unknown_rule_target` naming it.

`fit` in a search body is a numeric filter, not a vector term: `{ "maxW": 0.8, "maxH": 1.2, "maxD": 0.6 }`. That is the half of the query Kreativ cannot express.

### FitReport v1

```json
{
  "schemaVersion": 1,
  "ok": false,
  "checkedAt": "2026-09-20T05:02:00Z",
  "violations": [{
    "kind": "door_swing|clearance|wall_gap|window_occlusion",
    "severity": "block|warn",
    "placementId": "uuid",
    "detailMeters": 0.11,
    "message": "blocks the door swing by 11 cm",
    "geometry": { "type": "arc", "center": [x, z], "radiusM": 0.9, "startDeg": 0, "endDeg": 90 }
  }]
}
```

`geometry` exists so Justin and Thomas can draw the violation in red without re-deriving it. Supported types are `arc`, `polyline`, and `rect`. E owns the list. Adding a fourth type is a contract change, so announce it.

### SSE stream, `GET /sync/{roomId}`

One Durable Object per room does the fan-out. Event payloads:

```
event: object   data: Object v1            // state changed, usually measured -> ready
event: version  data: { versionId }        // a new version was pushed
event: fit      data: FitReport v1         // a re-check finished
```

The Quest subscribes on room open and never polls. This is pipeline P6.

### R2 key layout

| Key | Written by |
| --- | --- |
| `rooms/{roomId}/capture.json` | B, on upload |
| `rooms/{roomId}/appearance/{surface}.jpg` | A rectified photo of one surface. `{surface}` is a wall id, `floor` or `ceiling`. Written out of band today; there is no `POST /uploads` kind for it yet. |
| `objects/{objectId}/frames/{n}.jpg` | A, presigned |
| `objects/{objectId}/mesh.glb` | C; also a reviewed mesh attached to a catalogue object via `POST /objects/{id}/mesh` |
| `objects/{objectId}/mesh-receipt.json` | C, optional |
| `objects/{objectId}/catalog.json` | B, catalogue intake |
| `objects/{objectId}/thumb.jpg` | C |
| `scans/{objectId}/mesh.glb` | A, phone Object Capture, via upload kind `scanMesh` |
| `catalog/{merchant}/{productId}/source.jpg` | P3 crawler |
| `fixtures/…` | committed by hand at H0 |

`catalog/{merchant}/{productId}/source.jpg` is written by `workers/scripts/catalog-queue.mjs images`
through `POST /uploads`; `{productId}` is the Shopify numeric product id, as
`services/gen/app/embedding/catalog_manifest.py` asserts. Ani's Python asserts the literal key
`objects/{objectId}/mesh.glb` for generated meshes, which is why phone scans got their own prefix
rather than a change to it.

Keys are derived, never stored as URLs in D1. A URL in a row is a cache-invalidation bug waiting to happen.

**Key in the database, URL in the API.** D1 stores `glb_key`, the R2 key. The API returns
`glbUrl`, a URL the client can fetch directly, built from that key at serve time. They are
different things with different lifetimes, which is why they have different names.

Justin never resolves a key and never constructs a URL. He loads `glbUrl` as given. Ani writes
the object to its R2 key and reports the key, not a URL. Thomas does the conversion in the
Worker, in one function, once.

### D1 tables

```sql
rooms(id TEXT PK, name, captured_at, north_bearing_deg REAL, created_at)
versions(id TEXT PK, room_id, parent_id, label, content_hash,
         placements_json TEXT, materials_json TEXT, created_at)
objects(id TEXT PK, source, state, name, category,
        glb_key TEXT,                      -- R2 key, never a URL. See the rule below.
        bbox_w REAL, bbox_h REAL, bbox_d REAL,
        measure_method, measure_confidence REAL,
        caption, palette_json, price_cents INTEGER, currency,
        product_url, merchant, created_at)
jobs(id TEXT PK, object_id, kind, tier, state, progress_pct, error, created_at, updated_at)
-- One row per scan whose mesh was attached, holding the state of its rendered picture.
-- Written by POST /objects/{id}/mesh before it answers; drained by the one-minute cron.
scan_thumb_jobs(object_id TEXT PK, state, attempts INTEGER, error,
                next_attempt_at, lease_until, created_at, updated_at)
```

### Vectorize index `objects-v1`

768 dimensions, cosine metric, from `google/siglip2-base-patch16-224` embeddings. Filterable metadata, integers in millimetres so numeric range filters work:

```
objectId, source, category, w_mm, h_mm, d_mm, dominant_hex
```

That is pipeline P4 in one line: dense vector for style, integer range filter for fit.

### The stub rule

Every endpoint returns a committed fixture when the request carries `X-Stub: 1`. Four fixtures go in the repository in hour 0, before any component compiles:

1. `fixtures/room-demo.json` — a real RoomPlan capture of any room, frozen.
2. `fixtures/object-macbook.json` — `state:"ready"`, real numbers.
3. `fixtures/mesh-macbook.glb` — already bound to those numbers.
4. `fixtures/fitreport-doorswing.json` — one blocking violation with an arc.

D can build the whole headset runtime against these with no phone and no server. That is the point.


---

## Who depends on what

A blocking edge is a promise with an hour attached. These are the only ones that exist.

| From | To | What | Due |
| --- | --- | --- | --- |
| Thomas | everyone | The four fixtures plus the `X-Stub: 1` layer | H1.5 |
| Thomas | Ani | `/uploads` presign and the job record shape | H5 |
| Thomas | Justin | A real `RoomCapture v1` from a real scan | H6 |
| Ani | Justin | A real GLB that satisfies the mesh normalisation contract | H8 |
| Justin | Thomas | `FitReport v1` consumed and drawn, so the shape is proven | H12 |
| Paul | Ani | Product images plus extracted dimensions for the pre-bake | H14 |
| Paul | Thomas | The search query shape he actually needs | H12 |
| Ani | Thomas | Embeddings written into `objects-v1` so `/search` has rows to return | H14 |
| Ani | Paul | Captions, palettes, and embeddings to rank over | H14 |
| Thomas | Paul | `/search` live and answering, ranking stubbed | H16 |
| Justin | Paul | `/solve` answering, so the agent loop has an optimiser | H24 |

If you are going to miss one of these, say so at the previous sync point, not at the due hour.

### Split ownership, stated once

Two endpoints have a different owner from the person who fills them. This is deliberate and is
the only place in the project where that is true.

| Endpoint | Shape and transport | What runs inside it | Rows it reads |
| --- | --- | --- | --- |
| `POST /search` | Thomas | Paul (ranking) | Written by Ani |
| `POST /solve` | Thomas | Justin (solver) | Reads `RoomCapture v1` and `bboxMeters` |

## Changing a schema

### Why a rename is dangerous

A schema change fails silently, which is what makes it dangerous. Rename `bboxMeters` to `bbox`
and Justin's `obj.bboxMeters.w` becomes `undefined`. `undefined * scale` is `NaN`. A `NaN` in a
three.js transform does not throw — the object disappears, or sits at the origin. He then debugs
his own renderer for an hour for a bug that is not in it.

Nothing in JSON stops this. The protocol below is the only thing that does.

### Blast radius, by field

Check this before you change anything. It answers "who do I have to tell".

| What you change | Who breaks |
| --- | --- |
| `bboxMeters`, or the mesh normalisation contract | **All four.** Ani produces it, Thomas stores it, Justin's fit engine reads only this, Paul filters on it. This is the worst field in the project to touch. |
| `RoomCapture v1`: walls, openings, transforms | Thomas (writer), Justin (rebuild and fit) |
| `Object v1`: `state` values, `glbUrl` | Thomas (phone and SSE), Justin (SSE handler), Ani (job completion), Paul (index trigger) |
| `Placement v1`, `Version v1` | Thomas (store), Justin (render and validate, solver output) |
| `FitReport v1`, including `geometry` types | Justin (producer and consumer), Thomas (phone display) |
| Vectorize metadata: `w_mm`, `h_mm`, `d_mm`, `dominant_hex` | Ani (writer), Paul (reader) |
| R2 key layout | Thomas (mints), Ani (writes the mesh), Justin (reads by URL) |
| Adding an OPTIONAL field anywhere | Nobody. This is always the safe move. |

### When you change one

Thomas owns every schema change and tells the affected people directly. There is no process
beyond that. The table above exists so he knows who to tell, not so anyone fills in a form.

Two habits are still worth keeping, because they cost nothing:

- **Prefer adding an optional field to renaming one.** An added field breaks nobody. A rename
  breaks every consumer silently, at their next pull.
- **Update the fixture in the same change.** A schema change without a fixture change is not a
  schema change. It is a surprise waiting for whoever pulls next.

After H31 the feature freeze applies to schemas too.

### The one line of code that makes this loud

Every consumer validates `schemaVersion` on read and raises when it does not match what it was
built against. Do not fall back to a default and do not coerce. A mismatch is a person problem,
and it should arrive as an exception with a name in it, not as a `NaN` two hours later.

```
if (doc.schemaVersion !== EXPECTED) {
  throw new Error(`RoomCapture schemaVersion ${doc.schemaVersion}, expected ${EXPECTED} — ask Thomas`);
}
```

This is the fail-loud rule in `CLAUDE.md` applied to the one place it matters most.
