"""HTTP-level tests for POST /search. Run: python3 tests/test_api.py

Exercises the wire contract from .claude/contracts.md, not just the ranking functions — the
last two bugs in this project's other service were both in the entrypoint rather than the
logic behind it.
"""

import os, sys, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

# app.auth refuses to import without this — an auth check that silently passes when
# unconfigured is worse than no auth, so it fails at startup rather than at request time.
# Must be set before `app` is imported.
TOKEN = "test-upstream-token"
os.environ.setdefault("UPSTREAM_TOKEN", TOKEN)
TOKEN = os.environ["UPSTREAM_TOKEN"]

from fastapi.testclient import TestClient

from app import main
from app.index import BruteForceIndex, candidate_from_object_v1

client = TestClient(main.app, headers={"X-Upstream-Token": TOKEN})

OAK, WHITE = "#b5834a", "#f5f5f0"


def obj(oid, w, h, d, palette=None, source="catalog", conf=0.9, vector=None):
    o = {
        "schemaVersion": 1, "objectId": oid, "source": source, "state": "ready",
        "name": oid, "category": "shelf",
        "bboxMeters": {"w": w, "h": h, "d": d},
        "measure": {"method": "extracted", "confidence": conf},
        "palette": palette or [],
    }
    if vector is not None:
        o["vector"] = vector
    return o


def load(objects):
    main.INDEX = BruteForceIndex()
    r = client.post("/index", json={"objects": objects})
    assert r.status_code == 200, r.text
    return r.json()


def test_index_then_search_round_trip():
    assert load([obj("a", 0.6, 1.8, 0.3)]) == {"indexed": 1, "total": 1}
    r = client.post("/search", json={"limit": 5})
    assert r.status_code == 200
    assert [x["objectId"] for x in r.json()] == ["a"]


def test_response_shape_matches_the_contract():
    load([obj("a", 0.6, 1.8, 0.3)])
    row = client.post("/search", json={}).json()[0]
    assert set(row) >= {"objectId", "score", "object"}, row
    assert isinstance(row["score"], float)
    assert row["object"]["objectId"] == "a"


def test_fit_filter_excludes_what_does_not_fit():
    load([obj("narrow", 0.6, 1.8, 0.3), obj("wide", 1.2, 1.8, 0.3)])
    ids = [x["objectId"] for x in client.post(
        "/search", json={"fit": {"maxW": 0.8}}).json()]
    assert ids == ["narrow"], ids


def test_relaxation_is_announced_in_a_header():
    load([obj("just-over", 0.85, 1.8, 0.3)])
    r = client.post("/search", json={"fit": {"maxW": 0.8}})
    assert r.headers.get("X-Fit-Relaxed") == "1"
    assert r.json()[0]["relaxed"] is True


def test_a_satisfiable_filter_sets_no_relaxed_header():
    load([obj("fits", 0.6, 1.8, 0.3)])
    r = client.post("/search", json={"fit": {"maxW": 0.8}})
    assert "X-Fit-Relaxed" not in r.headers


def test_unit_mistake_in_the_fit_filter_is_a_422():
    load([obj("a", 0.6, 1.8, 0.3)])
    r = client.post("/search", json={"fit": {"maxW": 80}})
    assert r.status_code == 422 and r.json()["error"] == "bad_fit"


def test_missing_embedder_degrades_and_says_so():
    load([obj("a", 0.6, 1.8, 0.3, palette=[OAK])])
    r = client.post("/search", json={"text": "narrow oak bookshelf"})
    assert r.status_code == 200
    assert r.headers.get("X-Search-Degraded") == "no-embedder"
    assert r.json(), "a degraded search must still return results"


def test_degraded_codes_are_header_safe():
    """HTTP headers are latin-1. Prose with an em dash here returns a 500 instead of results."""
    load([obj("a", 0.6, 1.8, 0.3, palette=[OAK])])
    for body in ({"text": "oak"}, {"imageKey": "objects/x/frames/0.jpg"}):
        r = client.post("/search", json=body)
        assert r.status_code == 200, r.text
        code = r.headers.get("X-Search-Degraded", "")
        code.encode("latin-1")  # raises if a non-latin-1 character ever creeps back in
        assert " " not in code, f"header value must be a token, got {code!r}"


