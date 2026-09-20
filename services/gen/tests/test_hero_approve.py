"""approve.py with the labelled fake provider and an in-process fake Worker. No network, no paid call."""
from unittest.mock import Mock

import pytest

from test_hero_common import ORIGIN, OBJECT_ID, bound_env, sha
from app import generation as g
import hero_store as hs
import json

KEY = f"objects/{OBJECT_ID}/mesh.glb"
UPLOAD_SEQUENCE = [
    ("GET", f"/v1/objects/{OBJECT_ID}"),
    ("POST", "/v1/uploads"),
    ("PUT", f"/v1/uploads/{KEY}"),
    ("GET", f"/v1/assets/{KEY}"),
    ("POST", f"/v1/objects/{OBJECT_ID}/mesh"),
]


@pytest.fixture
def env(tmp_path):
    return bound_env(tmp_path)


@pytest.fixture
def spies(monkeypatch):
    binder = Mock(wraps=g.bind_selected)
    monkeypatch.setattr(g, "bind_selected", binder)
    return binder


def test_approve_refuses_a_hash_mismatch_before_any_request(env, capsys):
    assert env.approve(bound_sha256="0" * 64) == hs.EXIT_REFUSED
    assert env.worker.calls == []
    assert not (env.dir / "review-receipt.json").exists()
    assert "hash mismatch" in capsys.readouterr().err


def test_approve_refuses_before_bind(tmp_path, capsys):
    from test_hero_common import Env
    fresh = Env(tmp_path)
    assert fresh.generate() == 0
    fresh.worker.calls.clear()
    assert fresh.approve(bound_sha256="0" * 64) == hs.EXIT_REFUSED
    assert fresh.worker.calls == []
    assert "bind first" in capsys.readouterr().err


def test_approve_sends_exactly_these_requests_with_these_bodies(env):
    bound = (env.dir / "bound.glb").read_bytes()
    assert env.approve("--room-id", "room-9") == 0
    assert env.worker.paths() == UPLOAD_SEQUENCE
    bodies = [body for _, _, body in env.worker.calls]
    assert bodies[0] == b""
    assert json.loads(bodies[1]) == {"kind": "objectMesh", "ext": "glb", "objectId": OBJECT_ID}
    assert bodies[2] == bound  # THE saved bytes, not a re-derived mesh
    assert bodies[3] == b""
    assert json.loads(bodies[4]) == {"key": KEY, "roomId": "room-9"}
    assert env.worker.objects[OBJECT_ID]["state"] == "ready"
    attached = hs.read_json(env.dir / "attached.json")
    assert attached["glbKey"] == KEY and attached["roomId"] == "room-9"


def test_room_id_is_omitted_when_not_given(env):
    assert env.approve() == 0
    assert env.worker.mesh_bodies == [{"key": KEY}]


def test_the_review_receipt_is_kept_locally_for_synthetic_and_real_labels(env, tmp_path):
    assert env.approve() == 0
    kept = hs.read_json(env.dir / "review-receipt.json")["reviewedReceipt"]
    assert kept["visualReview"] == {"reviewer": "tester", "evidence": "synthetic_test",
                                    "boundSha256": kept["boundSha256"]}
    assert kept["boundSha256"] == sha((env.dir / "bound.glb").read_bytes())
    real = bound_env(tmp_path / "real", evidence="real_sf3d")  # LABEL only; nothing was generated for real
    assert real.approve() == 0
    review = hs.read_json(real.dir / "review-receipt.json")["reviewedReceipt"]
    assert review["evidence"] == "cached_real_sf3d"
    assert review["visualReview"]["evidence"] == "manual_review"


def test_retry_after_a_failed_upload_never_calls_the_provider_or_the_binder(env, spies):
    spies.reset_mock()
    env.worker.fail_put = 1
    assert env.approve() == hs.EXIT_UPSTREAM
    assert (env.dir / "review-receipt.json").exists() and not (env.dir / "attached.json").exists()
    env.worker.calls.clear()
    assert env.approve() == 0
    assert [p for p in env.worker.paths() if p[0] != "GET" or "assets" in p[1]] == UPLOAD_SEQUENCE[1:]
    assert env.worker.stored[KEY] == (env.dir / "bound.glb").read_bytes()
    assert len(env.provider.calls) == 1 and spies.call_count == 0


def test_retry_after_a_failed_attach_reuploads_the_same_bytes(env, spies):
    spies.reset_mock()
    env.worker.fail_mesh = 1
    assert env.approve() == hs.EXIT_UPSTREAM
    assert env.worker.objects[OBJECT_ID]["state"] == "measured"
    assert env.approve() == 0
    assert env.worker.objects[OBJECT_ID]["state"] == "ready"
    assert len(env.provider.calls) == 1 and spies.call_count == 0


def test_approving_again_after_success_is_safe(env, spies):
    spies.reset_mock()
    assert env.approve() == 0
    assert env.approve() == 0
    assert len(env.provider.calls) == 1 and spies.call_count == 0
    assert (env.dir / "bound.glb").read_bytes() == env.worker.stored[KEY]


def test_a_different_reviewer_cannot_silently_replace_the_recorded_review(env, capsys):
    assert env.approve() == 0
    env.worker.calls.clear()
    assert env.approve(reviewer="someone-else") == hs.EXIT_REFUSED
    assert env.worker.paths() == [("GET", f"/v1/objects/{OBJECT_ID}")]
    assert "already approved by tester" in capsys.readouterr().err


def test_a_box_that_moved_is_refused_before_any_upload(env):
    env.worker.objects[OBJECT_ID]["bboxMeters"] = {"w": 1.0, "h": 1.0, "d": 1.0}
    assert env.approve() == hs.EXIT_REFUSED
    assert env.worker.paths() == [("GET", f"/v1/objects/{OBJECT_ID}")]


def test_a_missing_object_is_refused_before_any_upload(env):
    env.worker.objects.clear()
    assert env.approve() == hs.EXIT_REFUSED
    assert env.worker.paths() == [("GET", f"/v1/objects/{OBJECT_ID}")]


def test_the_key_is_whatever_ani_s_sink_returned_and_is_never_rewritten(env, capsys):
    # The Worker before the P-WORKER change refuses objects/... keys. approve must report it, not rewrite the key.
    env.worker.scan_keys_only = True
    assert env.approve() == hs.EXIT_UPSTREAM
    assert env.worker.mesh_bodies == [{"key": KEY}]
    assert "400" in capsys.readouterr().err
    assert not (env.dir / "attached.json").exists()


def test_a_tampered_bound_file_is_refused(env):
    (env.dir / "bound.glb").write_bytes(b"tampered")
    digest = hs.read_json(env.dir / "bound-receipt.json")["boundSha256"]
    assert env.approve(bound_sha256=digest) == hs.EXIT_REFUSED  # the hash the reviewer saw no longer matches
    assert env.worker.calls == []


def test_worker_origin_is_required():
    import approve
    with pytest.raises(SystemExit) as exit_info:
        approve.main(["--attempt", "0" * 8, "--reviewer", "x", "--bound-sha256", "0" * 64])
    assert exit_info.value.code == 2
