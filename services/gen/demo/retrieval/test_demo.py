"""Demo-only regression checks; these unit tests do not load model weights."""
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import threading

import numpy as np
import pytest
from fastapi.testclient import TestClient

from server import DIMENSION, Retrieval, create_app, load_catalog, load_matrix


class Encoder:
    def __init__(self):
        self.image_calls = 0

    def embed_images(self, images):
        self.image_calls += 1
        return np.eye(len(images), DIMENSION, dtype=np.float32)

    def embed_texts(self, texts):
        return np.eye(1, DIMENSION, dtype=np.float32)


@pytest.mark.parametrize("change", [None, "fingerprint", "manifestSha256", "imageSha256", "corrupt"])
def test_cache_requires_all_hashes_and_valid_vectors(tmp_path, change):
    image = tmp_path / "image.jpg"
    image.write_bytes(b"unit-test-only")
    signature = {"fingerprint": "model", "manifestSha256": "manifest",
                 "imageSha256": [hashlib.sha256(image.read_bytes()).hexdigest()]}
    old = dict(signature)
    if change in signature:
        old[change] = "different"
    (tmp_path / "image-cache.json").write_text(json.dumps({"signature": old}))
    matrix = np.eye(1, DIMENSION, dtype=np.float32)
    if change == "corrupt":
        matrix[0, 0] = float("nan")
    np.save(tmp_path / "image-vectors.npy", matrix)
    encoder = Encoder()
    actual, reused = load_matrix(encoder, [image], signature, tmp_path)
    assert reused == (change is None)
    assert encoder.image_calls == (0 if change is None else 1)
    assert np.isfinite(actual).all()


def test_ranking_ignores_metadata_and_photo_never_inserts():
    retrieval = Retrieval.__new__(Retrieval)
    retrieval.encoder, retrieval.lock = Encoder(), threading.Lock()
    retrieval.matrix = np.eye(3, DIMENSION, dtype=np.float32)[::-1].copy()
    retrieval.products = [{"title": title} for title in ["perfect keyword match", "x", "unrelated"]]
    before = retrieval.matrix.copy()
    text = retrieval.search(text="perfect keyword match")
    assert [row["id"] for row in text["results"]] == [2, 0, 1]
    retrieval.products[0]["title"] = "changed metadata"
    photo = retrieval.search(photo=b"unit-test-only")
    assert [row["id"] for row in photo["results"]] == [2, 0, 1]
    np.testing.assert_array_equal(retrieval.matrix, before)
    assert len(retrieval.products) == 3
    retrieval.matrix = -np.ones((3, DIMENSION), dtype=np.float32) / np.sqrt(DIMENSION)
    assert retrieval.search(text="anything")["weakMatch"] is True
    retrieval.matrix[:] = 0
    assert retrieval.search(text="anything")["weakMatch"] is True


def test_catalog_rejects_escape(tmp_path):
    directory = tmp_path / "catalog"
    directory.mkdir()
    (tmp_path / "outside.jpg").write_bytes(b"test")
    manifest = directory / "manifest.json"
    manifest.write_text(json.dumps({"count": 1, "products": [
        {"r2Key": "../outside.jpg", "source": "catalog"}]}))
    with pytest.raises(ValueError, match="unsafe"):
        load_catalog(manifest)


def test_http_validation_and_image_allowlist(tmp_path):
    from app.embedding.preprocess import decode_image, normalize_text
    from PIL import Image
    image = tmp_path / "source.jpg"
    Image.new("RGB", (2, 2)).save(image, format="PNG")

    def search(**kwargs):
        if "photo" in kwargs:
            decode_image(kwargs["photo"])
        else:
            normalize_text(kwargs["text"])
        return {"ok": True}

    client = TestClient(create_app(SimpleNamespace(paths=[image], info={}, search=search)))
    assert client.get("/images/0").headers["content-type"] == "image/png"
    assert client.get("/images/-1").status_code == 404
    assert client.get("/images/1").status_code == 404
    assert client.get("/server.py").status_code == 404
    assert client.get("/", headers={"Host": "evil.example"}).status_code == 403
    assert client.post("/api/search/text", json={"text": "chair"},
                       headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/search/text", json={"text": "chair"}).status_code == 200
    for payload in [{"text": " "}, {"text": 1}, [], {"text": "x", "extra": 1}]:
        assert client.post("/api/search/text", json=payload).status_code == 422
    assert client.post("/api/search/photo", content=b"not an image").status_code == 422
    assert client.post("/api/search/photo", content=image.read_bytes()).status_code == 200
    assert client.post("/api/search/photo", content=b"x" * (10 * 1024 * 1024 + 1)).status_code == 413
