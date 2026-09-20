# Cloudflare deployment — the Full Scale backend

Owner: Thomas. Branch: `thomas/cloudflare-infra`, branched from `thomas/worker-stubs`.

Everything here is written and typechecked. **Nothing has touched the Cloudflare account** —
provisioning is one script you run after `wrangler login`.

---

## Why this shape

The Cloudflare track is *"Best Agent with a Brain"*: build an agent that **remembers context,
uses tools, manages state, and completes useful work**. Eligibility is "Workers must be a
meaningful part of the runtime, backend, or orchestration layer". Judging is agent capability,
meaningful Workers usage, technical execution, creativity, usefulness.

`BUILD_DOC.md` used Workers as routing and storage. That scores on "meaningful Workers usage"
and nothing on "agent capability". So the two real agent loops now run *on* Workers:

| | remembers context | uses tools | manages state | completes work |
| --- | --- | --- | --- | --- |
| **RoomAgent** (one Durable Object per room) | `transcript` table: every intent and what the solver did with it | `search_objects`, `plan_layout`, `check_fit`, `commit_version` | current version, live subscriber count | writes an immutable Version, pushes it to the headset |
| **ScoutAgent** (one per search session) | `merchants` table: which storefronts are ingested and what each yielded | `list_merchants`, `search_objects`, `ingest_merchant`, `read_listing` | merchant and product counts | starts the ingest pipeline, answers with real measured products |

The per-room Durable Object that `contracts.md` already required for SSE fan-out **is** the
RoomAgent. Per-room durable state and per-room agent memory are the same thing, so they are
one class, not two.

### Standing rule 3, enforced by the type system

An LLM turns intent into an objective and constraints. A solver places things. The
`plan_layout` tool schema has no field that can hold an `x` or a `z` — the model literally
cannot emit a coordinate. It emits `ConstraintPlan v1`; OR-Tools on the laptop emits positions.

---

## The architecture

```
  iPhone (Expo)  ─┐
  Quest (WebXR)  ─┼──►  full-scale-workers.<subdomain>.workers.dev
  Scout caller   ─┘            │
                               ├── D1          rooms, versions, objects, jobs
                               ├── R2          captures, frames, meshes, thumbs  (private)
                               ├── KV          upload grants + tunnel origins
                               ├── Vectorize   objects-v1, 768-dim SigLIP 2, cosine
                               ├── Workers AI  gpt-oss-120b, the brain for both agents
                               ├── Browser Run headless Chrome for non-Shopify listings
                               │
                               ├── RoomAgent   DO per room: SSE fan-out + layout agent
                               ├── ScoutAgent  DO per session: merchant retrieval agent
                               │
                               ├── Workflow    GenerateMeshWorkflow   (Ani's pipeline)
                               ├── Workflow    IngestMerchantWorkflow (Paul's pipeline)
                               ├── Queue       throttles the unattended catalog pre-bake
                               │
                               └── fetch ──► cloudflared quick tunnels ──► laptop
                                              /solve /fit   services/fit    (Justin)
                                              /search       services/search (Paul)
                                              /crawl        services/ingest (Paul)
                                    └──► Baseten: image-to-3D, the scale binding, embeddings (Ani)
```

### Why each product, in one line

| Product | Why this and not something simpler |
| --- | --- |
| **Durable Objects** | A Worker request ends; it cannot hold an SSE connection open for `GET /v1/sync/{roomId}`. The room id is the object name, so every caller reaches the same instance with no registry. |
| **Workflows** | Generation is 10–20 s against a GPU endpoint that cold-starts and fails. Each `step.do` retries on its own, and wall-clock per step is unlimited on the free plan. The instance id **is** the job id, so there is no second state machine to keep in sync. |
| **Queues** | The free plan allows 100 concurrent Workflow instances. A 60–100 product pre-bake started in a loop would exhaust that and push the demo's own live generation to the back of the line. `max_concurrency = 3`. |
| **Vectorize** | Style is a dense vector; fit is an integer millimetre range filter on the same index. Mixing them produces results that look right and do not fit. |
| **Workers AI** | No API key exists to leak, it is free-tier, and it keeps the agent's reasoning inside Workers — which is the thing being graded. |
| **Browser Run** | The listings that need it are exactly the ones with no catalog endpoint, and those are client-rendered: a plain `fetch` returns an empty shell. |
| **KV** | A quick tunnel gets a new random hostname on every restart. Rotating one must be a write, not a redeploy. |

---

## Runbook

### 0. Log in (once)

```sh
cd workers && npx wrangler login
```

### 1. Provision (once)

```sh
bash infra/cloudflare/provision.sh
```

Creates the R2 bucket, D1 database, KV namespace, Queue, the `objects-v1` Vectorize index
**and its seven metadata indexes**, writes the generated ids into `workers/wrangler.toml`, and
applies `src/schema.sql` remotely. Safe to re-run.

