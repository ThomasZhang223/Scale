# Laptop runbook (demo day)

The laptop runs the headset's page, the OR-Tools solver, the fit engine, the tunnel that
lets the Cloudflare agent reach the solver — and, until the agent is deployed, the agent
itself under `wrangler dev`.

| Process | Port | Job | Start |
|---|---|---|---|
| Vite dev server | 5173 | Serves the Quest over USB; proxies `/v1` to the Worker and `/v1/agent` to the agent | `cd apps/xr && npm run quest` |
| `services/layout` | 8080 | OR-Tools solver: `POST /solve`, `GET /health` | `cd services/layout && SOLVER_KEY=<secret> .venv/bin/uvicorn app.main:app --port 8080` |
| `services/fit` | 8000 | Fit validator: `POST /fit` | `cd services/fit && .venv/bin/uvicorn app.main:app --port 8000` |
| `services/agent` | 8789 | The designer agent (local dev; deployed, it runs on Cloudflare) | `cd services/agent && npm run dev` |
| `cloudflared` | (outbound only) | Tunnel from Cloudflare to `localhost:8080` | `cloudflared tunnel run <name>` (or `cloudflared tunnel --url http://localhost:8080` for a throwaway URL) |

On this machine port 8787 is taken by another project, so Thomas's Worker runs on 8788
(`apps/xr/.env` sets `VITE_API_PROXY`). Secrets for the agent go in `services/agent/.dev.vars`
locally (`OPENAI_API_KEY`, `SOLVER_KEY`, and `SOLVER_URL=https://<tunnel host>` when the
agent runs on Cloudflare).

## Before the demo
- [ ] Laptop on power; sleep and screen lock off
- [ ] On your own hotspot, not venue Wi-Fi
- [ ] Quest charged, developer mode on, USB cable tested
- [ ] OpenAI key, `OPENAI_MODEL`, `AI_GATEWAY_URL`, `SOLVER_URL` and `SOLVER_KEY` set on the agent (deployed: `wrangler secret put`)

## Start-up order
1. **Solver:** start `services/layout` on 8080 with `SOLVER_KEY` set.
   Check: `curl -H 'X-Solver-Key: …' localhost:8080/health` returns 200 with the OR-Tools version.
2. **Fit:** start `services/fit` on 8000.
3. **Tunnel:** start `cloudflared`. Check: the tunnel hostname's `/health` returns 401 without
   the key and 200 with it.
4. **Agent:** deployed on Cloudflare, or `npm run dev` in `services/agent`.
   Check: `curl localhost:8789/v1/agent/demo/health` says `"solver":"online"`.
5. **Headset page:** `npm run quest` in `apps/xr` (runs `adb reverse`, starts Vite).
6. **Quest:** open `http://localhost:5173`, **Enter VR**. Wrist shows the Designer tiles (and
   "solver offline" in the header if step 1 or 3 is down).
7. **Reset for a clean run:** `curl -X DELETE localhost:8789/v1/agent/<roomId>/memory`, then
   the wrist's *Reset room* tile.

`services/agent/scripts/e2e.sh` runs the whole chain (E1–E6) against these processes.

## If something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Wrist header says "solver offline" | Solver or `cloudflared` stopped, or the laptop lost internet | Steps 1–3; hotspot connected? Presets still work: they fall back to the stub proposal and say so |
| Tunnel `/health` returns 401 even with the key | Agent and solver have different `SOLVER_KEY`s | Set the same value on both |
| Requests fail at "Planning…" | OpenAI or AI Gateway issue | Presets fall back to built-in plans (the log says so); check the AI Gateway log |
| "The room changed. Ask again?" after every accept | Something saves the layout during proposals | Stop grabbing while a proposal is up |
| Quest shows the built-in fixture room | Thomas's Worker unreachable from Vite's proxy | Is it running on the port in `apps/xr/.env`? |
| Wrist says "Offline: sample proposal" | The agent isn't reachable at `/v1/agent` | `npm run dev` in `services/agent`; check `VITE_AGENT_PROXY` |
| Page won't load on the Quest | `adb reverse` lost (cable replugged) | Re-run `npm run quest` |
| Objects jam while applying | Collision groups not switched off between movers | Undo, then accept again; check `physics.setMovers` |

## Last resort on stage
Server or solver down: the headset shows the fixture room and the stub proposal and says so.
Keep talking through the pipeline while the stub plays; the architecture is the story.
