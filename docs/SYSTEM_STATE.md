# Full Scale — system state

What is deployed and how data flows, as of 2026-09-20 01:30 EDT (`main` @ `53d0d6f`). This file
describes the running system. `.claude/contracts.md` stays the authority on schemas and routes.

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| `full-scale-workers` | Cloudflare Worker, `https://full-scale-workers.thomaszhangdev.workers.dev` | The only front door. Deploy: `cd workers && npm ci && npm run deploy:mesh` (typecheck, tests, dry-run, both `IF NOT EXISTS` migrations, deploy). Roll back: `npx wrangler rollback`. |
| `designer-agent` | Cloudflare Worker, `https://designer-agent.thomaszhangdev.workers.dev` | Justin's `services/agent`. The agent the headset talks to. Reads `upstream:solver` from the SAME KV namespace as the front door. Secrets: `UPSTREAM_TOKEN`, `OPENAI_API_KEY`. |
| `full-scale-xr` | Cloudflare Worker + static page, `https://full-scale-xr.thomaszhangdev.workers.dev` | Deploy: `cd apps/xr && npm run deploy`. `apps/xr/.env.production` is committed and supplies `VITE_API_STUB=0` (live data) and `VITE_ROOM_ID` (the demo room), so a plain deploy is now the right one. A shell `VITE_…=` still overrides it, and `?room=<id>` overrides at run time. |
| D1 `full-scale-db` | Cloudflare | `rooms`, `versions`, `objects`, `jobs`, `mesh_outbox`. |
| R2 `full-scale-objects` | Cloudflare | Not public. Served through `GET /v1/assets/{key}`. |
| Vectorize `objects-v1` | Cloudflare | 768-dim SigLIP 2. One namespace = the encoder fingerprint (KV `embedding:fingerprint`). |
| KV `CONFIG` | Cloudflare | `upstream:solver`, `upstream:search`, `upstream:ingest`, `upstream:embedding`, `embedding:fingerprint`. There is no `upstream:layout`. |
| `fit` :8001, `ingest` :8003, `embedding` :8004, `search` :8005 | Docker on the laptop, compose project `full-scale` | Each behind its own cloudflared quick tunnel. `bash infra/up.sh` builds, starts, tunnels, and publishes the four origins to KV. Tunnel URLs change on every run. |

A Worker cannot `fetch()` another Worker of the same account through its `*.workers.dev` URL:
Cloudflare answers with its own 404 page. `full-scale-xr` therefore reaches the other two through
service bindings (`API`, `AGENT` in `apps/xr/wrangler.toml`), and the front door's agents call
search in-process instead of fetching themselves.

## Vendor keys

`BROWSERBASE_API_KEY`, `OPENAI_API_KEY` and the Baseten values live OUTSIDE git, in
`~/.config/full-scale/secrets.env` on the laptop that runs the edge. `infra/.env` (committed on
purpose) holds only `UPSTREAM_TOKEN`, the ports and `EMBEDDING_API_KEY`.

**After every `bash infra/up.sh`, re-create ingest with Paul's overlay, or it loses the keys:**

```
set -a; . ~/.config/full-scale/secrets.env; set +a
docker compose -f docker-compose.yml -f services/ingest/compose.ingest.yml --profile local up -d --build ingest
curl -s localhost:8003/health     # {"ok":true,"browserbase":true}
```

## R2 key layout in practice

| Key | What |
| --- | --- |
| `scans/{objectId}/mesh.glb` | A phone Object Capture mesh. Upload kind `scanMesh`. Only a `source:"scan"` row may attach it. |
| `objects/{objectId}/mesh.glb` | A generated (2D->3D) mesh, a reviewed hero mesh attached to a catalogue row, or a library model (`source:"primitive"`). |
| `objects/{objectId}/frames/{n}.jpg` | LiDAR-path frames from the phone. |
| `catalog/{merchant}/{productId}/source.jpg` | A product photo. The image the embedding is made from. |
| `rooms/{roomId}/capture.json` | RoomCapture v1. |
| `rooms/{roomId}/appearance/{surface}.jpg` | A rectified photo of one surface, 2048 px longest side. `GET /v1/rooms/{id}` turns the `textureKey` in the capture into a `textureUrl`. |

One object = one `objectId` across the D1 row, the R2 key, the Vectorize vector id and `glbUrl`.
Catalogue ids are minted by the Worker (`stableId` in `workers/src/lib/catalog-ingest.ts`), never
by a client. Do not apply `services/ingest/.load*/catalog.d1.sql`: it carries a second id rule.

## The demo room

`ccff7dec-1fc1-493e-96e3-3ab6f6ddfb2a` — Judging Room H, measured: **2.76 (short walls) x 4.72
(long walls) x 2.96 m high**, four walls, no openings, all six surfaces photographed and rectified.
The headset opens it with no URL parameter (see `.env.production` above). `fixtures/room-h.json` is
the same room committed, and is what `X-Stub: 1` answers for `GET /v1/rooms/{id}`.

