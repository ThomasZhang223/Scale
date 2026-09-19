# Laptop runbook (demo day)

The laptop runs three containers (`infra/up.sh`: fit, search, ingest — one Cloudflare quick
tunnel each) and the WebXR page, which is not dockerised: it runs under Vite with its own
tunnel, or is deployed once with `wrangler deploy` (`apps/xr/README.md`). The designer agent
is a Cloudflare Worker (`services/agent`); until it's deployed it runs locally under
`wrangler dev`. `infra/README.md` is the authority on the laptop half.

| Process | Port | Job | Start |
|---|---|---|---|
| `fit` container | 8001 | `/fit` validator **and** `/solve` (OR-Tools CP-SAT) — the layout maths | `bash infra/up.sh` (or `docker compose --profile local up -d --build fit`) |
| `search`, `ingest` containers | 8004, 8003 | Paul's ranking and scraping | `bash infra/up.sh` |
| `cloudflared` × 3 | (outbound) | One quick tunnel per container; `infra/up.sh` publishes the URLs to the Worker's KV | `bash infra/up.sh` |
| `services/agent` | 8789 | The designer agent (local dev; deployed, it runs on Cloudflare) | `cd services/agent && npm run dev` |
| Vite dev server | 5173 | Serves the Quest over USB; proxies `/v1` to the Worker and `/v1/agent` to the agent | `cd apps/xr && npm run quest` |

**One secret:** `UPSTREAM_TOKEN` in `infra/.env` (committed on purpose; see the comment there).
The containers refuse to start without it and 401 any `/fit` or `/solve` call missing
`X-Upstream-Token`; `/health` stays open. The agent sends it from `services/agent/.dev.vars`
(`UPSTREAM_TOKEN=` the same value) or, deployed, from `wrangler secret put UPSTREAM_TOKEN`.

The agent's `FIT_URL` and `SOLVER_URL` both point at the fit container: `http://127.0.0.1:8001`
locally, the fit tunnel's `https://….trycloudflare.com` when the agent runs on Cloudflare.

On this machine 8787 and 8788 are taken by another project, so Thomas's Worker stub, when run
locally, goes on 8790 (`apps/xr/.env` sets `VITE_API_PROXY`).

## Before the demo
- [ ] Laptop on power; sleep and screen lock off; Docker Desktop running
- [ ] On your own hotspot, not venue Wi-Fi
- [ ] Quest charged, developer mode on, USB cable tested
- [ ] `OPENAI_API_KEY` (and `OPENAI_MODEL`, `AI_GATEWAY_URL` if used) set on the agent; `UPSTREAM_TOKEN` matches `infra/.env`

## Start-up order
1. **Containers + tunnels:** `bash infra/up.sh`. Check: `curl localhost:8001/health` shows the
   OR-Tools version; the printed fit tunnel's `/health` answers 200.
2. **Agent:** deployed on Cloudflare (`SOLVER_URL`/`FIT_URL` = the fit tunnel origin), or
   `npm run dev` in `services/agent`. Check: `curl localhost:8789/v1/agent/demo/health` says
   `"solver":"online"`.
3. **Headset page:** `npm run quest` in `apps/xr` (runs `adb reverse`, starts Vite), or the
   deployed page's URL.
4. **Quest:** open the page, **Enter VR**. The phone on the left wrist shows the Designer
   section; "Solver offline" in it means step 1 or 2 is down.
5. **Reset for a clean run:** `curl -X DELETE localhost:8789/v1/agent/<roomId>/memory`, then
   the wrist's *Reset room* row.

`services/agent/scripts/e2e.sh` runs the whole chain (E1–E6) against these processes.

## If something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Wrist says "Solver offline" | fit container or its tunnel down, or the laptop lost internet | `bash infra/up.sh`; hotspot connected? Rearrange still works: it falls back to the stub proposal and says so |
| Agent log: "fit answered 401" / "solver answered 401" | `UPSTREAM_TOKEN` differs between the agent and `infra/.env` | Set the same value on both; restart the agent |
| Requests fail at "Planning…" | OpenAI or AI Gateway issue | Rearrange uses the built-in rules (the log says so); typed requests need the key |
| "The room changed. Ask again?" after every accept | Something saves the layout during proposals | Stop grabbing while a proposal is up |
| Quest shows the built-in fixture room with `?room=` | Thomas's Worker unreachable from Vite's proxy | Is it running on the port in `apps/xr/.env`? |
| Wrist says "Offline: sample proposal" | The agent isn't reachable at `/v1/agent` | `npm run dev` in `services/agent`; check `VITE_AGENT_PROXY` |
| Page won't load on the Quest | `adb reverse` lost (cable replugged) | Re-run `npm run quest` |
| A rearrange takes > 10 s or fails "in time" | Many pieces; the solver's limit | Remove a few pieces; the agent already narrows walkways and caps solve time |
| Objects jam while applying | Collision groups not switched off between movers | Undo, then accept again; check `physics.setMovers` |

## Last resort on stage
Server or solver down: the headset shows the fixture room and the stub proposal and says so.
Keep talking through the pipeline while the stub plays; the architecture is the story.
