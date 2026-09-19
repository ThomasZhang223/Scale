# infra — the laptop half of the stack

**Owner:** Thomas (local-edge panel). This is the one page to read at 3am when something on
the laptop stopped answering.

## The three-process model

Nearly the whole backend runs on Cloudflare. Three things cannot follow it there: OR-Tools
(no Python C++ extension on Workers), the scraper and ranker, and Justin's Vite dev server.
Those three run here, on this laptop, and the cloud reaches them through Cloudflare quick
tunnels — one `cloudflared` process per service, each minting its own random
`*.trycloudflare.com` hostname. There is no domain on this Cloudflare account, so a quick
tunnel is the only kind available; see `infra/tunnel/config.yml` for the named-tunnel upgrade
path, fully commented out, for the day a domain exists.

```
  Expo app (phone) ──┐
                     ├──► https://full-scale-workers.thomaszhangdev.workers.dev/v1
  Quest browser  ────┘        (the only front door — never call a tunnel URL from a client)
        ▲                              │
        │  SSE /v1/sync/{roomId}       │  RoomAgent reads CONFIG KV, then
        │  (direct to the Worker,      │  fetch(origin) with X-Upstream-Token
        │   never through a tunnel)    ▼
        │              ┌── three quick tunnels, one per service ──┐
        └──────────────┤                                          │
                        ▼                    ▼                    ▼
                localhost:8001        localhost:8004       localhost:8003
                services/fit          services/search      services/ingest
                (OR-Tools CP-SAT)     (ranking)             (crawl + extract)

  Iteration only, never the demo path:  localhost:5173 (Vite, apps/xr) ← a fourth quick tunnel
```

The laptop is a stateless tool the cloud agent calls, never a relay. Nothing here fetches a
room or holds state across requests — `services/fit`, `services/search`, and
`services/ingest` each receive everything they need in the request body.

## First-time setup

```
cp infra/.env.example infra/.env
```

Fill in `UPSTREAM_TOKEN` (any random string — the Worker holds the same value in its own
`UPSTREAM_TOKEN` secret). `infra/.env` is already covered by the repo's blanket `.env`
`.gitignore` rule; never commit it regardless.

Install the two tools this laptop needs that a plain `npm install` will not give you:

```
brew install cloudflared
```

Docker Desktop must be running. `wrangler login` must have been run at least once (the login
token is stored globally, not per-repo).

## Running it

```
bash infra/up.sh
```

Five phases, each failing loud rather than guessing:

1. **preflight** — Docker daemon up, `cloudflared` installed, `infra/.env` present and
   complete, `wrangler` logged in. Also refuses to start if a tunnel from an unstopped
   previous run is still alive.
2. **containers** — `docker compose --profile local up -d --build`, then polls each
   service's `/health` until it answers. `--build` matters: without it, a re-run silently
   serves whatever image was built last time, even after an edit to `services/*/app`.
3. **tunnels** — one `cloudflared tunnel --url http://localhost:PORT` per service,
   backgrounded, with its random `trycloudflare.com` URL captured from its own log.
4. **publish** — hands all three URLs to `infra/cloudflare/set-upstreams.sh`, which the
   Cloudflare panel owns (branch `thomas/cloudflare-infra`) and writes them into `CONFIG` KV.
   If that script isn't in your worktree yet, this phase fails loud and says so — the three
   tunnels from phase 3 are left running regardless, so they're still testable by hand.
   **Assumption, not confirmed:** `up.sh` calls it positionally,
   `set-upstreams.sh <fit-url> <search-url> <ingest-url>`, matching the KV key order
   (`upstream:solver`, `upstream:search`, `upstream:ingest`). If the real script takes a
   different signature, the call site in `infra/up.sh`'s `publish()` is the one line to
   change.
5. **print** — the three origins, the Worker URL, and a one-line health check through the
   tunnel.

```
bash infra/down.sh
```

Stops the three tunnels (by pid, tracked in `infra/.run/`, gitignored — regenerated every
run) and the containers.

### The WebXR dev loop (iteration only)

`infra/up.sh` does not start this — it's Justin's dev loop, not part of the demo path.

```
cd apps/xr && npm install && npm run dev
cloudflared tunnel --url http://localhost:5173
```

Open the printed `trycloudflare.com` URL on the Quest, or in a desktop browser to mirror the
demo to a casting monitor. `apps/xr/vite.config.js` sets `allowedHosts: true` (the tunnel
hostname is random every run, so a fixed list can never match it) and
`hmr: { protocol: 'wss', clientPort: 443 }` (otherwise the hot-reload socket tries to open on
5173, which the tunnel never publishes, and the page loads once and never updates again).

## Port map

| Port | What | Notes |
| --- | --- | --- |
| 8001 | `services/fit` | Container binds 8000 internally; compose maps 8001:8000. KV key `upstream:solver`. |
| 8003 | `services/ingest` | Container binds 8080 internally; compose maps 8003:8080. KV key `upstream:ingest`. |
| 8004 | `services/search` | Container binds 8080 internally; compose maps 8004:8080. KV key `upstream:search`. |
| 8002 | `services/gen` | Never started locally — profile `unused`, goes to Baseten. Registered so the port is reserved, not so it runs. |
| 5173 | Vite (`apps/xr`) | Iteration only. |
| 8787 | `wrangler dev`, if run locally | Not started by anything in this directory. |

