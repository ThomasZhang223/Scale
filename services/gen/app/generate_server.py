"""The dimension-binding generation adapter, as one small HTTP service.

Thomas's Worker (workers/src/workflows/generate-mesh.ts) POSTs `{tier, image_url, bbox_meters,
object_id, source, upload_url}` to BASETEN_URL with `Authorization: Api-Key <BASETEN_API_KEY>`.
It refuses raw SF3D output on purpose: this service sits in between, calls the SF3D model on
Baseten (deploy/sf3d) through SF3DProvider, binds the mesh to the measured bboxMeters with
the B04 binding, and returns the BasetenResult shape (`glbBase64` + receipt) that his
store-mesh step persists. The scale binding happens here, exactly once (standing rule 2).

Why a separate app from app/main.py: create_app() there also mounts the SigLIP2 embedding
service, which needs the pinned model environment. This one needs only the adapter
dependencies (requirements-adapters.txt) and runs anywhere.

Run (services/gen):
  PYTHONPATH=. GENERATION_API_KEY=… BASETEN_API_KEY=… SF3D_PREDICT_URL=https://model-….api.baseten.co/production/predict \
    uvicorn app.generate_server:app --port 8005

Review policy — read this before the demo. GENERATION_HANDOFF.md requires a human visual
review of every real SF3D artifact before it may be marked ready (`VisualReview`, evidence
"manual_review"), and an orientation profile that a person has checked. This service records
one operator-declared review and one operator-declared orientation for every artifact, from
GENERATION_REVIEWER and GENERATION_ORIENTATION (identity by default), so that the live demo
pipeline completes without a person in the loop. That is a policy decision by the demo
operator, not Ani's; the receipt names the reviewer so it is never mistaken for a human check.
# ceiling: one orientation for every object; a mesh that SF3D produces facing the wrong way is
# bound as-is. The upgrade is a per-category reviewed profile, as in tests/run_saved_sf3d_binding.py.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .binding import OrientationProfile
from .generation import AmbiguousGeneration, GenerationAttempt, GenerationError, PreparedArtifact, RawGeneration, VisualReview, identifier, worker_request
from .generation_io import SF3DProvider, private_http, response_bytes


class Provider(SF3DProvider):
    """SF3DProvider, with Baseten's request id kept only when it is a valid receipt identifier.

    Baseten's x-baseten-request-id is not shaped like the identifiers receipts accept, and the
    first live run failed on exactly that after a paid 51 s generation. The id is diagnostic
    only, so a non-conforming one is dropped rather than failing the artifact.
    """

    def generate(self, image, image_sha256):
        raw = super().generate(image, image_sha256)
        request_id = raw.request_id
        if request_id is not None:
            try:
                identifier(request_id)
            except GenerationError:
                request_id = None
        return RawGeneration(raw.glb, raw.image_sha256, raw.generator_revision, raw.evidence, request_id)

MAX_IMAGE_BYTES = 16 * 1024 * 1024
IDENTITY = ((1, 0, 0), (0, 1, 0), (0, 0, 1))


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        # Standing rule 4: which model, which key — never a default.
        raise RuntimeError(f"{name} is not set")
    return value


def _orientation() -> OrientationProfile:
    raw = os.environ.get("GENERATION_ORIENTATION", "").strip()
    matrix = tuple(tuple(row) for row in json.loads(raw)) if raw else IDENTITY
    return OrientationProfile("operator-declared", "1", matrix, "manual_review")


def fetch_image(image_url: str) -> tuple[bytes, str]:
    """The frame the Worker points at. The reference kept in the receipt is the path only."""
    url = urlsplit(image_url)
    if url.scheme != "https" or not url.hostname or url.username or url.password:
        raise GenerationError("invalid_image_url")
    with private_http():
        with httpx.Client(timeout=httpx.Timeout(60, connect=15), follow_redirects=False) as client:
            with client.stream("GET", image_url) as response:
                image = response_bytes(response, MAX_IMAGE_BYTES)
    return image, url.path


def handle(payload: dict) -> tuple[PreparedArtifact, VisualReview]:
    """One generation: image → SF3D on Baseten → bound to bboxMeters → reviewed receipt."""
    image_url = payload.get("image_url")
    if not isinstance(image_url, str):
        raise GenerationError("image_url_required")
    image, image_ref = fetch_image(image_url)
    request = worker_request(
        {k: v for k, v in payload.items() if k != "upload_url"},
        image,
        scope="worker-live",
        image_sha256=hashlib.sha256(image).hexdigest(),
        image_ref=image_ref,
    )
    provider = Provider(_required("SF3D_PREDICT_URL"), _required("BASETEN_API_KEY"), allow_paid=True)
    artifact = GenerationAttempt(request, provider, _orientation()).prepare()
    reviewer = os.environ.get("GENERATION_REVIEWER", "operator-auto-demo")
    return artifact, VisualReview(artifact.receipt["boundSha256"], reviewer, "manual_review")


app = FastAPI(title="Full Scale generation adapter")


@app.get("/health")
def health():
    return {
        "ok": True,
        "provider": bool(os.environ.get("SF3D_PREDICT_URL")) and bool(os.environ.get("BASETEN_API_KEY")),
        "auth": bool(os.environ.get("GENERATION_API_KEY")),
    }


@app.post("/generate")
async def generate(request: Request):
    # The Worker sends "Api-Key <token>"; the token is GENERATION_API_KEY, shared with it.
    expected = os.environ.get("GENERATION_API_KEY", "")
    if not expected:
        raise HTTPException(503, detail="generation_auth_unconfigured")
    provided = request.headers.get("authorization", "")
    for prefix in ("Api-Key ", "Bearer "):
        if provided.startswith(prefix):
            provided = provided[len(prefix):]
            break
    if not hmac.compare_digest(provided.encode(), expected.encode()):
        raise HTTPException(401, detail="unauthorized")
    if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
        raise HTTPException(415, detail="application_json_required")
    body = await request.body()
    if len(body) > 16384:
        raise HTTPException(413, detail="generation_request_too_large")
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError()
    except (ValueError, UnicodeError):
        raise HTTPException(422, detail="invalid_generation_request") from None
    try:
        artifact, review = await run_in_threadpool(handle, payload)
        return artifact.worker_result(review)
    except AmbiguousGeneration:
        return JSONResponse({"error": "generation_outcome_unknown_do_not_resubmit", "retryable": False}, 409)
    except GenerationError as e:
        logging.getLogger(__name__).exception("generation rejected: %s", e)
        return JSONResponse({"error": "generation_rejected", "detail": str(e), "retryable": False}, 422)
    except RuntimeError as e:
        return JSONResponse({"error": "generation_unconfigured", "detail": str(e), "retryable": False}, 503)
