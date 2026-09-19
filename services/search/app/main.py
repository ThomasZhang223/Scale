"""services/search — hybrid retrieval and ranking (owner: Paul).

Skeleton only. Stateless HTTP service; Thomas's Worker proxies POST /search here verbatim, so
the request/response shape matches .claude/contracts.md exactly. Ranking is declared below but
not implemented. See ../README.md and ../RANKING.md.
"""

from fastapi import FastAPI

app = FastAPI(title="search")


@app.post("/search")
def search():
    """Rank catalog/scan objects by style (vector similarity) filtered by fit (w_mm/h_mm/d_mm
    integer range), with the empty-result relaxed-fallback rule from ../RANKING.md.

    Not implemented.
    """
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=501, content={"error": "not_implemented", "endpoint": "search"})
