"""B05 synthetic metadata/encoder fixtures; actual Paul's modules, no quality claim."""
import hashlib
from pathlib import Path
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.embedding.records import make_record, index_payload, canonical, RecordError
from app.embedding.search import SearchHandoff, paul_module
from app.embedding.api import create_app, ServiceTokenAuth

FP = "a" * 64
RAW = b"synthetic fixture bytes; encoder isolated in these record tests"


def embedding(axis=0):
    return {"values": [float(i == axis) for i in range(768)], "dimension": 768,
            "fingerprint": FP, "inputHash": hashlib.sha256(RAW).hexdigest(), "modality": "image"}


def metadata(identity="synthetic-A"):
    return {"objectId": identity, "name": "SYNTHETIC TEST ONLY", "source": "catalog",
            "state": "measured", "glbUrl": None, "category": "chair",
            "bboxMeters": {"w": .8, "h": 1.0, "d": .6},
            "measure": {"method": "declared", "confidence": .6},
            "price": {"cents": 10000, "currency": "CAD"},
            "productId": "synthetic-product", "variantId": "synthetic-variant",
            "provenance": {"dataset": "synthetic unit test"}}


def record(obj=None, vector=None):
    return make_record(metadata() if obj is None else obj, embedding() if vector is None else vector,
                       expected_fingerprint=FP, scope="test", image_ref="fixtures/synthetic.png", image_bytes=RAW)


def test_deterministic_lossless_snapshot():
    obj = metadata()
    r = record(obj)
    assert canonical(r) == canonical(record(dict(reversed(list(obj.items())))))
    for key, value in obj.items():
        assert r[key] == value
    obj["bboxMeters"]["w"] = 99
    assert r["bboxMeters"]["w"] == .8
    assert r["embeddingMeta"]["dimension"] == 768
    assert r["embeddingMeta"]["inputHash"] == hashlib.sha256(RAW).hexdigest()


@pytest.mark.parametrize("change", [
    {"fingerprint": "b"*64}, {"values": [1.]}, {"dimension": 767},
    {"values": [0.]*768}, {"values": [float("nan")]*768},
    {"inputHash": "b"*64}, {"modality": "text"}, {"values": [True]*768},
])
def test_invalid_embedding(change):
    with pytest.raises(RecordError):
        record(vector={**embedding(), **change})


@pytest.mark.parametrize("change", [
    {"bboxMeters": {"w": 0, "h": 1, "d": 1}}, {"bboxMeters": {"w": 1}},
    {"price": {"cents": 1.5, "currency": "CAD"}}, {"price": {"cents": 5}},
    {"measure": {"confidence": float("inf")}}, {"source": None},
    {"imageToken": "not-a-real-secret"}, {"productUrl": "https://example.invalid/?token=test"},
])
def test_invalid_metadata(change):
    with pytest.raises(RecordError):
        record({**metadata(), **change})


def test_unknown_stays_unknown_and_cannot_enter_incompatible_index():
    r = record({"source": "catalog", "bboxMeters": None, "price": None})
    assert "objectId" not in r and "measure" not in r and r["bboxMeters"] is None
    with pytest.raises(RecordError, match="objectId"):
        index_payload([r], expected_fingerprint=FP, scope="test")
    for key in ("bboxMeters", "measure"):
        obj = metadata(); del obj[key]
        with pytest.raises(RecordError):
            index_payload([record(obj)], expected_fingerprint=FP, scope="test")


@pytest.mark.parametrize("change", [{"price": {"cents": -1, "currency": "CAD"}},
    {"price": {"cents": 1, "currency": "cad"}}, {"source": "unknown"},
    {"productUrl": "https://example.invalid/?secret=value"}])
def test_reloaded_export_revalidates_metadata(change):
    with pytest.raises(RecordError):
        index_payload([{**record(), **change}], expected_fingerprint=FP, scope="test")


