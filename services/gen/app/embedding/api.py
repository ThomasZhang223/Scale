"""Internal /embed boundary; storage/auth implementations are injected at the seam."""

from contextlib import asynccontextmanager
from dataclasses import dataclass
import hmac
import json
import logging
import math
import os
import re
from typing import Literal, Protocol

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, ValidationError, model_validator
from starlette.concurrency import run_in_threadpool

from .config import DIMENSION, MAX_BODY_BYTES, MAX_IMAGE_BYTES
from .encoder import SiglipEncoder, EncoderBusy, EncoderInvariantError
from .preprocess import InputError, InputTooLarge, image_bytes_from_base64


@dataclass(frozen=True)
class Principal:
    subject: str


class Authenticator(Protocol):
    def authenticate(self, authorization: str | None) -> Principal: ...


class ImageReader(Protocol):
    async def read_authorized(self, key: str, principal: Principal, max_bytes: int) -> bytes:
        """Authorize this principal/key and bound bytes during storage streaming.

        Raise PermissionError/FileNotFoundError/TimeoutError/OSError as appropriate.
        The default service has NO storage adapter; it cannot fetch arbitrary URLs.
        """
        ...


class ServiceTokenAuth:
    def __init__(self, token):
        self._token = token

    def authenticate(self, authorization):
        if not self._token:
            raise HTTPException(503, detail="embedding_auth_unconfigured")
        provided = authorization or ""
        expected = "Bearer " + self._token
        if not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
            raise HTTPException(401, detail="unauthorized")
        return Principal("trusted-internal-service")


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    imageBase64: str | None = None
    imageKey: str | None = Field(default=None, min_length=1, max_length=1024)
    text: str | None = Field(default=None, max_length=4096)
    expectedFingerprint: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def one_input(self):
        if sum(v is not None for v in (self.imageBase64, self.imageKey, self.text)) != 1:
            raise ValueError("Exactly one imageBase64, imageKey or text is required")
        if self.imageKey is not None:
            if (not re.fullmatch(r"[A-Za-z0-9_./-]+", self.imageKey)
                    or self.imageKey.startswith("/")
                    or any(p in ("", ".", "..") for p in self.imageKey.split("/"))):
                raise ValueError("Expected a relative authorized object key, not a URL or path")
        return self


class EmbedResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    values: list[FiniteFloat] = Field(min_length=DIMENSION, max_length=DIMENSION)
    dimension: Literal[768]
    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    inputHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    modality: Literal["image", "text"]

    @model_validator(mode="after")
    def unit_length(self):
        if abs(math.sqrt(sum(v * v for v in self.values)) - 1) > 1e-5:
            raise ValueError("Embedding must be L2 normalized")
        return self


async def bounded_request(request, *, worker_compat=False):
    if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
        raise HTTPException(415, detail="application_json_required")
    try:
        length = int(request.headers.get("content-length", "0"))
    except ValueError:
        raise HTTPException(400, detail="invalid_content_length") from None
    if length > MAX_BODY_BYTES:
        raise HTTPException(413, detail="request_too_large")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, detail="request_too_large")
        body.extend(chunk)
    try:
        data = json.loads(body)
        if worker_compat and isinstance(data, dict) and "image_key" in data:
            if "imageKey" in data:
                raise ValueError("Ambiguous image key")
            data["imageKey"] = data.pop("image_key")
        return EmbedRequest.model_validate(data)
    except (ValueError, UnicodeError):
        # Do not echo the image, text, key, auth or raw Pydantic input in errors.
        raise HTTPException(422, detail="invalid_embedding_request") from None


