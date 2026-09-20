# services/agent — the designer agent (Cloudflare Worker + Durable Object)

**Owner:** Justin. Specs: `apps/xr/docs/agent/` (`03_WORKER_AGENT.md` for the loop,
`08_PROTOCOL.md` for every message, `01_CONTRACT.md` for the routes).

One `DesignerAgent` Durable Object per room, on the Cloudflare Agents SDK, with its own
SQLite for request state, the visible decision log, the room's Version history and the
preferences it remembers. It's a separate Worker so it stays out of Thomas's `workers/`;
his Worker can forward `/v1/agent/*` here in one line.

```
headset ──POST /v1/agent/{roomId}/requests──▶ DesignerAgent
  read the room ─ clean the data (Rox log) ─ plan (OpenAI via AI Gateway, or the built-in
  preset plans) ─ POST /solve (OR-Tools on a laptop, through a Cloudflare Tunnel) ─
  POST /fit (double-check) ─ repair loops ─ explain ─ propose a Version
headset ◀── poll GET .../requests/{id}  and  SSE GET .../events
```

## Routes (after `/v1/agent/{roomId}`)

| Method and path | Job |
|---|---|
| `POST /state` | The headset's room JSON, objects (sizes, source, detected box) and current layout. Creates a `current` Version when the layout changed. **Addition to the contract**: needed because the main Worker's Versions are still stubs. |
| `GET /state` | The stored state and `currentVersionId`. |
| `POST /requests` | `{ text? \| preset?, pins, baseVersionId?, source }` → `202 { requestId }`. `X-Stub: 1` → `stub-req-1`, which walks the fixture timeline. |
| `GET /requests/{id}` | `{ state, log, proposal?, error? }`. |
| `POST /requests/{id}/accept` | Proposal becomes `current` (`409 { currentVersionId }` if the room changed since). |
| `POST /requests/{id}/reject` | Marks it rejected; a `reason` is remembered. |
| `POST /undo` | Previous Version back; undoing an agent change stores a preference against it. |
| `GET` / `DELETE /memory` | Preferences. |
| `GET /events` | SSE: `agent.status`, `agent.log`, `agent.proposal`, `agent.failed`, `version.current`. **Addition**: the main Worker's `/sync` is still a stub. |
| `GET /health` | Solver reachable? Planner configured? |
| `GET /versions`, `/versions/{id}` | History. |

## Run locally

```
npm install
npm run dev                     # wrangler dev, port 8789
```

With the `fit` container up on 8001 (`bash infra/up.sh`, or `docker compose --profile local
up -d --build fit`) — it serves both `/fit` and `/solve` (OR-Tools) — `scripts/e2e.sh` runs
the whole chain (E1–E6 from `09_END_TO_END_TESTS.md`).

Config lives in `wrangler.toml` (`OPENAI_MODEL`, `AI_GATEWAY_URL`). The fit container's origin
(one service, `/fit` and `/solve`) is the KV key `upstream:solver` in the same `CONFIG` namespace
as the front door, written by `infra/up.sh`; an unset key is an error, never a localhost fallback.
Local dev: `npx wrangler kv key put --binding CONFIG "upstream:solver" "http://127.0.0.1:8001" --local`;
secrets in `.dev.vars` locally or `wrangler secret put`: `OPENAI_API_KEY`, `UPSTREAM_TOKEN`
(the shared value from `infra/.env`, sent as `X-Upstream-Token`; the container 401s without
it), optionally `CF_AIG_TOKEN`. Without an OpenAI key, Rearrange and the presets use the
built-in rules and the log says so; typed requests need the planner.

## Tests

`npm test` — W1–W10 from `09_END_TO_END_TESTS.md` against the golden fixtures in
`fixtures/pipeline/`: room facts, plan validation wording, name resolution, hard rules,
solver↔Version conversion (incl. the shared `conversion-vectors.json`), and the loop with a
fixed plan and stubbed tools (relaxation, fit repair, planner failures, solver offline,
template explanation). `npm run typecheck` for the Worker itself.