def test_actual_paul_index_route_accepts_measured_records(monkeypatch):
    monkeypatch.setenv("UPSTREAM_TOKEN", "synthetic-upstream-token")
    main = paul_module("main")
    monkeypatch.setattr(paul_module("auth"), "_TOKEN", "synthetic-upstream-token")
    monkeypatch.setattr(main, "INDEX", paul_module("index").BruteForceIndex())
    with TestClient(main.app) as client:
        payload = index_payload([record()], expected_fingerprint=FP, scope="test")
        assert client.post("/index", json=payload).status_code == 401
        client.headers["X-Upstream-Token"] = "synthetic-upstream-token"
        assert client.post("/index", json=payload).json() == {"indexed": 1, "total": 1}
        assert client.post("/index", json=payload).json()["total"] == 1
        row = client.post("/search", json={"fit": {"maxW": .8}}).json()[0]["object"]
        assert row["state"] == "measured" and row["glbUrl"] is None
        assert main.INDEX.get(row["objectId"]).w_mm == 800


def test_query_is_not_inserted_and_changes_real_paul_ranking():
    handoff = SearchHandoff([record(), record(metadata("synthetic-B"), embedding(1))], fingerprint=FP, scope="test")
    assert handoff.query(embedding())[0]["objectId"] == "synthetic-A"
    query = {**embedding(1), "modality": "text"}
    assert handoff.query(query)[0]["objectId"] == "synthetic-B"
    assert len(handoff.index) == 2
    with pytest.raises(RecordError, match="fingerprint"):
        handoff.query({**query, "fingerprint": "b"*64})


def test_strict_constraints_no_rounding_or_relaxation():
    handoff = SearchHandoff([record()], fingerprint=FP, scope="test")
    assert handoff.query(embedding(), fit={"maxW": .8}, budget={"cents": 10000, "currency": "CAD"})
    assert not handoff.query(embedding(), fit={"maxW": .7999})
    assert not handoff.query(embedding(), budget={"cents": 9999, "currency": "CAD"})
    assert not handoff.query(embedding(), budget={"cents": 10000, "currency": "USD"})
    assert not handoff.query(embedding(), source="scan")
    unknown = record({**metadata(), "price": None})
    other = SearchHandoff([unknown], fingerprint=FP, scope="test")
    assert not other.query(embedding(), budget={"cents": 99999, "currency": "CAD"})


def test_duplicate_and_scope_mismatch():
    for rows, scope in (([record(), record()], "test"), ([record()], "other")):
        with pytest.raises(RecordError):
            index_payload(rows, expected_fingerprint=FP, scope=scope)


def test_local_compat_only_and_canonical_auth_preserved(monkeypatch):
    class Encoder:
        fingerprint = FP
        def response(self, **kw):
            return {**embedding(), "modality": "text",
                    "inputHash": hashlib.sha256(kw["text"].encode("utf-8")).hexdigest()}
    app = create_app(encoder=Encoder(), authenticator=ServiceTokenAuth("test-only"))
    monkeypatch.setenv("EMBEDDING_LOCAL_SEARCH", "1")
    monkeypatch.setenv("EMBEDDING_SEARCH_FINGERPRINT", FP)
    with TestClient(app, client=("127.0.0.1", 1234)) as client:
        result = client.post("/embed/search", json={"text": "chair", "imageKey": None})
        assert result.status_code == 200 and result.json()["vector"] == embedding()["values"]
        assert client.post("/embed", json={"text": "chair"}).status_code == 401
        assert client.post("/embed/search", json={"text": "chair"},
                           headers={"X-Forwarded-For": "127.0.0.1"}).status_code == 403
        monkeypatch.setenv("EMBEDDING_SEARCH_FINGERPRINT", "b"*64)
        assert client.post("/embed/search", json={"text": "chair"}).status_code == 409
        monkeypatch.delenv("EMBEDDING_SEARCH_FINGERPRINT")
        assert client.post("/embed/search", json={"text": "chair"}).status_code == 503
    with TestClient(app, client=("192.0.2.1", 1234)) as client:
        assert client.post("/embed/search", json={"text": "chair"}).status_code == 403
    monkeypatch.delenv("EMBEDDING_LOCAL_SEARCH")
    with TestClient(app, client=("127.0.0.1", 1234)) as client:
        assert client.post("/embed/search", json={"text": "chair"}).status_code == 403
