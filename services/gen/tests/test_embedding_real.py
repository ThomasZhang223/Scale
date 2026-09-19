"""Explicit real-model evidence. Cache-only: no download or fake encoder in this file."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import secrets
import sys
import time

import numpy as np
from PIL import Image
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.embedding.api import create_app, ServiceTokenAuth
from app.embedding.encoder import SiglipEncoder
from app.embedding.config import REVISION
from app.embedding.preprocess import decode_image

pytestmark = pytest.mark.skipif(os.environ.get("ANI_EMBEDDING_REAL") != "1",
                               reason="Real checkpoint test is opt-in; set ANI_EMBEDDING_REAL=1")


@pytest.fixture(scope="module")
def real_run():
    for name in ("EMBEDDING_CACHE_DIR", "EMBEDDING_TEST_IMAGE", "EMBEDDING_TEST_REPORT"):
        if not os.environ.get(name):
            pytest.fail(f"Real test requires {name}; no download or mock fallback")
    destination = Path(os.environ["EMBEDDING_TEST_REPORT"]).resolve()
    repo = Path(__file__).resolve().parents[3]
    if destination.is_relative_to(repo) or destination.exists():
        pytest.fail("Use a new report path outside the repository")
    encoder = SiglipEncoder(os.environ["EMBEDDING_CACHE_DIR"])
    report = {"real_model_loaded": True, "model_load_seconds": encoder.load_seconds,
              "fingerprint": encoder.fingerprint, "provenance": encoder.provenance,
              "host": {"platform": platform.platform(), "processor": platform.processor(),
                       "logical_cpus": os.cpu_count()},
              "measurement": "CPU float32; 4 torch threads; one resident model; sequential; cached weights; no warmup before first call; per-call local wall clock, not network latency",
              "results": {}}
    yield encoder, report
    report["complete"] = set(report["results"]) == {"image", "text"}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"Real-model report: {destination}")


def measured(call):
    started = time.perf_counter()
    values = call()
    return values, time.perf_counter() - started


def assert_vector(values):
    assert values.shape == (1, 768)
    assert values.dtype == np.float32
    assert np.isfinite(values).all()
    np.testing.assert_allclose(np.linalg.norm(values, axis=1), [1.0], atol=1e-5, rtol=0)


def real_http(encoder, payload, expected):
    # Ephemeral internal-service credential: never saved in the report or repository.
    token = secrets.token_urlsafe(32)
    with TestClient(create_app(encoder=encoder, authenticator=ServiceTokenAuth(token))) as client:
        start = time.perf_counter()
        response = client.post("/embed", json=payload, headers={"Authorization": "Bearer " + token})
        elapsed = time.perf_counter() - start
        assert response.status_code == 200
        data = response.json()
        np.testing.assert_allclose(data["values"], expected[0], atol=1e-6, rtol=0)
        assert data["fingerprint"] == encoder.fingerprint
        assert client.get("/ready").status_code == 200
        return elapsed, data["inputHash"]


def test_real_image_and_http(real_run):
    encoder, report = real_run
    transparent = io.BytesIO()
    Image.new("RGBA", (32, 16), (0, 0, 0, 0)).save(transparent, format="PNG")
    pixels = encoder.image_processor(images=decode_image(transparent.getvalue()), return_tensors="pt")["pixel_values"]
    assert tuple(pixels.shape) == (1, 3, 224, 224)
    assert (pixels == 1).all()  # White composite -> 1/255 rescale -> .5/.5 normalization.
    path = Path(os.environ["EMBEDDING_TEST_IMAGE"])
    raw = path.read_bytes()
    first, first_s = measured(lambda: encoder.embed_images([raw]))
    repeat, repeat_s = measured(lambda: encoder.embed_images([raw]))
    assert_vector(first)
    assert_vector(repeat)
    np.testing.assert_allclose(first, repeat, atol=1e-6, rtol=0)
    synthetic = io.BytesIO()
    Image.new("RGB", (224, 224), (255, 0, 0)).save(synthetic, format="PNG")
    different, _ = measured(lambda: encoder.embed_images([synthetic.getvalue()]))
    assert_vector(different)
    difference = float(np.max(np.abs(first - different)))
    assert difference > 1e-3
    http_s, input_hash = real_http(encoder, {"imageBase64": base64.b64encode(raw).decode()}, first)
    assert input_hash == hashlib.sha256(raw).hexdigest()
    report["results"]["image"] = {
        "shape": list(first.shape), "finite": True, "norm": float(np.linalg.norm(first)),
        "first_seconds": first_s, "repeat_seconds": repeat_s, "in_process_http_seconds": http_s,
        "repeat_max_abs_error": float(np.max(np.abs(first - repeat))),
        "different_input_max_abs_difference": difference,
        "different_input": "synthetic solid red PNG; inequality check only, not retrieval evaluation",
        "input_path": str(path), "input_sha256": input_hash,
        "float32_vector_sha256": hashlib.sha256(first.tobytes()).hexdigest(),
    }


def test_real_text_tokenization_and_http(real_run):
    encoder, report = real_run
    assert encoder.provenance["revision"] == REVISION
    assert encoder.provenance["model_class"] == "SiglipModel"
    assert encoder.provenance["tokenizer_class"] == "GemmaTokenizerFast"
    assert not encoder.model.training
    tokens = encoder.tokenize([" Chair ", "chair", "wooden " * 400])
    ids = tokens["input_ids"]
    assert set(tokens.keys()) == {"input_ids"}
    assert tuple(ids.shape) == (3, 64)
    assert (ids[0] == ids[1]).all()
    for row in range(3):
        # This checkpoint exposes only input_ids as model inputs. Inspect the
        # fast tokenizer's encoding metadata, not an invented attention_mask field.
        length = sum(tokens.encodings[row].attention_mask)
        assert ids[row, 0] != encoder.tokenizer.bos_token_id
        assert ids[row, length - 1] == encoder.tokenizer.eos_token_id
        assert (ids[row, length:] == encoder.tokenizer.pad_token_id).all()
    text = "a wooden chair"
    first, first_s = measured(lambda: encoder.embed_texts([text]))
    repeat, repeat_s = measured(lambda: encoder.embed_texts([text]))
    different, _ = measured(lambda: encoder.embed_texts(["a red sports car"]))
    for values in (first, repeat, different):
        assert_vector(values)
    np.testing.assert_allclose(first, repeat, atol=1e-6, rtol=0)
    difference = float(np.max(np.abs(first - different)))
    assert difference > 1e-3
    http_s, input_hash = real_http(encoder, {"text": "  A WOODEN CHAIR  "}, first)
    assert input_hash == hashlib.sha256(text.encode()).hexdigest()
    report["results"]["text"] = {
        "shape": list(first.shape), "finite": True, "norm": float(np.linalg.norm(first)),
        "first_seconds": first_s, "repeat_seconds": repeat_s, "in_process_http_seconds": http_s,
        "repeat_max_abs_error": float(np.max(np.abs(first - repeat))),
        "different_input_max_abs_difference": difference, "input_text": text,
        "input_sha256": input_hash, "float32_vector_sha256": hashlib.sha256(first.tobytes()).hexdigest(),
        "token_shape": list(ids.shape), "right_padding_eos_no_bos": "passed",
        "tokenizer_model_inputs": list(tokens.keys()),
        "long_text_truncated_to_64": True,
    }
