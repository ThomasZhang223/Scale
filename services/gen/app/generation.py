"""One Ani-owned generation attempt + B04 + delivery; no queue, DB, SSE or GPU imports."""
import base64
from dataclasses import dataclass, field
import hashlib
import json
import re
import threading
import time
from typing import Protocol

from .binding import GeneratedAsset, SelectedProduct, OrientationProfile, bind_selected, BindingError
from .embedding.preprocess import decode_image, InputError
from .embedding.records import bbox, digest, canonical, safe_reference, RecordError


class GenerationError(RuntimeError):
    """Sanitized code only. Never include upstream exception bodies/URLs."""


class AmbiguousGeneration(GenerationError):
    pass


def check(condition, code):
    if not condition:
        raise GenerationError(code)


def identifier(value):
    check(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value), "invalid_identifier")
    return value


@dataclass(frozen=True)
class GenerationInput:
    object_id: str
    source: str
    scope: str
    image: bytes = field(repr=False)
    image_sha256: str
    dimensions: tuple
    image_ref: str

    @classmethod
    def from_object(cls, obj, image, *, image_sha256, image_ref, scope):
        """Use the selected/owned Object, never the query Object. Snapshot mutable metadata."""
        try:
            box = bbox(obj.get("bboxMeters"))
            digest(image_sha256)
            safe_reference(image_ref)
            check(obj.get("source") in ("scan", "catalog"), "unsupported_object_source")
            check(isinstance(scope, str) and bool(scope.strip()), "scope_required")
            check(isinstance(image, bytes) and hashlib.sha256(image).hexdigest() == image_sha256,
                  "selected_image_hash_mismatch")
            decode_image(image)
            return cls(identifier(obj.get("objectId")), obj["source"], scope, image, image_sha256,
                       tuple(box[k] for k in ("w", "h", "d")), image_ref)
        except (RecordError, InputError, AttributeError, TypeError):
            raise GenerationError("invalid_generation_input") from None

    @property
    def bbox_meters(self):
        return dict(zip(("w", "h", "d"), self.dimensions))


@dataclass(frozen=True)
class RawGeneration:
    glb: bytes = field(repr=False)
    image_sha256: str
    generator_revision: str
    evidence: str  # real_sf3d, cached_real_sf3d, fake_provider (tests only)
    request_id: str | None = None


class GenerationProvider(Protocol):
    def generate(self, image: bytes, image_sha256: str) -> RawGeneration: ...


@dataclass(frozen=True)
class VisualReview:
    bound_sha256: str
    reviewer: str
    evidence: str  # manual_review or synthetic_test


@dataclass(frozen=True)
class PreparedArtifact:
    glb: bytes = field(repr=False)
    receipt_json: str

    @property
    def receipt(self):
        return json.loads(self.receipt_json)

    def reviewed_receipt(self, review):
        receipt = self.receipt
        check(isinstance(review, VisualReview) and review.bound_sha256 == receipt["boundSha256"],
              "review_must_match_artifact")
        identifier(review.reviewer)
        expected = "synthetic_test" if receipt["evidence"] == "fake_provider" else "manual_review"
        check(review.evidence == expected, "visual_review_required")
        check(hashlib.sha256(self.glb).hexdigest() == receipt["boundSha256"], "artifact_changed")
        receipt["visualReview"] = {"reviewer": review.reviewer, "evidence": review.evidence,
                                    "boundSha256": review.bound_sha256}
        return receipt

    def worker_result(self, review):
        """Thomas BasetenResult inline shape. His store-mesh step persists these bytes."""
        receipt = self.reviewed_receipt(review)
        return {"glbBase64": base64.b64encode(self.glb).decode("ascii"), "artifact": receipt}


