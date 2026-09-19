"""Actual Paul HTTP/index/ranking + B04. Encoder/provider/storage explicitly fake."""
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from test_generation_adapter import FakeProvider, request, review, png, IDENTITY
from test_embedding_contract import FakeEncoder
from app.embedding.api import create_app as embed_app, ServiceTokenAuth, Principal
from app.embedding.images import ManifestImageReader
from app.embedding.records import make_record, index_payload
from app.embedding.search import SearchHandoff, paul_module
from app.main import create_app
from app.generation import GenerationAttempt, GenerationError, AmbiguousGeneration


def reader(tmp_path, *, principals=None):
    raw = png()
    path = tmp_path / "photo.png"
    path.write_bytes(raw)
    manifest = tmp_path / "images.json"
    manifest.write_text(json.dumps([{"imageKey": "queries/photo.png", "path": "photo.png",
        "sha256": hashlib.sha256(raw).hexdigest(),
        "principals": principals or ["trusted-local-search", "trusted-internal-service"]}]))
    return ManifestImageReader(manifest), path


def record(obj_id="product-B"):
    return make_record({"objectId": obj_id, "source": "catalog", "name": "SYNTHETIC test metadata",
        "bboxMeters": {"w": .61, "h": 1.07, "d": .49}, "state": "measured",
        "measure": {"method": "declared", "confidence": 0.}}, FakeEncoder().response(image=png()),
        expected_fingerprint=FakeEncoder.fingerprint, scope="test-session", image_ref="queries/photo.png",
        image_bytes=png())


def test_actual_paul_http_photo_and_text_queries_without_insertion(tmp_path, monkeypatch):
    images, _ = reader(tmp_path)
    monkeypatch.setenv("EMBEDDING_LOCAL_SEARCH", "1")
    monkeypatch.setenv("EMBEDDING_SEARCH_FINGERPRINT", FakeEncoder.fingerprint)
    monkeypatch.setenv("UPSTREAM_TOKEN", "synthetic-upstream-token")
    gen = embed_app(encoder=FakeEncoder(), image_reader=images)
    paul = paul_module("main")
    monkeypatch.setattr(paul_module("auth"), "_TOKEN", "synthetic-upstream-token")
    monkeypatch.setattr(paul, "INDEX", paul_module("index").BruteForceIndex())
    monkeypatch.setattr(paul, "EMBED_URL", "http://gen.local/embed/search")
    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.ASGITransport(app=gen, client=("127.0.0.1", 1234))))
    with TestClient(gen), TestClient(paul.app) as client:
        assert client.post("/index", json=[]).status_code == 401
        assert client.post("/search", json={"text": "chair"}).status_code == 401
        client.headers["X-Upstream-Token"] = "synthetic-upstream-token"
        indexed = client.post("/index", json=index_payload([record()],
            expected_fingerprint=FakeEncoder.fingerprint, scope="test-session"))
        assert indexed.json() == {"indexed": 1, "total": 1}
        for query in ({"text": "chair"}, {"imageKey": "queries/photo.png"}):
            response = client.post("/search", json={**query, "limit": 5})
            assert response.status_code == 200
            assert not any(h.lower().startswith("x-stub") for h in response.headers)
            assert "x-search-degraded" not in response.headers
            assert response.json()[0]["objectId"] == "product-B"
        assert len(paul.INDEX) == 1


@pytest.mark.parametrize("case", ["denied", "missing", "changed", "oversized"])
def test_image_reader_authorization_and_content_bounds(tmp_path, case):
    images, path = reader(tmp_path, principals=["allowed"])
    principal = Principal("denied" if case == "denied" else "allowed")
    key = "not-listed" if case == "missing" else "queries/photo.png"
    if case == "changed":
        path.write_bytes(png("blue"))
    with pytest.raises((PermissionError, OSError, ValueError)):
        asyncio.run(images.read_authorized(key, principal, 1 if case == "oversized" else 10000))


