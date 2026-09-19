"""services/ingest — catalog and marketplace ingest (owner: Paul).

Skeleton only. Crawl and extract are declared as entry points below but not implemented.
See ../README.md and ../EXTRACTION.md.
"""

from fastapi import APIRouter, Depends, FastAPI

from .auth import require_upstream_token

app = FastAPI(title="ingest")

# local-edge patch: token gate for the tunnel hop (app/auth.py), plus /healthz for the
# container healthcheck. The gate is a router dependency, not a FastAPI(dependencies=...)
# global one — a global app-level dependency covers every included router too, including
# /healthz, and the container healthcheck carries no token. See infra/README.md. Crawl/extract
# logic below is untouched.
health_router = APIRouter()


@health_router.get("/healthz")
def healthz():
    return {"status": "ok"}


api_router = APIRouter(dependencies=[Depends(require_upstream_token)])


@api_router.post("/crawl")
def crawl():
    """Pull a merchant's /products.json (or /collections/<handle>/products.json) catalog.

    Not implemented — see ../README.md for the verified-merchant prerequisite.
    """
    return _not_implemented("crawl")


@api_router.post("/extract")
def extract():
    """Run the five-step dimension extraction pipeline over pulled catalog data.

    Not implemented — see ../EXTRACTION.md for the pipeline steps.
    """
    return _not_implemented("extract")


def _not_implemented(name: str):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=501, content={"error": "not_implemented", "endpoint": name})


app.include_router(health_router)
app.include_router(api_router)
