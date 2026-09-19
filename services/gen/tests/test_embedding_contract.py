"""HTTP tests use a fake encoder. Tensor checks use torch, NOT a loaded model."""

import base64
import io
import math
from pathlib import Path
import sys

import pytest
from fastapi.testclient import TestClient
from PIL import Image
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.embedding.api import create_app, ServiceTokenAuth, Principal
from app.embedding.config import MAX_IMAGE_BYTES
from app.embedding.encoder import SiglipEncoder, EncoderBusy, EncoderInvariantError, normalize_features
from app.embedding.preprocess import decode_image, normalize_text, content_hash, InputError


def png():
    out = io.BytesIO()
    Image.new("RGB", (3, 5)).save(out, format="PNG")
    return out.getvalue()


class FakeEncoder:
    fingerprint = "a" * 64

    def response(self, *, image=None, text=None):
        if image is not None:
            decode_image(image)
            digest, modality = content_hash(image), "image"
        else:
            digest, modality = content_hash(normalize_text(text).encode()), "text"
        return {"values": [1 / math.sqrt(768)] * 768, "dimension": 768,
                "fingerprint": self.fingerprint, "inputHash": digest, "modality": modality}


@pytest.fixture
def client():
    with TestClient(create_app(encoder=FakeEncoder(), authenticator=ServiceTokenAuth("unit-test-only"))) as c:
        c.headers["Authorization"] = "Bearer unit-test-only"
        yield c


def test_inline_image_and_text_contract(client):
    for payload in ({"text": " chair "}, {"imageBase64": base64.b64encode(png()).decode()}):
        response = client.post("/embed", json=payload)
        assert response.status_code == 200
        result = response.json()
        assert set(result) == {"values", "dimension", "fingerprint", "inputHash", "modality"}
        assert len(result["values"]) == result["dimension"] == 768
        assert len(result["inputHash"]) == len(result["fingerprint"]) == 64
        assert abs(sum(v * v for v in result["values"]) - 1) < 1e-5
    assert client.get("/ready").json()["ready"] is True


@pytest.mark.parametrize("payload", [{}, {"text": ""}, {"text": "   "}, {"text": 123},
    {"text": ["chair"]}, {"text": "chair", "imageBase64": "YQ=="},
    {"text": "chair", "userId": "other-user"}, {"imageKey": "https://example.com/x"},
    {"imageKey": "objects/../secret"}, {"imageKey": "/etc/passwd"},
    {"imageKey": "objects/%2e%2e/secret"}, {"imageBase64": "@@"}, {"imageBase64": "YQ=="}])
def test_bad_inputs_fail_without_echo(client, payload):
    r = client.post("/embed", json=payload)
    assert r.status_code == 422
    assert set(r.json()) == {"detail"}


def test_auth_health_readiness_and_missing_cache(monkeypatch):
    monkeypatch.delenv("EMBEDDING_CACHE_DIR", raising=False)
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
    with TestClient(create_app()) as c:
        assert c.get("/health").status_code == 200
        assert c.get("/ready").status_code == 503
        assert c.post("/embed", json={"text": "chair"}).status_code == 503
    with TestClient(create_app(load_encoder=False, authenticator=ServiceTokenAuth("unit-test-only"))) as c:
        assert c.post("/embed", json={"text": "chair"}).status_code == 401
        assert c.post("/embed", json={"text": "chair"}, headers={"Authorization": "Bearer unit-test-only"}).status_code == 503


def test_body_limits_bad_json_and_fingerprint(client, monkeypatch):
    from app.embedding import api
    assert client.post("/embed", json={"text": "chair", "expectedFingerprint": "b" * 64}).status_code == 409
    assert client.post("/embed", json={"text": "chair", "expectedFingerprint": "a" * 64}).status_code == 200
    assert client.post("/embed", content=b"bad", headers={"content-type": "application/json"}).status_code == 422
    assert client.post("/embed", content=b"bad").status_code == 415
    monkeypatch.setattr(api, "MAX_BODY_BYTES", 8)
    assert client.post("/embed", content=b"123456789", headers={"content-type": "application/json"}).status_code == 413
    # Chunked input has no Content-Length and must still be bounded.
    assert client.post("/embed", content=iter([b"12345", b"67890"]), headers={"content-type": "application/json"}).status_code == 413


def test_storage_seam_receives_authenticated_scope_and_limit(client):
    assert client.post("/embed", json={"imageKey": "objects/x/photo.png"}).status_code == 503
    seen = []

    class Reader:
        async def read_authorized(self, key, principal, max_bytes):
            seen.append((key, principal, max_bytes))
            return png()

    with TestClient(create_app(encoder=FakeEncoder(), authenticator=ServiceTokenAuth("unit-test-only"), image_reader=Reader())) as c:
        result = c.post("/embed", json={"imageKey": "objects/x/photo.png"}, headers={"Authorization": "Bearer unit-test-only"})
        assert result.status_code == 200
    assert seen == [("objects/x/photo.png", Principal("trusted-internal-service"), MAX_IMAGE_BYTES)]


@pytest.mark.parametrize("error,status", [(PermissionError, 403), (FileNotFoundError, 404), (TimeoutError, 504), (OSError, 502)])
def test_storage_failures_are_typed(error, status):
    class Reader:
        async def read_authorized(self, *args):
            raise error("sensitive storage details")
    with TestClient(create_app(encoder=FakeEncoder(), authenticator=ServiceTokenAuth("unit-test-only"), image_reader=Reader())) as c:
        r = c.post("/embed", json={"imageKey": "objects/x/photo.png"}, headers={"Authorization": "Bearer unit-test-only"})
        assert r.status_code == status
        assert "sensitive" not in r.text


def test_bad_model_output_and_busy_are_not_success():
    class Broken(FakeEncoder):
        def response(self, **kwargs):
            return {**super().response(**kwargs), "values": [float("nan")] * 768}
    class Busy(FakeEncoder):
        def response(self, **kwargs):
            raise EncoderBusy()
    for encoder, expected in [(Broken(), 500), (Busy(), 429)]:
        with TestClient(create_app(encoder=encoder, authenticator=ServiceTokenAuth("unit-test-only"))) as c:
            assert c.post("/embed", json={"text": "chair"}, headers={"Authorization": "Bearer unit-test-only"}).status_code == expected


def test_tensor_normalization_and_batch_guards():
    result = normalize_features(torch.ones((2, 768), dtype=torch.float64), 2)
    assert result.shape == (2, 768) and str(result.dtype) == "float32"
    for tensor in (torch.zeros(1, 768), torch.full((1, 768), float("inf")),
                   torch.full((1, 768), float("nan")), torch.ones(1, 767)):
        with pytest.raises(EncoderInvariantError):
            normalize_features(tensor, 1)
    for value in ([], [b"x"] * 9, b"not-a-batch"):
        with pytest.raises(InputError):
            SiglipEncoder._check_batch(value)