> The metadata indexes are not optional. Without them a `$lte` range filter on `w_mm` silently
> matches nothing, which looks exactly like "the catalog is empty".

### 2. Secrets

```sh
cd workers
npx wrangler secret put UPSTREAM_TOKEN     # must match what the laptop services check
npx wrangler secret put BASETEN_URL        # Ani's endpoint
npx wrangler secret put BASETEN_API_KEY
```

For local development put the same names in `workers/.dev.vars` (gitignored).

### 3. Deploy

```sh
cd workers && npm run deploy
```

This creates a **second** Worker, `full-scale-workers`. It is deliberately not the `htn-2026`
Worker already in the dashboard: that one is wired to automatic deployment from the GitHub
repo and would fight `wrangler deploy`.

### 4. Point it at the laptop

The local-edge panel owns `infra/up.sh`, which starts three `cloudflared` quick tunnels. Then:

```sh
bash infra/cloudflare/set-upstreams.sh <solver-url> <search-url> <ingest-url>
```

Pass the literal `SKIP` for a service that is not running yet. An unset key makes the route
answer 503 naming the key — never a guess at which service you meant.

### 5. Verify

```sh
curl https://full-scale-workers.<subdomain>.workers.dev/v1/health
curl https://full-scale-workers.<subdomain>.workers.dev/v1/health/upstream
```

`/v1/health` reports D1 reachability, which upstreams are set, and which secrets exist.
"Search returns nothing" has about six causes and five of them are configuration; this answers
which in one request.

---

## Local development

```sh
cd workers
npm install
npm run typecheck      # regenerates worker-configuration.d.ts, then tsc --noEmit
npm run dev            # needs `wrangler login` — see below
```

`wrangler dev` proxies Vectorize, Workers AI and Browser Run to the real services, because they
have **no local simulation**. With no login and no network it refuses to start at all — not
just those routes, everything.

That is the wrong failure at a venue, so:

```sh
bash infra/cloudflare/offline-config.sh
cd workers && npx wrangler dev -c .wrangler.offline.toml
```

This generates a config with those three bindings stripped. The generated file is gitignored
and never edited, so it cannot drift.

### What dies without internet

| Works offline | Needs internet |
| --- | --- |
| `/v1/rooms`, `/v1/objects`, `/v1/uploads`, `/v1/assets`, `/v1/versions`, `/v1/jobs` | `/v1/scout` and `POST /v1/solve` — both need Workers AI |
| `/v1/push` and `/v1/sync` — the full SSE fan-out | `/v1/search` vector path — falls back to `d1-fallback`, which still answers |
| Both Workflows, the Queue, both agents' storage | `/v1/fit` — the solver is behind a tunnel |
| | mesh generation — Baseten is remote |

**The demo spine runs offline. The agent loops do not.** With no travel router this matters:
a mobile hotspot carries everything, and the fallback if it drops is the spine, not nothing.

---

## Verified locally

Twenty checks passed against `wrangler dev` with the offline config, all with real D1, R2, KV
and Durable Object simulation:

1. `/v1/health` reports D1 ok and every upstream null.
2. The stub layer still answers `X-Stub: 1` untouched — four walls from `room-demo.json`.
3. CORS preflight returns 204 with `PUT` allowed.
4. `POST /v1/rooms` stores the fixture and returns its `roomId`.
5. `worldAlignment: "gravity"` is rejected 422 with the ARKit line to change.
6. `GET /v1/rooms/{id}` round-trips four walls out of R2.
7. `POST /v1/objects` returns `state: "measured"` with a null `glbUrl`.
8. A 90 m sofa is rejected 422 naming the axis and the range.
9. Upload mint → `PUT` → `GET /v1/assets/...` serves the bytes with CORS and an immutable cache header.
10. A replayed upload token is rejected 401.
11. An unknown upload kind is rejected 400 naming the valid set.
12. A version writes with a real sorted-key content hash, and lists.
13. `scale: 1.4` is rejected 422 citing the mesh normalisation contract.
14. **SSE end to end**: subscribe, `POST /v1/push`, `event: version` arrives on the stream.
15. Pushing a version that does not exist 404s instead of notifying.
16. Search falls back to D1 with no embedder and says `X-Ranker: d1-fallback`.
17. The fit filter genuinely excludes: `maxW: 0.2` drops a 0.31 m laptop.
18. `/v1/fit` with no solver 503s with the exact `wrangler kv key put` command.
19. Agent memory is readable at `/v1/agents/room/{id}/memory`.
20. An unknown route still 404s.

---

## Schema proposals — for Thomas to land in `.claude/contracts.md`

Neither this panel nor the local-edge panel may edit `contracts.md` directly. Two additions:

### ConstraintPlan v1 — the layout agent's entire output

