"""services/search — hybrid retrieval and ranking (owner: Paul).

Stateless HTTP service. Thomas's Worker proxies POST /search here verbatim, so the
request/response shape is the one in .claude/contracts.md and there is only ever one shape to
agree on. Ranking lives in ranking.py; where candidates come from lives in index.py.

  POST /search  { text?, imageKey?, fit?, source?, limit }  ->  [{ objectId, score, object }]

See ../RANKING.md for the rule that governs all of it: style and fit are two halves of the
query and they never mix.
"""

from __future__ import annotations

import logging
import os

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from .auth import require_upstream_token
from .index import BruteForceIndex, candidate_from_object_v1
from .ranking import fit_bounds_mm, rank

app = FastAPI(title="search")
log = logging.getLogger("search")

# The live index. Populated by POST /index as Ani's objects reach state:"ready"; swapped for
# VectorizeIndex when those rows land (index.py).
INDEX = BruteForceIndex()

# Ani's embedder (services/gen). Absent in dev, which is why a missing embedding degrades the
# query rather than failing it — see _embed.
EMBED_URL = os.environ.get("EMBED_URL")


async def _embed(text: str | None, image_key: str | None) -> tuple[list[float] | None, str | None]:
    """(vector, degraded_code). Never raises: a dead embedder must not take the demo with it.

    Reporting a code is not the same as silently substituting a default (standing rule 4) — the
    caller sees it and can say the ranking was style-blind.

    The code is a short ASCII token, never prose: HTTP headers are latin-1, so a single em dash
    in here returns a 500 instead of results. Detail goes to the log.
    """
    if not text and not image_key:
        return None, None
    if not EMBED_URL:
        log.warning("search: EMBED_URL unset; ranking on colour and confidence only")
        return None, "no-embedder"
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(EMBED_URL, json={"text": text, "imageKey": image_key})
            r.raise_for_status()
            vec = r.json().get("vector")
            if not vec:
                log.warning("search: embedder returned no vector")
                return None, "empty-vector"
            return vec, None
    except Exception as e:  # noqa: BLE001 — any failure here degrades, never propagates
        log.warning("search: embedder unavailable (%s); ranking on colour and confidence only", type(e).__name__)
        return None, "embedder-unavailable"


@app.post("/search", dependencies=[Depends(require_upstream_token)])
async def search(request: Request):
    body = await request.json()

    limit = int(body.get("limit") or 10)
    fit = body.get("fit")

    # PROPOSED contract additions, both optional and both harmless when absent. Neither is in
    # .claude/contracts.md yet and contracts.md is Thomas's file — see ../README.md "Proposed".
    palette = body.get("palette") or []
    like_object_id = body.get("likeObjectId")

    try:
        fit_bounds_mm(fit)  # validate units early so a bad filter fails loudly, not silently
    except ValueError as e:
        return JSONResponse(status_code=422, content={"error": "bad_fit", "detail": str(e)})

    vector, degraded = await _embed(body.get("text"), body.get("imageKey"))

    target_hex = palette[0] if palette else None
    if like_object_id and not target_hex:
        # "matches ITS wood tone" — the tone belongs to an object already in the room.
        ref = INDEX.get(like_object_id)
        if ref is not None:
            target_hex = ref.dominant_hex
            if vector is None:
                vector = ref.vector

    candidates = INDEX.query(vector, bounds=fit_bounds_mm(fit), limit=limit)
    results, relaxed = rank(
        candidates,
        fit=fit,
        query_vector=vector,
        target_hex=target_hex,
        source=body.get("source"),
        limit=limit,
    )

    payload = [
        {"objectId": r.object_id, "score": r.score, "object": r.object, **({"relaxed": True} if r.relaxed else {})}
        for r in results
    ]
    headers = {}
    if relaxed:
        # RANKING.md: never an empty screen, and never a quiet one either — the caller has to
        # be able to say "these are slightly outside what you asked for".
        headers["X-Fit-Relaxed"] = "1"
    if degraded:
        headers["X-Search-Degraded"] = degraded
    return JSONResponse(content=payload, headers=headers)


@app.post("/index", dependencies=[Depends(require_upstream_token)])
async def index_objects(request: Request):
    """Load `Object v1` rows for ranking. Ani's pipeline calls this on state:"ready"."""
    body = await request.json()
    objects = body.get("objects") or []
    try:
        INDEX.upsert([
            candidate_from_object_v1(o, o.get("vector")) for o in objects
        ])
    except ValueError as e:
        return JSONResponse(status_code=422, content={"error": "unrankable_object", "detail": str(e)})
    return {"indexed": len(objects), "total": len(INDEX)}


@app.get("/health")
async def health():
    return {"ok": True, "indexed": len(INDEX), "embedder": bool(EMBED_URL)}
