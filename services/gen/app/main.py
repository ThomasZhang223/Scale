"""CPU embeddings and the existing generation route's narrow integration seam.

B04/B06 are library adapters. No GPU provider or durable job authority is guessed
at startup. An owner-supplied generation handler must reconcile existing attempts.
"""
import json
import os

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from .embedding.api import create_app as embedding_app, ServiceTokenAuth
from .embedding.images import ManifestImageReader


def create_app(*, generation_handler=None, generation_auth=None, **embedding_options):
    manifest = os.environ.get("EMBEDDING_IMAGE_MANIFEST")
    if manifest and "image_reader" not in embedding_options:
        embedding_options["image_reader"] = ManifestImageReader(manifest)
    app = embedding_app(**embedding_options)

    @app.post("/generate")
    async def generate(request: Request):
        auth = generation_auth or ServiceTokenAuth(os.environ.get("GENERATION_API_KEY"))
        authorization = request.headers.get("authorization", "")
        if authorization.startswith("Api-Key "):
            authorization = "Bearer " + authorization[8:]
        principal = auth.authenticate(authorization)
        if generation_handler is None:
            raise HTTPException(503, detail="generation_provider_and_job_authority_unconfigured")
        if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
            raise HTTPException(415, detail="application_json_required")
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 16384:
                raise HTTPException(413, detail="generation_request_too_large")
            body.extend(chunk)
        try:
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError()
        except (ValueError, UnicodeError):
            raise HTTPException(422, detail="invalid_generation_request") from None
        # Handler resolves authorized image/source/scope and durable attempt ownership.
        # Only PreparedArtifact + matching review may cross the completion seam.
        from .generation import PreparedArtifact, GenerationError, AmbiguousGeneration
        try:
            artifact, review = await run_in_threadpool(generation_handler, payload, principal)
            if not isinstance(artifact, PreparedArtifact):
                raise GenerationError("invalid_generation_handler_result")
            return artifact.worker_result(review)
        except AmbiguousGeneration:
            return JSONResponse({"error": "generation_outcome_unknown_do_not_resubmit", "retryable": False}, 409)
        except GenerationError:
            return JSONResponse({"error": "generation_rejected", "retryable": False}, 422)
        except Exception:
            return JSONResponse({"error": "generation_failed_do_not_resubmit", "retryable": False}, 502)

    return app


app = create_app()
