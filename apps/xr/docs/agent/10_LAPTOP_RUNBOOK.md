# Laptop runbook (demo day)

The laptop runs the headset's page, the OR-Tools solver, and the tunnel that lets the
Cloudflare agent reach the solver. Everything else is on Cloudflare.

| Process | Port | Job |
|---|---|---|
| Vite dev server | 5173 | Serves the Quest over USB; proxies `/v1` to the Worker |
| `services/layout` | 8080 | OR-Tools solver: `POST /solve`, `GET /health` |
| `cloudflared` | (outbound only) | Tunnel from Cloudflare to `localhost:8080` |

## Before the demo
- [ ] Laptop on power; sleep and screen lock off
- [ ] On your own hotspot, not venue Wi-Fi
- [ ] Quest charged, developer mode on, USB cable tested
- [ ] OpenAI key, `OPENAI_MODEL`, `SOLVER_URL` and the solver credential set on the Worker

## Start-up order
1. **Solver:** start `services/layout` on port 8080 with the credential set.
   Check: `curl localhost:8080/health` returns 200.
2. **Tunnel:** start `cloudflared` for the named tunnel.
   Check: the tunnel hostname's `/health` returns 401 without the credential and 200 with it.
3. **Headset page:** `npm run quest` (runs `adb reverse`, starts Vite).
4. **Quest:** open `http://localhost:5173`, **Enter VR**. Wrist shows "Solver online".
5. **Reset for a clean run:** reset memory (`DELETE /v1/agent/{roomId}/memory`) and the room.

## If something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Wrist says "Solver offline" | Solver or `cloudflared` stopped, or the laptop lost internet | Check steps 1–2; hotspot connected? |
| Tunnel `/health` returns 401 even with the credential | Worker and solver have different secrets | Re-set the same value on both |
| Requests hang at "Planning…" | OpenAI or AI Gateway issue | Presets fall back to built-in plans; check the AI Gateway log |
| "Room changed, ask again?" after every accept | Something saves the layout during proposals | Stop grabbing while a proposal is up; check the save path |
| Quest shows the built-in fixture room | Worker unreachable from Vite's proxy | Laptop internet; Worker deployed? |
| Page won't load on the Quest | `adb reverse` lost (cable replugged) | Re-run `npm run quest` |
| Objects jam while applying | Collision groups not switched off between moving objects | Known risk in `04`; Undo, then accept again |

## Last resort on stage
Server or solver down: the headset shows the fixture room and the stub proposal and says so.
Keep talking through the pipeline while the stub plays; the architecture is the story.
