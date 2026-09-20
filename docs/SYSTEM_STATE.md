# Full Scale — system state

What is deployed and how data flows, as of 2026-09-20 01:30 EDT (`main` @ `53d0d6f`). This file
describes the running system. `.claude/contracts.md` stays the authority on schemas and routes.

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| `full-scale-workers` | Cloudflare Worker, `https://full-scale-workers.thomaszhangdev.workers.dev` | The only front door. Deploy: `cd workers && npm ci && npm run deploy:mesh` (typecheck, tests, dry-run, both `IF NOT EXISTS` migrations, deploy). Roll back: `npx wrangler rollback`. |
| `designer-agent` | Cloudflare Worker, `https://designer-agent.thomaszhangdev.workers.dev` | Justin's `services/agent`. The agent the headset talks to. Reads `upstream:solver` from the SAME KV namespace as the front door. Secrets: `UPSTREAM_TOKEN`, `OPENAI_API_KEY`. |
| `full-scale-xr` | Cloudflare Worker + static page, `https://full-scale-xr.thomaszhangdev.workers.dev` | Deploy with LIVE data: `cd apps/xr && VITE_API_STUB=0 npm run deploy`. A plain `npm run deploy` ships the stub build, because `STUB` defaults ON in `src/api.ts`. |
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

One object = one `objectId` across the D1 row, the R2 key, the Vectorize vector id and `glbUrl`.
Catalogue ids are minted by the Worker (`stableId` in `workers/src/lib/catalog-ingest.ts`), never
by a client. Do not apply `services/ingest/.load*/catalog.d1.sql`: it carries a second id rule.

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
-> `GenerateMeshWorkflow`. With `BASETEN_URL`/`BASETEN_API_KEY` unset the job PARKS as `queued`
and `/v1/health` says `providerConfigured:false`. Two hosts for the provider exist in
`services/gen`: `prepare.py` + `approve.py` (offline, human-reviewed, see `HERO_RUNBOOK.md`) and
`app/generate_server.py` (live, records an operator-declared review for every artifact).

## Verify

Re-runnable smoke scripts, PASS/FAIL/SKIP per hop against the deployed system, live outside the
repo: `~/Documents/work-wiki/personal-projects/htn-2026/integration-sweep/verify/`. Run
`cleanup.sh` there afterwards: each run creates `SMOKE-<utc>` rows.
