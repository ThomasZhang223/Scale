"""services/ingest — catalog and marketplace ingest (owner: Paul).

Skeleton only. Crawl and extract are declared as entry points below but not implemented.
See ../README.md and ../EXTRACTION.md.
"""

from fastapi import FastAPI

app = FastAPI(title="ingest")


@app.post("/crawl")
def crawl():
    """Pull a merchant's /products.json (or /collections/<handle>/products.json) catalog.

    Not implemented — see ../README.md for the verified-merchant prerequisite.
    """
    return _not_implemented("crawl")


@app.post("/extract")
def extract():
    """Run the five-step dimension extraction pipeline over pulled catalog data.

    Not implemented — see ../EXTRACTION.md for the pipeline steps.
    """
    return _not_implemented("extract")


def _not_implemented(name: str):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=501, content={"error": "not_implemented", "endpoint": name})
