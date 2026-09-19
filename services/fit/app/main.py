"""services/fit — HTTP surface stubs.

Two routes, not implemented yet:
  POST /fit   — VALIDATOR. See app/README.md for the four checks it owes.
  POST /solve — OPTIMISER. Grid discretisation + OR-Tools/scipy.optimize.

Neither route implements any geometry or solving here. Both return HTTP 501
naming the route, per the scaffold-only scope of this pass.
"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="fit")


@app.post("/fit")
async def fit(request: Request):
    return JSONResponse(
        status_code=501,
        content={"error": "not implemented", "route": "POST /fit"},
    )


@app.post("/solve")
async def solve(request: Request):
    return JSONResponse(
        status_code=501,
        content={"error": "not implemented", "route": "POST /solve"},
    )