def create_app(*, encoder=None, authenticator=None, image_reader: ImageReader | None = None,
               load_encoder=True):
    @asynccontextmanager
    async def lifespan(app):
        app.state.auth = authenticator or ServiceTokenAuth(os.environ.get("EMBEDDING_API_KEY"))
        if encoder is None and load_encoder:
            try:
                cache_dir = os.environ.get("EMBEDDING_CACHE_DIR")
                if not cache_dir:
                    raise RuntimeError("EMBEDDING_CACHE_DIR must name the approved local cache")
                app.state.encoder = await run_in_threadpool(SiglipEncoder, cache_dir)
            except Exception as exc:
                logging.getLogger(__name__).error("Embedding unavailable: %s", type(exc).__name__)
                app.state.encoder = None
        yield

    app = FastAPI(title="services-gen", lifespan=lifespan)
    app.state.encoder = encoder
    app.state.auth = authenticator or ServiceTokenAuth(None)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/ready")
    async def ready():
        current = app.state.encoder
        if current is None:
            return JSONResponse({"ready": False, "error": "embedding_model_unavailable"}, status_code=503)
        return {"ready": True, "fingerprint": current.fingerprint}

    @app.post("/embed", response_model=EmbedResponse)
    async def embed(request: Request):
        authorization = request.headers.get("authorization", "")
        worker = os.environ.get("EMBEDDING_WORKER_COMPAT") == "1" and authorization.startswith("Api-Key ")
        principal = app.state.auth.authenticate("Bearer " + authorization[8:] if worker else authorization)
        payload = await bounded_request(request, worker_compat=worker)
        if worker:
            expected = os.environ.get("EMBEDDING_SEARCH_FINGERPRINT")
            if not expected:
                raise HTTPException(503, detail="search_fingerprint_unconfigured")
            if payload.expectedFingerprint is not None and payload.expectedFingerprint != expected:
                raise HTTPException(409, detail="embedding_fingerprint_mismatch")
            payload.expectedFingerprint = expected
        result = await encode(payload, principal)
        if worker:
            return JSONResponse({**result.model_dump(), "embedding": result.values})
        return result

    @app.post("/embed/search")
    async def search_compat(request: Request):
        """Paul's no-header caller, opt-in and localhost only; never expose by tunnel.

        Normal /embed stays authenticated. No credential in an EMBED_URL query string.
        Uses the same real encoder/validation and returns Paul's `vector` alias.
        """
        if (os.environ.get("EMBEDDING_LOCAL_SEARCH") != "1" or request.client is None
                or request.client.host not in ("127.0.0.1", "::1")
                or any(h in request.headers for h in ("forwarded", "x-forwarded-for", "x-forwarded-host"))):
            raise HTTPException(403, detail="local_search_only")
        payload = await bounded_request(request)
        expected = os.environ.get("EMBEDDING_SEARCH_FINGERPRINT")
        if not expected:
            raise HTTPException(503, detail="search_fingerprint_unconfigured")
        if payload.expectedFingerprint is not None and payload.expectedFingerprint != expected:
            raise HTTPException(409, detail="embedding_fingerprint_mismatch")
        payload.expectedFingerprint = expected
        result = await encode(payload, Principal("trusted-local-search"))
        return {**result.model_dump(), "vector": result.values}

    async def encode(payload, principal):
        current = app.state.encoder
        if current is None:
            raise HTTPException(503, detail="embedding_model_unavailable")
        if payload.expectedFingerprint is not None and payload.expectedFingerprint != current.fingerprint:
            raise HTTPException(409, detail="embedding_fingerprint_mismatch")
        try:
            raw = None
            if payload.imageBase64 is not None:
                raw = image_bytes_from_base64(payload.imageBase64)
            elif payload.imageKey is not None:
                if image_reader is None:
                    raise HTTPException(503, detail="authorized_image_reader_unconfigured")
                raw = await image_reader.read_authorized(payload.imageKey, principal, MAX_IMAGE_BYTES)
                if not isinstance(raw, bytes):
                    raise EncoderInvariantError("Storage adapter returned non-bytes")
                if len(raw) > MAX_IMAGE_BYTES:
                    raise InputTooLarge("Image exceeds byte limit")
            result = await run_in_threadpool(current.response, image=raw, text=payload.text)
            try:
                return EmbedResponse.model_validate(result)
            except ValidationError:
                raise EncoderInvariantError("Invalid embedding response") from None
        except InputTooLarge:
            raise HTTPException(413, detail="embedding_input_too_large") from None
        except InputError:
            raise HTTPException(422, detail="invalid_embedding_input") from None
        except EncoderBusy:
            raise HTTPException(429, detail="embedding_busy", headers={"Retry-After": "1"}) from None
        except PermissionError:
            raise HTTPException(403, detail="image_forbidden") from None
        except FileNotFoundError:
            raise HTTPException(404, detail="image_not_found") from None
        except TimeoutError:
            raise HTTPException(504, detail="image_read_timeout") from None
        except OSError:
            raise HTTPException(502, detail="image_read_failed") from None
        except EncoderInvariantError:
            raise HTTPException(500, detail="embedding_validation_failed") from None

    return app
