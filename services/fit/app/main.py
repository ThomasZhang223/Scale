"""services/fit — HTTP surface.

  POST /fit   — VALIDATOR (app/fit.py). Body: { room: RoomCapture v1, placements: Placement v1[],
                objects?: { [objectId]: bboxMeters } }. This service is stateless and never
                fetches a room, so the Worker inlines the room and each object's bboxMeters
                when it proxies the public { roomId, placements } shape here.
  POST /solve — OPTIMISER. Grid discretisation + OR-Tools/scipy.optimize. Not implemented yet.

local-edge patch: token gate for the tunnel hop (app/auth.py), applied per-route like
services/search/app/main.py — a quick-tunnel URL is unguessable but fully public, and this
header is the only thing between the open internet and the solver on Thomas's laptop. /health
stays ungated: the Docker healthcheck calls it with no token, and workers/src/routes/index.ts's
getUpstreamHealth calls `${origin}/health`. See infra/README.md.
"""

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from .auth import require_upstream_token
from .fit import fit as run_fit

app = FastAPI(title="fit")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/fit", dependencies=[Depends(require_upstream_token)])
async def fit(request: Request):
    body = await request.json()
    room = body.get("room")
    if not isinstance(room, dict):
        return JSONResponse(
            status_code=422,
            content={
                "error": "room required",
                "message": "POST /fit is stateless: inline the RoomCapture v1 as `room` and each placed object's bboxMeters as `objects`",
            },
        )
    try:
        return run_fit(room, body.get("placements") or [], body.get("objects"))
    except (ValueError, KeyError, TypeError) as err:
        return JSONResponse(status_code=422, content={"error": "unfit input", "message": str(err)})


@app.post("/solve", dependencies=[Depends(require_upstream_token)])
async def solve(request: Request):
    return JSONResponse(
        status_code=501,
        content={"error": "not implemented", "route": "POST /solve"},
    )