Room `8b371353-…` is the older invented 4.0 x 3.5 x 2.4 m room. It and its six versions are
untouched, and `fixtures/room-demo.json` still describes it, because four test suites across three
owners assert against its numbers, its door and its table.

## The flows

**Phone capture (primary: Object Capture).** `app/capture/object3d.tsx` -> on-device USDZ ->
`GLBExporter.swift` -> `POST /v1/objects` -> `POST /v1/uploads {kind:"scanMesh"}` -> `PUT` ->
`POST /v1/objects/{id}/mesh` (GLB header validated; row -> `ready`; indexed in the background).
There is no USDZ->GLB service: the phone is the converter.

**Library.** Phone tabs and the headset list `GET /v1/objects?source=scan|catalog|primitive`.
The headset re-lists scans every 10 s. The headset ships no model files.

**Catalogue.** `services/ingest` `/crawl` + `/extract` (metres) -> `POST /v1/catalog/ingest` ->
D1 row + mesh job + outbox. Images: `node workers/scripts/catalog-queue.mjs images`. Vectors:
`... backfill` (image embeds). The curated set is `services/ingest/prebake/manifest.json`.

**Search.** `POST /v1/search`. Vectorize for style, integer-millimetre metadata for fit. A text
query with no `source` searches the catalogue only and says so (`X-Search-Scope:
catalog-default`), because text-indexed rows outscore image-indexed products about 6x.

**Live store search from the headset.** A "find ..." sentence -> `POST /v1/find` per storefront
(three in parallel) -> ingest `/find` (Browserbase) + `/extract`. Writes nothing.
`POST /v1/listings/generate {listing, roomId}` turns a picked row into a D1 object + mesh job.

**Arrangement.** Every other sentence -> `designer-agent` (`/v1/agent/*`) -> plan without
coordinates -> OR-Tools in `fit` -> proposal -> new Version -> SSE. `POST /v1/solve` (RoomAgent,
Workers AI) is the front door's own agent; nothing in the apps calls it.

**2D->3D.** D1 job -> outbox -> 1-minute cron -> Queue -> `MeshDispatcher` (one admission slot)
-> `GenerateMeshWorkflow` -> the B06 adapter -> SF3D on Baseten -> B04 binding -> R2. With
`BASETEN_URL`/`BASETEN_API_KEY` unset the job PARKS as `queued` and `/v1/health` says
`providerConfigured:false`. Two hosts for the provider exist in `services/gen`: `prepare.py` +
`approve.py` (offline, human-reviewed, see `HERO_RUNBOOK.md`) and `app/generate_server.py`
(live, records an operator-declared review for every artifact). Thomas chose the live one.

`BASETEN_URL` names the **adapter**, never Baseten. The Worker secret `BASETEN_API_KEY` is the
adapter's `GENERATION_API_KEY` and authenticates the Worker TO the adapter; the real Baseten
credential never leaves the laptop. `GenerateMeshWorkflow` rejects a raw SF3D response outright
(`kind:"raw_sf3d_unscaled"`, or a bare `glb_base64`), so the adapter is not optional.

| Piece | Where | Notes |
| --- | --- | --- |
| `gen` adapter | Docker on the laptop, `:8006`, compose profile **`gen`** (not `local`) | `services/gen/Dockerfile.adapter`, `app/generate_server.py`. Start with `bash infra/gen-up.sh`, which also gives it its OWN quick tunnel and touches none of the other four. Its three credentials come from `~/.config/full-scale/secrets.env`, which `infra/up.sh` does not load — hence the separate profile. |
| SF3D | Baseten, model `3mzlyd6w` (`ani-sf3d-feasibility`), deployment `qe95lkp`, team `HTN2026`, `L4:4x16` | `SCALED_TO_ZERO` between sessions. A cold wake measured 170.9 s against the adapter's 180 s provider timeout, so warm it with one real prediction BEFORE the Worker can send one. The deployment named in older docs, `wdlgzjk3`/`w604592`, 404s for this API key. |

The scale binding happens exactly once, in the adapter. Dimensions come from the D1 row's
`bbox_w/h/d`, which the Worker sends as `bbox_meters`. Measured on the first live catalogue
product: bound extents match D1 to 1e-8 m. The binder still labels a single-photo SF3D mesh of
a wide, shallow object `proxy_recommended` — see `services/gen/SF3D_JUDGING.md`, "Measured on a
real product", for why, and for how to tell that apart from a 90-degree yaw error.

`infra/up.sh` refuses to run while the gen tunnel is alive (it globs `infra/.run/*.pid`). Kill
`$(cat infra/.run/gen.pid)` first — and re-put `BASETEN_URL` afterwards, because a quick-tunnel
URL changes on every restart.

## Verify

Re-runnable smoke scripts, PASS/FAIL/SKIP per hop against the deployed system, live outside the
repo: `~/Documents/work-wiki/personal-projects/htn-2026/integration-sweep/verify/`. Run
`cleanup.sh` there afterwards: each run creates `SMOKE-<utc>` rows.
