"""services/fit — HTTP surface.

  POST /fit   — VALIDATOR (app/fit.py). Body: { room: RoomCapture v1, placements: Placement v1[],
                objects?: { [objectId]: bboxMeters } }. This service is stateless and never
                fetches a room, so the Worker inlines the room and each object's bboxMeters
                when it proxies the public { roomId, placements } shape here.
  POST /solve — OPTIMISER. Grid discretisation + OR-Tools/scipy.optimize. Not implemented yet.
"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .fit import fit as run_fit

app = FastAPI(title="fit")


@app.post("/fit")
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


@app.post("/solve")
async def solve(request: Request):
    return JSONResponse(
        status_code=501,
        content={"error": "not implemented", "route": "POST /solve"},
    )