```json
{
  "schemaVersion": 1,
  "objective": "maximize_walkway | maximize_free_floor | minimize_wall_gap | group_seating",
  "constraints": [
    { "kind": "min_clearance", "meters": 0.9 },
    { "kind": "against_wall", "objectId": "uuid", "wallId": "uuid|null" },
    { "kind": "keep_clear", "openingId": "uuid" },
    { "kind": "near", "objectId": "uuid", "otherObjectId": "uuid", "maxMeters": 1.2 },
    { "kind": "budget", "cents": 120000 }
  ],
  "notes": "free text shown to the user, never parsed"
}
```

The constraint list is **open**: a solver ignores a `kind` it does not implement and reports
which ones it honoured, so adding a kind never breaks it. Lives in `src/lib/contracts.ts`.

### Six routes not in the contract yet

| Route | Why |
| --- | --- |
| `PUT /v1/uploads/{key}?t=` | The target of the `putUrl` that `POST /v1/uploads` already returns. |
| `GET /v1/assets/{key}` | What `glbUrl` resolves to. The one key → URL conversion. |
| `POST /v1/scout` | The merchant retrieval agent's front door. |
| `GET /v1/agents/{room\|scout}/{id}/memory` | Reads an agent's state and transcript. Demo material, and the fastest way to show a judge the agent remembers. |
| `GET /v1/health` and `/v1/health/upstream` | Diagnostics. |
| `GET /v1/objects?source=&merchant=&limit=` | A plain newest-first listing for the phone's Scanned and Furniture tabs. Not a search: no ranking, no relaxation. Stub answers `[object-macbook]`. |

### One deviation from the contract, deliberate

`POST /v1/uploads` returns `{ key, putUrl }` as specified, but **`putUrl` is not a presigned R2
URL**. An R2 *binding* cannot sign one — presigning needs AWS SigV4 and a separate R2 API
token, which would be a third secret and would make uploads impossible in local dev against a
simulated bucket. `putUrl` points back at this Worker and the `PUT` is proxied into R2 through
the binding. **The contract shape is unchanged; only the host differs.**

Ceiling: every upload crosses the Worker, capping one file at the 100 MB free-plan request
body limit. Frames are ~200 KB and a bound GLB is a few MB. The upgrade path is `aws4fetch`
plus an R2 API token, signing a real direct-to-R2 URL.

---

## Free-plan facts this is built on

| | Free plan |
| --- | --- |
| Durable Objects | **SQLite-backed only.** `new_classes` is paid-plan — every migration uses `new_sqlite_classes`. The committed `wrangler.toml` had `new_classes` and would have failed `wrangler deploy`. |
| Workflows | 1,024 steps/instance, 10 ms compute per step, **unlimited wall clock per step**, 100 concurrent, 100k/day |
| Queues | 10,000 operations/day, 24 h retention |
| Vectorize | 1,536 dims max (we use 768), 10 metadata indexes (we use 7), topK 50 with metadata |
| Containers | **Paid plan only.** That is why the solver stays on the laptop behind a tunnel. |
| R2 | 10 GB |

---

## Ceilings accepted, and their upgrade paths

- **CORS is `*`.** Safe only because no route reads a cookie or an `Authorization` header. The
  moment a real credential exists this must become an allow-list, because `*` is rejected with
  credentials.
- **The laptop is protected by one shared header.** A quick-tunnel hostname is unguessable but
  entirely public. Cloudflare Access service tokens would be better and need Zero Trust on a
  real domain, which "account, no domain" rules out.
- **Quick tunnels do not support Server-Sent Events**, and cap at 200 in-flight requests.
  `GET /v1/sync/{roomId}` must reach the Worker directly and never cross a tunnel. If anyone
  points the headset's API base at a `trycloudflare.com` URL, the stream dies with no error.
- **The mesh workflow picks the first frame by key order**, not the clearest silhouette. Ani's
  notes say Stable Fast 3D takes one best clean image, never a multi-view set; scoring the
  sweep properly is the upgrade. A catalog product has one frame either way.
- **The bare `A x B x C` regex assumes width, depth, height.** That is a retail convention, not
  a fact, and a wrong guess binds width to depth — which passes every numeric check while being
  visibly wrong in the room. It is scored lower than the labelled `W/D/H` path for that reason.
- **40 products per merchant per ingest run**, to bound the LLM pass against the daily
  allowance. Raise it once a real neuron number has been measured.
- **`subscribers` in RoomAgent state is pruned on write, not on disconnect**, so it can read
  high for up to 25 seconds until the next heartbeat.

---

## Merge note

`wrangler.toml` still declares `RoomSync`, the registration-only 501 stub from
`thomas/worker-stubs`. `RoomAgent` replaces it and nothing routes to it. **After merging both
branches, delete the `ROOM_SYNC` binding, the class in `src/index.ts`, and its entry in the
`new_sqlite_classes` migration.** It is kept only so the two branches merge without a conflict
in a file the stub-layer panel owns.

`@cloudflare/workers-types` was removed: `wrangler types` now generates runtime types and
supersedes it, and keeping both produces duplicate-global errors. `npm run typecheck`
regenerates `worker-configuration.d.ts` first, so a fresh clone needs no extra step.
