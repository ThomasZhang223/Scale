# services/layout — the layout solver (OR-Tools CP-SAT)

**Owner:** Justin. Spec: `apps/xr/docs/agent/02_LAYOUT_SOLVER.md`; shapes in `01_CONTRACT.md` §6.

`POST /solve` places rectangles in a room in integer centimetres so every hard rule holds
(no overlaps with walkways, inside the walls, out of door keep-outs, pins) and as many soft
rules as possible, moving things as little as possible. `GET /health` reports the OR-Tools
version. Every request needs the Worker's `X-Solver-Key`.

It runs on a team laptop behind a Cloudflare Tunnel (`07_CLOUDFLARE_HOSTING.md`):

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
SOLVER_KEY=<shared secret> .venv/bin/uvicorn app.main:app --port 8080
curl -H 'X-Solver-Key: <shared secret>' localhost:8080/health
```

`STUB=1` returns `services/agent/fixtures/pipeline/solve-response.json` without solving.
`SOLVER_WORKERS` (default 1) sets CP-SAT's worker count.

Tests: `.venv/bin/python -m unittest discover -s tests -v` (the 10 from `02` plus S1–S4).
