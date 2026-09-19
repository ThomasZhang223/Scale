"""services/search — hybrid retrieval and ranking (owner: Paul).

Skeleton only. Stateless HTTP service; Thomas's Worker proxies POST /search here verbatim, so
the request/response shape matches .claude/contracts.md exactly. Ranking is declared below but
not implemented. See ../README.md and ../RANKING.md.
"""

from fastapi import APIRouter, Depends, FastAPI

from .auth import require_upstream_token

app = FastAPI(title="search")

# local-edge patch: token gate for the tunnel hop (app/auth.py), plus /health for the
# container healthcheck. The gate is a router dependency, not a FastAPI(dependencies=...)
# global one — a global app-level dependency covers every included router too, including
# /health, and the container healthcheck carries no token. Path is /health, not /healthz —
# matches services/fit and services/ingest, and the convention the Worker's
# getUpstreamHealth already uses for the solver origin. See infra/README.md. Ranking logic
# below is untouched.
health_router = APIRouter()


@health_router.get("/health")
def health():
    return {"status": "ok"}


api_router = APIRouter(dependencies=[Depends(require_upstream_token)])


@api_router.post("/search")
def search():
    """Rank catalog/scan objects by style (vector similarity) filtered by fit (w_mm/h_mm/d_mm
    integer range), with the empty-result relaxed-fallback rule from ../RANKING.md.

    Not implemented.
    """
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=501, content={"error": "not_implemented", "endpoint": "search"})


app.include_router(health_router)
app.include_router(api_router)