class GenerationAttempt:
    """Single-use object owned by the caller's job. Reuse it for local duplicate calls.

    No persistent job authority is implemented here. Thomas must keep his durable
    attempt/request ID and must not recreate an attempt after an ambiguous timeout.
    """
    def __init__(self, request, provider, orientation):
        check(isinstance(request, GenerationInput), "generation_input_required")
        # Revalidate even if someone bypassed the from_object constructor.
        self.request = GenerationInput.from_object(
            {"objectId": request.object_id, "source": request.source, "bboxMeters": request.bbox_meters},
            request.image, image_sha256=request.image_sha256, image_ref=request.image_ref, scope=request.scope)
        check(isinstance(orientation, OrientationProfile), "reviewed_orientation_required")
        try:
            profile = orientation.payload()
        except (BindingError, ValueError, TypeError):
            raise GenerationError("invalid_orientation") from None
        self.orientation = OrientationProfile(profile["name"], profile["version"],
            tuple(tuple(row) for row in profile["matrix"]), profile["evidence"])
        self.provider = provider
        self._attempted = False
        self._artifact = None
        self._ambiguous = False
        self._lock = threading.Lock()

    def prepare(self):
        if not self._lock.acquire(blocking=False):
            raise GenerationError("generation_busy")
        try:
            if self._artifact is not None:
                return self._artifact
            if self._ambiguous:
                raise AmbiguousGeneration("generation_outcome_unknown_do_not_resubmit")
            check(not self._attempted, "generation_already_attempted")
            self._attempted = True
            req = self.request
            started = time.perf_counter()
            try:
                raw = self.provider.generate(req.image, req.image_sha256)
            except (TimeoutError, AmbiguousGeneration):
                self._ambiguous = True
                raise AmbiguousGeneration("generation_outcome_unknown_do_not_resubmit") from None
            except Exception:
                raise GenerationError("provider_failed") from None
            generated = time.perf_counter()
            check(isinstance(raw, RawGeneration) and isinstance(raw.glb, bytes), "invalid_provider_response")
            check(raw.image_sha256 == req.image_sha256, "provider_image_mismatch")
            check(raw.evidence in ("real_sf3d", "cached_real_sf3d", "fake_provider"), "unknown_generation_evidence")
            try:
                safe_reference(raw.generator_revision)
                if raw.request_id is not None:
                    identifier(raw.request_id)
                if raw.evidence != "fake_provider":
                    check(self.orientation.evidence == "manual_review", "real_orientation_review_required")
                bound = bind_selected(GeneratedAsset(raw.glb, raw.image_sha256),
                    SelectedProduct(req.object_id, req.image_sha256, req.bbox_meters), self.orientation,
                    scope=req.scope)
            except (BindingError, RecordError):
                raise GenerationError("mesh_binding_rejected") from None
            finished = time.perf_counter()
            receipt = {"schemaVersion": 1, "objectId": req.object_id, "source": req.source,
                "scope": req.scope, "imageRef": req.image_ref, "imageSha256": req.image_sha256,
                "bboxMeters": req.bbox_meters, "rawSha256": hashlib.sha256(raw.glb).hexdigest(),
                "boundSha256": hashlib.sha256(bound.glb).hexdigest(), "bytes": len(bound.glb),
                "generatorRevision": raw.generator_revision, "providerRequestId": raw.request_id,
                "evidence": raw.evidence, "validation": bound.report, "scale": 1,
                "timings": {"providerSeconds": generated-started, "bindingSeconds": finished-generated}}
            self._artifact = PreparedArtifact(bound.glb, canonical(receipt))
            return self._artifact
        finally:
            self._lock.release()


class ArtifactSink(Protocol):
    def put(self, object_id: str, glb: bytes, sha256: str) -> str:
        """Return a stored R2 key only after verifying the delivered bytes."""
        ...


def deliver(artifact, sink, review):
    """Retry this function, NOT prepare/provider. Only immutable validated bytes cross here."""
    receipt = artifact.reviewed_receipt(review)
    expected = f"objects/{identifier(receipt['objectId'])}/mesh.glb"
    try:
        key = sink.put(receipt["objectId"], artifact.glb, receipt["boundSha256"])
    except Exception:
        raise GenerationError("artifact_delivery_failed_retry_same_bytes") from None
    check(key == expected, "unexpected_artifact_key")
    return {"glbKey": key, "artifact": receipt}


def worker_request(payload, image_bytes, *, scope, image_sha256, image_ref):
    """Map Thomas's CURRENT workflow body to Ani input after authorized image reading.

    source is absent from his payload: it must be supplied by his hydrated object,
    not guessed from a URL. upload_url is never stored or echoed in a receipt.
    """
    check(isinstance(payload, dict) and payload.get("tier") == "live", "only_live_tier_supported")
    check(set(payload) <= {"tier", "image_url", "bbox_meters", "object_id", "upload_url", "want_embedding", "source"},
          "unsupported_generation_field")
    return GenerationInput.from_object({"objectId": payload.get("object_id"), "source": payload.get("source"),
        "bboxMeters": payload.get("bbox_meters")}, image_bytes, image_sha256=image_sha256,
        image_ref=image_ref, scope=scope)