def test_thomas_embedding_auth_payload_alias_and_fingerprint(tmp_path, monkeypatch):
    images, _ = reader(tmp_path)
    app = embed_app(encoder=FakeEncoder(), authenticator=ServiceTokenAuth("test-only"), image_reader=images)
    with TestClient(app) as client:
        headers = {"authorization": "Api-Key test-only"}
        assert client.post("/embed", json={"text": "chair"}, headers=headers).status_code == 401
        monkeypatch.setenv("EMBEDDING_WORKER_COMPAT", "1")
        monkeypatch.setenv("EMBEDDING_SEARCH_FINGERPRINT", FakeEncoder.fingerprint)
        for body in ({"text": "chair", "image_key": None}, {"text": None, "image_key": "queries/photo.png"}):
            response = client.post("/embed", json=body, headers=headers)
            assert response.status_code == 200
            assert response.json()["embedding"] == response.json()["values"]
            assert response.json()["fingerprint"] == FakeEncoder.fingerprint
        assert client.post("/embed", json={"image_key": "queries/photo.png", "imageKey": "queries/photo.png"},
                           headers=headers).status_code == 422
        assert client.post("/embed", json={"text": "chair"}, headers={"authorization": "Api-Key wrong"}).status_code == 401
        monkeypatch.setenv("EMBEDDING_SEARCH_FINGERPRINT", "b" * 64)
        assert client.post("/embed", json={"text": "chair"}, headers=headers).status_code == 409


def test_selected_search_result_to_generation_http_and_fetchable_bytes():
    selected = SearchHandoff([record()], fingerprint=FakeEncoder.fingerprint, scope="test-session").query(
        FakeEncoder().response(text="chair"))[0]["object"]
    req = request("catalog", selected["objectId"], dimensions=selected["bboxMeters"])
    provider = FakeProvider()
    attempt = GenerationAttempt(req, provider, IDENTITY)
    def handler(payload, principal):
        assert payload["object_id"] == selected["objectId"]
        assert principal.subject == "trusted-internal-service"
        artifact = attempt.prepare()
        return artifact, review(artifact)
    app = create_app(encoder=FakeEncoder(), generation_handler=handler,
                     generation_auth=ServiceTokenAuth("test-only"))
    with TestClient(app) as client:
        for _ in range(2):
            result = client.post("/generate", json={"object_id": selected["objectId"]},
                                 headers={"authorization": "Api-Key test-only"})
            assert result.status_code == 200
            receipt = result.json()["artifact"]
            assert receipt["scale"] == 1 and receipt["bboxMeters"] == selected["bboxMeters"]
            glb = base64.b64decode(result.json()["glbBase64"])
            assert glb[:4] == b"glTF" and hashlib.sha256(glb).hexdigest() == receipt["boundSha256"]
        assert len(provider.calls) == 1
        assert client.post("/generate", json={}).status_code == 401
    # A fake asset transport proves renderer-format fetch, not an actual Worker deployment.
    with httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=glb,
            headers={"content-type": "model/gltf-binary"}))) as client:
        fetched = client.get("https://worker.invalid/v1/assets/objects/product-B/mesh.glb")
        assert fetched.content == attempt.prepare().glb


@pytest.mark.parametrize("kind,status", [("absent", 503), ("ambiguous", 409), ("invalid", 422), ("exception", 502)])
def test_generation_http_honest_failures(kind, status):
    handler = {"absent": None, "ambiguous": Mock(side_effect=AmbiguousGeneration("secret")),
               "invalid": Mock(side_effect=GenerationError("secret")),
               "exception": Mock(side_effect=RuntimeError("secret"))}[kind]
    with TestClient(create_app(encoder=FakeEncoder(), generation_handler=handler,
                              generation_auth=ServiceTokenAuth("test-only"))) as client:
        result = client.post("/generate", json={}, headers={"authorization": "Bearer test-only"})
        assert result.status_code == status and "secret" not in result.text
        if kind != "absent":
            assert result.json()["retryable"] is False


def test_actual_thomas_upload_and_asset_handlers_with_local_r2_kv():
    if not shutil.which("node"):
        pytest.skip("Node 24 required for current Worker source integration")
    ref = os.environ.get("ANI_WORKER_REF", "HEAD")
    repo = Path(__file__).resolve().parents[3]
    if subprocess.run(["git", "rev-parse", "--verify", ref], cwd=repo, capture_output=True).returncode:
        pytest.skip("Fetch the teammate branch to test its actual handlers")
    artifact = GenerationAttempt(request(), FakeProvider(), IDENTITY).prepare()
    result = subprocess.run(["node", "--experimental-vm-modules", str(Path(__file__).with_name("worker_handoff.mjs")), ref],
        cwd=repo, input=json.dumps({"objectId": "owned-A", **artifact.worker_result(review(artifact))}),
        text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["actualWorkerHandlers"] and evidence["fakeR2AndKV"]
    assert evidence["roundTrip"] == "PASS" and evidence["bytes"] == len(artifact.glb)
