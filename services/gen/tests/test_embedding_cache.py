"""Persistent cache behavior at the authenticated API boundary (fake encoder)."""
import base64
import json

from fastapi.testclient import TestClient
from test_embedding_contract import FakeEncoder, png
from app.embedding.api import create_app, ServiceTokenAuth
from app.embedding.cache import EmbeddingCache


class CountingEncoder(FakeEncoder):
    calls = 0

    def response(self, **kwargs):
        self.calls += 1
        return super().response(**kwargs)


def client(encoder, cache, **kwargs):
    return TestClient(create_app(encoder=encoder, result_cache=cache,
        authenticator=ServiceTokenAuth("test"), **kwargs),
        headers={"Authorization": "Bearer test"})


def test_normalized_text_hits_and_survives_restart(tmp_path):
    path = tmp_path / "cache.sqlite3"
    first = CountingEncoder()
    with client(first, EmbeddingCache(path)) as c:
        expected = c.post("/embed", json={"text": "  CHAIR  "}).json()
        assert c.post("/embed", json={"text": "chair"}).json() == expected
    second = CountingEncoder()
    with client(second, EmbeddingCache(path)) as c:
        assert c.post("/embed", json={"text": "chair"}).json() == expected
        assert c.post("/embed", json={"text": "desk"}).status_code == 200
    assert first.calls == second.calls == 1


def test_fingerprint_invalidates_cache(tmp_path):
    cache = EmbeddingCache(tmp_path / "cache.sqlite3")
    encoder = CountingEncoder()
    with client(encoder, cache) as c:
        assert c.post("/embed", json={"text": "chair"}).status_code == 200
        encoder.fingerprint = "b" * 64
        assert c.post("/embed", json={"text": "chair", "expectedFingerprint": "a" * 64}).status_code == 409
        assert c.post("/embed", json={"text": "chair"}).json()["fingerprint"] == "b" * 64
    assert encoder.calls == 2


def test_image_content_hits_but_storage_authorization_is_always_checked(tmp_path):
    class Reader:
        allowed = True
        async def read_authorized(self, *args):
            if not self.allowed:
                raise PermissionError()
            return png()
    reader, encoder = Reader(), CountingEncoder()
    with client(encoder, EmbeddingCache(tmp_path / "cache.sqlite3"), image_reader=reader) as c:
        assert c.post("/embed", json={"imageBase64": base64.b64encode(png()).decode()}).status_code == 200
        assert c.post("/embed", json={"imageKey": "objects/x/frames/0.png"}).status_code == 200
        reader.allowed = False
        assert c.post("/embed", json={"imageKey": "objects/x/frames/0.png"}).status_code == 403
        c.headers["Authorization"] = "Bearer wrong"
        assert c.post("/embed", json={"imageBase64": base64.b64encode(png()).decode()}).status_code == 401
    assert encoder.calls == 1


def test_corrupt_vector_recomputed_and_capacity_bounded(tmp_path):
    cache, encoder = EmbeddingCache(tmp_path / "cache.sqlite3", max_entries=1), CountingEncoder()
    with client(encoder, cache) as c:
        result = c.post("/embed", json={"text": "chair"}).json()
        result["values"] = [0.0] * 768
        with cache.connect() as db:
            db.execute("UPDATE embeddings SET result=?", (json.dumps(result),))
        assert c.post("/embed", json={"text": "chair"}).json()["values"][0] > 0
        assert c.post("/embed", json={"text": "desk"}).status_code == 200
        assert c.post("/embed", json={"text": "chair"}).status_code == 200
        with cache.connect() as db:
            assert db.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0] == 1
    assert encoder.calls == 4


def test_errors_not_cached_and_busy_is_retryable(tmp_path):
    cache, encoder = EmbeddingCache(tmp_path / "cache.sqlite3"), CountingEncoder()
    with client(encoder, cache) as c:
        assert c.post("/embed", json={"text": "   "}).status_code == 422
        assert c.post("/embed", json={"imageBase64": "YQ=="}).status_code == 422
        with cache.connect() as db:
            assert db.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0] == 0
        with cache.lock:
            result = c.post("/embed", json={"text": "chair"})
            assert result.status_code == 429
            assert result.headers["retry-after"] == "1"
        assert c.post("/embed", json={"text": "chair"}).status_code == 200
