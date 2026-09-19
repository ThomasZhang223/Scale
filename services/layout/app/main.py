"""services/layout — HTTP surface.

  POST /solve  — the OR-Tools layout solver (app/solver.py). Shapes in docs/agent/01_CONTRACT.md §6.
  GET  /health — 200 with the OR-Tools version, for the Worker's "Solver online" check.

This runs on a team laptop behind a Cloudflare Tunnel, so every request must carry the
Worker's credential (X-Solver-Key, shared with the Worker as a secret). STUB=1 returns the
committed fixture without solving.
"""

import json
import os
import sys

import ortools
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .solver import solve as run_solve

app = FastAPI(title="layout")

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "agent", "fixtures", "pipeline", "solve-response.json")


def solver_key() -> str:
    key = os.environ.get("SOLVER_KEY")
    if not key:
        print("SOLVER_KEY is not set; using the development key. Set it before exposing the tunnel.", file=sys.stderr)
        key = "dev-solver-key"
    return key


def authorized(request: Request) -> bool:
    return request.headers.get("X-Solver-Key") == solver_key()


@app.get("/health")
async def health(request: Request):
    if not authorized(request):
        return JSONResponse(status_code=401, content={"error": "missing or wrong X-Solver-Key"})
    return {"ok": True, "ortools": ortools.__version__, "workers": int(os.environ.get("SOLVER_WORKERS", "8"))}


@app.post("/solve")
async def solve(request: Request):
    if not authorized(request):
        return JSONResponse(status_code=401, content={"error": "missing or wrong X-Solver-Key"})
    if os.environ.get("STUB") == "1":
        with open(FIXTURE) as f:
            return json.load(f)
    body = await request.json()
    try:
        return run_solve(body)
    except (ValueError, KeyError, TypeError) as err:
        return JSONResponse(status_code=422, content={"error": "unsolvable input", "message": str(err)})
