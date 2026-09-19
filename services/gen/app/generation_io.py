"""Bounded provider/storage clients. Construction never performs I/O or paid work."""
import base64
import hashlib
import json
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import urlsplit

import httpx

from deploy.sf3d.model.transport import decode_response, MAX_RESPONSE_BYTES
from deploy.sf3d.model.model import SOURCE_REVISION, MODEL_REVISION
from .generation import RawGeneration, GenerationError, AmbiguousGeneration, identifier, check


_private_io = ContextVar("ani_private_http", default=False)


class _PrivateTransportFilter(logging.Filter):
    def filter(self, record):
        return not _private_io.get()


_transport_filter = _PrivateTransportFilter()


@contextmanager
def private_http():
    # httpx INFO logs include full signed URLs. Suppress transport logs only in this
    # execution context; do not change other requests' logging or log secret bodies.
    for name in ["httpx", "httpcore", *list(logging.Logger.manager.loggerDict)]:
        if name == "httpx" or name == "httpcore" or name.startswith(("httpx.", "httpcore.")):
            logging.getLogger(name).addFilter(_transport_filter)
    token = _private_io.set(True)
    try:
        yield
    finally:
        _private_io.reset(token)


def response_bytes(response, limit):
    check(response.status_code == 200, "upstream_http_error")
    chunks = bytearray()
    for chunk in response.iter_bytes(chunk_size=65536):
        check(len(chunks) + len(chunk) <= limit, "upstream_response_too_large")
        chunks.extend(chunk)
    return bytes(chunks)


class SF3DProvider:
    def __init__(self, endpoint, token, *, allow_paid=False, client=None):
        # b02_smoke's sibling imports assume its CLI path, so validate the same narrow
        # endpoint here instead of changing that standalone feasibility runner.
        self.endpoint, self._token = endpoint, token
        self.allow_paid, self.client = allow_paid, client

    @private_http()
    def generate(self, image, image_sha256):
        check(self.allow_paid and bool(self._token), "paid_generation_not_enabled")
        url = urlsplit(self.endpoint)
        import re
        check(url.scheme == "https" and not url.username and not url.password and not url.query
              and not url.fragment and url.port in (None, 443)
              and re.fullmatch(r"model-[A-Za-z0-9-]+\.api\.baseten\.co", url.hostname or "")
              and url.path.endswith("/predict") and "async" not in url.path, "invalid_provider_endpoint")
        client = self.client or httpx.Client(timeout=httpx.Timeout(180, connect=15), follow_redirects=False)
        try:
            with client.stream("POST", self.endpoint, headers={"Authorization": "Bearer " + self._token},
                               json={"image_base64": base64.b64encode(image).decode("ascii")},
                               follow_redirects=False) as response:
                payload = json.loads(response_bytes(response, MAX_RESPONSE_BYTES))
            glb = decode_response(payload, image_sha256)
            revisions = payload.get("revisions", {})
            check(revisions.get("sf3d_source") == SOURCE_REVISION
                  and revisions.get("sf3d_weights") == MODEL_REVISION, "provider_revision_mismatch")
            return RawGeneration(glb, image_sha256, SOURCE_REVISION + ":" + MODEL_REVISION,
                                 "real_sf3d", response.headers.get("x-baseten-request-id"))
        except httpx.RequestError:
            raise AmbiguousGeneration("generation_outcome_unknown_do_not_resubmit") from None
        except (httpx.HTTPError, ValueError, TypeError, KeyError):
            raise GenerationError("provider_response_rejected") from None
        finally:
            if self.client is None:
                client.close()


class WorkerArtifactSink:
    """Reuse Thomas /uploads + PUT + assets; verify bytes before returning glbKey.

    No automatic PUT retry: each deliver retry mints a fresh single-use grant and
    uploads the SAME bytes. Origin is trusted configuration, never a job-body URL.
    """
    def __init__(self, origin, *, client=None):
        url = urlsplit(origin)
        check(url.scheme == "https" and bool(url.hostname) and not url.username and not url.password
              and not url.query and not url.fragment and url.path in ("", "/"), "invalid_worker_origin")
        self.origin, self.client = origin.rstrip("/"), client

    @private_http()
    def put(self, object_id, glb, sha256):
        identifier(object_id)
        check(hashlib.sha256(glb).hexdigest() == sha256, "artifact_changed")
        key = f"objects/{object_id}/mesh.glb"
        client = self.client or httpx.Client(timeout=30, follow_redirects=False)
        try:
            with client.stream("POST", self.origin + "/v1/uploads",
                               json={"kind": "objectMesh", "ext": "glb", "objectId": object_id},
                               follow_redirects=False) as response:
                grant = json.loads(response_bytes(response, 16384))
            target = urlsplit(grant["putUrl"])
            origin = urlsplit(self.origin)
            check(grant.get("key") == key and target.scheme == origin.scheme
                  and target.netloc == origin.netloc and not target.username and not target.password
                  and not target.fragment and target.path == "/v1/uploads/" + key,
                  "upload_grant_mismatch")
            response = client.put(grant["putUrl"], content=glb,
                                  headers={"content-type": "model/gltf-binary"}, follow_redirects=False)
            check(response.is_success, "artifact_upload_failed")
            with client.stream("GET", self.origin + "/v1/assets/" + key,
                               headers={"Cache-Control": "no-cache"}, follow_redirects=False) as response:
                stored = response_bytes(response, len(glb))
            check(hashlib.sha256(stored).hexdigest() == sha256, "stored_artifact_hash_mismatch")
            return key
        except (httpx.HTTPError, ValueError, TypeError, KeyError):
            raise GenerationError("artifact_delivery_failed_retry_same_bytes") from None
        finally:
            if self.client is None:
                client.close()