**macOS reserves 5000 and 7000 for AirPlay Receiver.** They will look free, refuse to bind,
and cost you ten minutes. Never put a service on them.

## SSE never crosses a tunnel

**A quick tunnel drops Server-Sent Events, and it does it silently — no error, just a stream
that never delivers a single event.** `GET /v1/sync/{roomId}` is SSE and terminates in the
`RoomAgent` Durable Object, which already holds every room's live sockets. It must be called
directly against the Worker (`https://full-scale-workers.thomaszhangdev.workers.dev`), never
against a `trycloudflare.com` origin. If anyone points the headset or phone's live-update path
at a tunnel URL "to test through the tunnel," the app will look connected and simply never
update. There is no error to catch — this is the one mistake in this whole setup that fails
with zero symptom, so it gets said twice: SSE goes to the Worker directly, always.

## OR-Tools installs only inside the container

The host interpreter on this laptop is **Python 3.14.7**, and `ortools` publishes no `cp314`
wheels — the current release ships `cp312` and `cp313` only. `pip install ortools` on the
host fails every time. `services/fit/Dockerfile` pins `python:3.12-slim`, which is exactly
right, and `ortools` builds there cleanly (verified: `ortools 9.15.6755` installs with no
error inside the container). The first instinct when the container feels slow will be to run
`uvicorn` straight on the host — that instinct cannot work here. Build and run through Docker.

## `wrangler deploy` — the second Worker

Deploy this project's Worker as **`full-scale-workers`**, never as `htn-2026`. The `htn-2026`
Worker already exists on this account and auto-deploys from GitHub; a manual
`wrangler deploy` aimed at it will fight that auto-deploy and the two will clobber each other.
`full-scale-workers.thomaszhangdev.workers.dev` is a second, separate Worker made for this
project — `infra/.env`'s `WORKER_BASE_URL` already points at it.

## A latency budget worth knowing before you debug the wrong thing

The Worker's `callUpstream` gives an upstream service 25 seconds before it gives up and
returns a 502 telling Thomas to check `cloudflared` and the container
(`workers/src/lib/config.ts`, `callUpstream<T>(..., timeoutMs = 25_000)`). That diagnosis is
right for a dead tunnel and wrong for a solver that is merely still thinking — at 3am it sends
whoever's debugging to the tunnel when the real fix is a shorter CP-SAT time limit inside
`services/fit`. If `/solve` starts timing out, check whether the solver itself is running long
before assuming the tunnel dropped.

## Contract additions, proposed

Not landed here — `.claude/contracts.md` is Thomas's file by hand. This is everything a
schema-change conversation needs, gathered in one place.

**The two tunnel-hop bodies.** The `RoomAgent` hydrates the public request before it reaches
this laptop; the shapes differ from `.claude/contracts.md`'s public surface, on purpose:

```
POST {upstream:solver}/solve            headers: X-Upstream-Token
{ "schemaVersion": 1,
  "room":       <RoomCapture v1>,
  "candidates": [<Object v1>],          // the solver reads bboxMeters and nothing else
  "fixed":      [<Placement v1>],
  "plan":       <ConstraintPlan v1> }
-> { "placements": [<Placement v1>], "objective": <number>, "infeasible": <string|null> }

POST {upstream:solver}/fit              headers: X-Upstream-Token
{ "schemaVersion": 1, "room": <RoomCapture v1>, "placements": [<Placement v1>] }
-> <FitReport v1>
```

**ConstraintPlan v1** — the LLM's entire output. Never a coordinate; an objective and
constraints only. The constraint list is open — a solver that doesn't implement a given
`kind` ignores it and names what it did honour, and a new `kind` must never be a hard failure:

```json
{ "schemaVersion": 1,
  "objective": "maximize_walkway | maximize_free_floor | minimize_wall_gap | group_seating",
  "constraints": [
    { "kind": "min_clearance", "meters": 0.9 },
    { "kind": "against_wall",  "objectId": "uuid", "wallId": "uuid|null" },
    { "kind": "keep_clear",    "openingId": "uuid" },
    { "kind": "near",          "objectId": "uuid", "otherObjectId": "uuid", "maxMeters": 1.2 },
    { "kind": "budget",        "cents": 120000 } ],
  "notes": "free text shown to the user, never parsed" }
```

**The three `CONFIG` KV keys**, and the rule that governs all three: `upstream:solver` (this
laptop's `services/fit`, port 8001), `upstream:search` (`services/search`, port 8004),
`upstream:ingest` (`services/ingest`, port 8003). An unset key is a 503 naming the key to set
— never a guessed origin, never a fallback to `localhost`. `infra/up.sh` republishes all
three on every run precisely because the tunnel URLs are different every time.
