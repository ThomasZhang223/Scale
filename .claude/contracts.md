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
| `POST /uploads` | `{ kind, ext }` | `{ key, putUrl }` presigned R2 | A, C |
| `POST /objects` | `{ source, name, category, bboxMeters, measure, frameKeys[] }` | `Object v1` with `state:"measured"` | A |
| `GET /objects/{id}` | — | `Object v1` | all |
| `POST /objects/{id}/generate` | `{ tier: "live" \| "quality" }` | `{ jobId }` | A, C |
| `GET /jobs/{id}` | — | `{ state, progressPct, objectId, error }` | A |
| `POST /search` | `{ text?, imageKey?, fit?, source?, limit }` | `[{ objectId, score, object }]` | F |
| `POST /fit` | `{ roomId, versionId }` or `{ roomId, placements }` | `FitReport v1` | A, D |
| `POST /solve` | `{ roomId, intent, budgetCents?, fixed[] }` | `{ placements, objective, infeasible? }` | F |
| `POST /push/{roomId}` | `{ versionId }` | `204` | A, F |
| `GET /sync/{roomId}` | — | SSE stream | D |

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
| `objects/{objectId}/frames/{n}.jpg` | A, presigned |
| `objects/{objectId}/mesh.glb` | C |
| `objects/{objectId}/thumb.jpg` | C |
| `catalog/{merchant}/{productId}/source.jpg` | P3 crawler |
| `fixtures/…` | committed by hand at H0 |

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
