# Where everything runs

**Decision:** the agent and everything around it run on Cloudflare. Only the OR-Tools
solver, the heavy math, runs on a team computer. The agent on Cloudflare calls that
computer through a **Cloudflare Tunnel** whenever it needs a layout solved.

```
Quest ──▶ Worker (/v1) ──▶ DesignerAgent (Durable Object, 1 per room)      ← Cloudflare
                               ├─▶ AI Gateway ──▶ OpenAI API                ← Cloudflare → OpenAI
                               ├─▶ /fit (as today)
                               └─▶ Cloudflare Tunnel ──▶ solver laptop       ← local compute
                                                          services/layout (Python + OR-Tools) /solve
```

| Runs on Cloudflare | Runs on the solver computer |
|---|---|
| Worker and `/v1` API, Durable Object agent (state, memory, loop), AI Gateway calls to OpenAI, Versions, sync | `services/layout`: OR-Tools CP-SAT, `POST /solve`, `GET /health` |

`/fit` stays wherever it runs today; nothing about it changes.

## 1. The solver computer

- Any team laptop with Python. Measured on the sample room: ~70 ms per solve on one core,
  ~100 MB of memory. Solving is not the bottleneck; the network round trip is.
- Keep `num_workers = 1` as the default (fastest for rooms this size); allow raising it by
  environment variable for bigger rooms.
- Run the service on a local port (e.g. `localhost:8080`). It never needs to be reachable on
  the venue network directly.
- **Demo-day settings:** plugged into power, sleep disabled, and on your own hotspot rather
  than venue Wi-Fi (venue networks drop and block things).

## 2. Connecting Cloudflare to it: Cloudflare Tunnel

`cloudflared` runs on the solver laptop and opens an **outbound** connection to Cloudflare, so
the laptop needs no public IP, no open ports, and works from any network. Cloudflare then
routes a hostname (e.g. `solver.<your-domain>`) through the tunnel to `localhost:8080`.

1. Install `cloudflared` on the solver laptop.
2. Create a named tunnel in Thomas's Cloudflare account and route a hostname to
   `http://localhost:8080` (check the current Tunnel docs for the exact commands; a quick
   temporary tunnel also works for testing, but its URL changes every restart).
3. Set the Worker variable `SOLVER_URL` to that hostname.

**Lock it down.** The hostname is reachable from the internet, so only the Worker should be
able to call it. Either protect it with **Cloudflare Access** and a service token the
Worker sends in its headers, or at minimum require a shared secret header
(`X-Solver-Key`, stored as a Worker secret and checked by the solver). Reject everything else.

**Cost:** Tunnel and Access are free for this use. No Workers Paid plan is needed for the solver.

## 3. The LLM: OpenAI through AI Gateway

The agent loop runs in the Durable Object; its OpenAI calls go through **Cloudflare AI
Gateway** (change the base URL of the OpenAI calls to the gateway URL; the key stays a Worker
secret). It's still the OpenAI API, so the OpenAI prize stays in play, and Cloudflare logs,
caches and retries every call. Check the AI Gateway docs for the current setup.

Don't switch to Cloudflare-hosted models (Workers AI) as the main planner: that isn't the
OpenAI API. At most, use one as an AI Gateway fallback, and log it when it happens.

## 4. When the solver computer is unreachable

The laptop is the one piece outside Cloudflare, so the agent must handle it being gone:

- **Health check:** when the headset loads a room, the Worker calls `GET /health` through
  the tunnel and stores the result; the wrist and the laptop panel show "Solver online" or
  "Solver offline".
- **Timeout:** 5 s per solve call, then fail the request with "The layout solver isn't
  reachable right now", logged as a `LogEntry`.
- **Demo fallback:** with the solver offline, presets return the committed stub proposal
  (same as `X-Stub: 1`) and say so. Nothing freezes on stage.

That behavior is also good Rox material: the agent handles an unavailable tool, visibly.

## 5. What to tell the Cloudflare judges

"The agent runs on Cloudflare: each room is a Durable Object holding the agent's state and
memory. It reasons with OpenAI through AI Gateway, and when it needs heavy optimization it
calls Google OR-Tools on our own compute node through a Cloudflare Tunnel, so the solver
never needs a public server."

## Checklist before the demo
- [ ] Solver running on the laptop; `curl localhost:8080/health` works
- [ ] `cloudflared` tunnel up; the Worker's health check reports "online"
- [ ] Only the Worker can call the solver (Access service token or `X-Solver-Key`)
- [ ] Laptop on power, sleep off, on your own hotspot
- [ ] AI Gateway receiving calls; OpenAI key and `OPENAI_MODEL` set as Worker config
- [ ] Offline fallback tested: stop the solver, run a preset, see the stub proposal and the log line
