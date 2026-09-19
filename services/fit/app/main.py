"""services/fit — HTTP surface stubs.

Two routes, not implemented yet:
  POST /fit   — VALIDATOR. See app/README.md for the four checks it owes.
  POST /solve — OPTIMISER. Grid discretisation + OR-Tools/scipy.optimize.

Neither route implements any geometry or solving here. Both return HTTP 501
naming the route, per the scaffold-only scope of this pass.
"""

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from .auth import require_upstream_token

app = FastAPI(title="fit")

# local-edge patch: token gate for the tunnel hop (app/auth.py), plus /healthz for the
# container healthcheck. The gate is a router dependency, not a FastAPI(dependencies=...)
# global one — a global app-level dependency covers every included router too, including
# /healthz, and the container healthcheck carries no token. See infra/README.md.
health_router = APIRouter()


@health_router.get("/healthz")
async def healthz():
    return {"status": "ok"}


api_router = APIRouter(dependencies=[Depends(require_upstream_token)])


@api_router.post("/fit")
async def fit(request: Request):
    return JSONResponse(
        status_code=501,
        content={"error": "not implemented", "route": "POST /fit"},
    )


@api_router.post("/solve")
async def solve(request: Request):
    return JSONResponse(
        status_code=501,
        content={"error": "not implemented", "route": "POST /solve"},
    )


app.include_router(health_router)
app.include_router(api_router)