def test_the_pitch_query_end_to_end():
    """"find something that fits the 80 cm gap beside my desk and matches its wood tone\""""
    load([
        obj("oak-narrow", 0.75, 1.8, 0.3, palette=[OAK]),      # fits + right tone
        obj("white-narrow", 0.75, 1.8, 0.3, palette=[WHITE]),  # fits, wrong tone
        obj("oak-wide", 1.10, 1.8, 0.3, palette=[OAK]),        # right tone, does NOT fit
    ])
    ids = [x["objectId"] for x in client.post("/search", json={
        "fit": {"maxW": 0.8}, "palette": [OAK], "limit": 5,
    }).json()]
    assert "oak-wide" not in ids, "a perfect tone match that does not fit must be excluded"
    assert ids[0] == "oak-narrow", ids


def test_like_object_id_takes_the_tone_from_the_room():
    load([
        obj("my-desk", 1.2, 0.75, 0.6, palette=[OAK], source="scan"),
        obj("oak-shelf", 0.7, 1.8, 0.3, palette=[OAK]),
        obj("white-shelf", 0.7, 1.8, 0.3, palette=[WHITE]),
    ])
    ids = [x["objectId"] for x in client.post("/search", json={
        "fit": {"maxW": 0.8}, "likeObjectId": "my-desk", "source": "catalog",
    }).json()]
    assert ids[0] == "oak-shelf", ids


def test_source_filter_searches_only_your_own_possessions():
    load([obj("mine", 0.7, 1.8, 0.3, source="scan"), obj("shop", 0.7, 1.8, 0.3)])
    ids = [x["objectId"] for x in client.post("/search", json={"source": "scan"}).json()]
    assert ids == ["mine"]


def test_an_object_without_dimensions_is_refused_not_ranked():
    main.INDEX = BruteForceIndex()
    bad = obj("no-dims", 0.6, 1.8, 0.3)
    del bad["bboxMeters"]
    r = client.post("/index", json={"objects": [bad]})
    assert r.status_code == 422 and r.json()["error"] == "unrankable_object"


def test_partial_dimensions_are_refused_too():
    main.INDEX = BruteForceIndex()
    bad = obj("partial", 0.6, 1.8, 0.3)
    bad["bboxMeters"]["h"] = None
    r = client.post("/index", json={"objects": [bad]})
    assert r.status_code == 422, r.text


def test_metres_to_millimetre_rounding_is_exact():
    load([obj("a", 0.3126, 0.0155, 0.2212)])
    c = main.INDEX.get("a")
    assert (c.w_mm, c.h_mm, c.d_mm) == (313, 16, 221)


def test_search_without_the_token_is_401():
    """The service sits behind a public quick-tunnel URL, so this header is the only thing
    between the open internet and it."""
    load([obj("a", 0.6, 1.8, 0.3)])
    bare = TestClient(main.app)
    assert bare.post("/search", json={}).status_code == 401
    assert bare.post("/index", json={"objects": []}).status_code == 401


def test_a_wrong_token_is_401():
    load([obj("a", 0.6, 1.8, 0.3)])
    wrong = TestClient(main.app, headers={"X-Upstream-Token": "nope"})
    assert wrong.post("/search", json={}).status_code == 401


def test_health_needs_no_token():
    """Liveness has to answer before anyone has configured a secret."""
    assert TestClient(main.app).get("/health").status_code == 200


def test_health_reports_index_size():
    load([obj("a", 0.6, 1.8, 0.3), obj("b", 0.6, 1.8, 0.3)])
    assert client.get("/health").json() == {"ok": True, "indexed": 2, "embedder": False}


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"PASS {name}")
            except Exception as e:
                print(f"FAIL {name}: {type(e).__name__}: {e}"); fails += 1
    print(f"\n{fails} failed")
    sys.exit(1 if fails else 0)
