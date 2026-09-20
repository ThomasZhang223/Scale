"""prepare.py with the labelled fake provider. No network, no paid call, no Baseten host."""
import json
from unittest.mock import Mock

import pytest

from test_hero_common import (BOX, ORIGIN, OBJECT_ID, SCOPE, Env, FakeProvider, png, sha)
from app import generation as g
import hero_store as hs
import prepare

RECONCILE = "outcome unknown - reconcile by hand, do not resubmit"


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


@pytest.fixture
def binder(monkeypatch):
    spy = Mock(wraps=g.bind_selected)
    monkeypatch.setattr(g, "bind_selected", spy)
    return spy


# ---- generate -------------------------------------------------------------------------------

def test_generate_records_before_the_call_saves_raw_and_never_repeats(env, capsys):
    assert env.generate() == 0
    assert env.provider.state_seen_during_call == ["in_flight"]  # committed before the provider ran
    assert len(env.provider.calls) == 1
    raw = (env.dir / "raw.glb").read_bytes()
    assert raw == env.provider.glb
    sidecar = hs.read_json(env.dir / "attempt.json")
    assert sidecar["objectId"] == OBJECT_ID and sidecar["imageSha256"] == sha(png())
    assert sidecar["bboxMeters"] == BOX and sidecar["rawSha256"] == sha(raw)
    assert sidecar["evidence"] == "fake_provider" and sidecar["providerRequestId"] == "req-fake-1"
    assert sidecar["generatorRevision"] == "synthetic-fixture-v1"
    assert sidecar["timings"]["providerSeconds"] >= 0 and sidecar["imageRef"].endswith("chair.png")
    assert env.rows() == [("raw_ok",)]
    assert env.worker.paths() == [("GET", f"/v1/objects/{OBJECT_ID}")]

    capsys.readouterr()
    assert env.generate() == 0  # second invocation for the same attempt
    assert len(env.provider.calls) == 1
    assert "No provider call was made" in capsys.readouterr().out


def test_attempt_key_is_ani_raw_key_of_scope_and_image():
    assert prepare.attempt_key("a", sha(png())) != prepare.attempt_key("b", sha(png()))
    assert prepare.attempt_key("a", sha(png())) != prepare.attempt_key("a", sha(png("blue")))
    assert prepare.attempt_key("a", sha(png())) == prepare.attempt_key("a", sha(png()))


def test_in_flight_without_a_result_refuses_to_resubmit(env, capsys):
    env.store.mkdir()
    journal = hs.Journal(env.store)
    assert journal.begin(env.key, OBJECT_ID, sha(png()))
    journal.close()
    assert env.generate() == hs.EXIT_RECONCILE
    assert RECONCILE in capsys.readouterr().err
    assert env.provider.calls == []
    assert env.rows() == [("in_flight",)]


def test_begin_is_a_race_guard(tmp_path):
    journal = hs.Journal(tmp_path)
    assert journal.begin("k" * 64, "o", "d" * 64) is True
    assert journal.begin("k" * 64, "o", "d" * 64) is False  # the loser must not reach the network


def test_losing_the_insert_race_never_reaches_the_provider(env, capsys):
    def factory():
        # Another process records the same attempt between our lookup and our insert.
        other = hs.Journal(env.store)
        assert other.begin(env.key, OBJECT_ID, sha(png()))
        other.close()
        return env.provider
    code = prepare.main(["generate", *env.base(), "--object-id", OBJECT_ID, "--scope", SCOPE,
                         "--image", str(env.image)], client=env.worker.client(), provider_factory=factory)
    assert code == hs.EXIT_RECONCILE and env.provider.calls == []
    assert RECONCILE in capsys.readouterr().err


def test_timeout_is_recorded_ambiguous_and_never_resubmitted(env, capsys):
    provider = Mock()
    provider.generate.side_effect = TimeoutError("SECRET")
    assert env.generate(provider=provider) == hs.EXIT_RECONCILE
    assert env.rows() == [("ambiguous",)]
    assert env.generate(provider=provider) == hs.EXIT_RECONCILE
    assert provider.generate.call_count == 1
    err = capsys.readouterr().err
    assert RECONCILE in err and "SECRET" not in err


def test_provider_failure_is_recorded_and_never_retried(env, capsys):
    provider = Mock()
    provider.generate.side_effect = g.GenerationError("provider_response_rejected")
    assert env.generate(provider=provider) == hs.EXIT_PROVIDER
    assert env.rows() == [("rejected",)]
    assert env.generate(provider=provider) == hs.EXIT_RECONCILE
    assert provider.generate.call_count == 1
    assert RECONCILE in capsys.readouterr().err


def test_a_wrong_answer_is_rejected_and_the_paid_bytes_are_kept(env):
    provider = FakeProvider()
    provider.generate = lambda image, digest: g.RawGeneration(provider.glb, "f" * 64, "rev", "fake_provider")
    assert env.generate(provider=provider) == hs.EXIT_PROVIDER
    assert (env.dir / "raw.rejected.glb").read_bytes() == provider.glb
    assert not (env.dir / "raw.glb").exists() and env.rows() == [("rejected",)]


@pytest.mark.parametrize("row", [None, {"objectId": OBJECT_ID, "source": "catalog"},
                                 {"objectId": OBJECT_ID, "source": "catalog", "bboxMeters": None}])
def test_missing_row_or_box_is_refused_without_a_default(env, row, capsys):
    if row is None:
        env.worker.objects.clear()
    else:
        env.worker.objects[OBJECT_ID] = row
    assert env.generate() == hs.EXIT_REFUSED
    assert env.provider.calls == []
    assert not (env.store / "journal.sqlite3").exists()  # refused before anything was recorded
    assert "error:" in capsys.readouterr().err


@pytest.mark.parametrize("missing", ["w", "h", "d"])
def test_a_box_missing_one_dimension_is_refused(env, missing):
    env.worker.objects[OBJECT_ID]["bboxMeters"] = {k: v for k, v in BOX.items() if k != missing}
    assert env.generate() == hs.EXIT_REFUSED
    assert env.provider.calls == [] and env.rows() == []


def test_default_provider_refuses_without_allow_paid(env, monkeypatch, capsys):
    monkeypatch.setenv("BASETEN_PREDICT_URL", "https://model-x.api.baseten.co/production/predict")
    monkeypatch.setenv("BASETEN_API_KEY", "SECRET-TOKEN-VALUE")
    code = prepare.main(["generate", *env.base(), "--object-id", OBJECT_ID, "--scope", SCOPE,
                         "--image", str(env.image)], client=env.worker.client())
    assert code == hs.EXIT_REFUSED and env.rows() == []
    err = capsys.readouterr().err
    assert "--allow-paid" in err and "SECRET-TOKEN-VALUE" not in err and "baseten" not in err


@pytest.mark.parametrize("unset", ["BASETEN_PREDICT_URL", "BASETEN_API_KEY"])
def test_default_provider_names_the_missing_variable(env, monkeypatch, capsys, unset):
    # Never both variables set: that would build the real provider. One is always missing here.
    monkeypatch.delenv("BASETEN_PREDICT_URL", raising=False)
    monkeypatch.delenv("BASETEN_API_KEY", raising=False)
    other = "BASETEN_API_KEY" if unset == "BASETEN_PREDICT_URL" else "BASETEN_PREDICT_URL"
    monkeypatch.setenv(other, "SECRET-TOKEN-VALUE")
    code = prepare.main(["generate", *env.base(), "--object-id", OBJECT_ID, "--scope", SCOPE,
                         "--image", str(env.image), "--allow-paid"], client=env.worker.client())
    assert code == hs.EXIT_REFUSED and env.rows() == []
    err = capsys.readouterr().err
    assert unset in err and "SECRET-TOKEN-VALUE" not in err


@pytest.mark.parametrize("allow_paid, code", [(False, "paid_generation_not_enabled"), (True, "invalid_provider_endpoint")])
def test_errors_raised_before_any_connection_do_not_leave_in_flight(env, allow_paid, code, capsys):
    # example.invalid is not a baseten.co host, and SF3DProvider validates before opening a client.
    provider = prepare.SF3DProvider("https://example.invalid/predict", "tok", allow_paid=allow_paid)
    assert env.generate(provider=provider) == hs.EXIT_REFUSED
    assert env.rows() == []
    assert code in capsys.readouterr().err


def test_image_from_a_worker_asset_url(env):
    env.worker.stored["objects/hero-1/frames/0.png"] = png()
    url = f"{ORIGIN}/v1/assets/objects/hero-1/frames/0.png"
    assert env.generate(image=url) == 0
    assert env.worker.paths() == [("GET", f"/v1/objects/{OBJECT_ID}"), ("GET", "/v1/assets/objects/hero-1/frames/0.png")]
    assert hs.read_json(env.dir / "attempt.json")["imageRef"] == "objects/hero-1/frames/0.png"


@pytest.mark.parametrize("url", ["https://evil.invalid/v1/assets/x.png", f"{ORIGIN}/v1/assets/x.png?sig=abc",
                                 f"{ORIGIN}/v1/uploads/x.png", "http://worker.invalid/v1/assets/x.png"])
def test_image_url_outside_the_worker_assets_is_refused(env, url):
    assert env.generate(image=url) == hs.EXIT_REFUSED
    assert env.provider.calls == [] and env.rows() == []


def test_the_same_image_for_another_object_is_refused(env, capsys):
    assert env.generate() == 0
    env.worker.objects["other"] = {**env.worker.objects[OBJECT_ID], "objectId": "other"}
    code = prepare.main(["generate", *env.base(), "--object-id", "other", "--scope", SCOPE,
                         "--image", str(env.image)], client=env.worker.client(),
                        provider_factory=lambda: env.provider)
    assert code == hs.EXIT_REFUSED and len(env.provider.calls) == 1
    assert "belongs to object hero-1" in capsys.readouterr().err


def test_a_store_inside_the_repository_is_refused(env, capsys):
    code = prepare.main(["generate", "--worker-origin", ORIGIN, "--store", str(hs.REPO_ROOT / ".hero"),
                         "--object-id", OBJECT_ID, "--scope", SCOPE, "--image", str(env.image)],
                        client=env.worker.client(), provider_factory=lambda: env.provider)
    assert code == hs.EXIT_REFUSED and not (hs.REPO_ROOT / ".hero").exists()
    assert "outside the repository" in capsys.readouterr().err


def test_worker_origin_is_required_and_must_be_https(env):
    with pytest.raises(SystemExit) as exit_info:
        prepare.main(["generate", "--store", str(env.store), "--object-id", OBJECT_ID, "--scope", SCOPE,
                      "--image", str(env.image)])
    assert exit_info.value.code == 2
    code = prepare.main(["generate", "--worker-origin", "http://worker.invalid", "--store", str(env.store),
                         "--object-id", OBJECT_ID, "--scope", SCOPE, "--image", str(env.image)],
                        client=env.worker.client(), provider_factory=lambda: env.provider)
    assert code == hs.EXIT_REFUSED and env.provider.calls == []


# ---- bind -----------------------------------------------------------------------------------

@pytest.mark.parametrize("omit", ["--up", "--front", "--reviewer"])
def test_bind_refuses_without_a_stated_orientation(env, omit):
    assert env.generate() == 0
    argv = ["bind", *env.base(), "--attempt", env.key, "--reviewer", "tester", "--up", "Y+", "--front", "Z-"]
    index = argv.index(omit)
    del argv[index:index + 2]
    with pytest.raises(SystemExit) as exit_info:
        prepare.main(argv, client=env.worker.client())
    assert exit_info.value.code == 2
    assert not (env.dir / "bound.glb").exists()


@pytest.mark.parametrize("up, front", [("Y+", "Y+"), ("Y+", "Y-"), ("X+", "X+")])
def test_bind_refuses_axes_that_are_not_perpendicular(env, binder, up, front):
    assert env.generate() == 0
    assert env.bind(up=up, front=front) == hs.EXIT_REFUSED
    assert binder.call_count == 0


def test_bind_calls_the_binder_once_and_never_the_provider(env, binder, monkeypatch, capsys):
    monkeypatch.setattr(prepare, "paid_provider", Mock(side_effect=AssertionError("provider built")))
    assert env.generate() == 0
    binder.reset_mock()
    env.worker.calls.clear()
    assert env.bind() == 0
    assert binder.call_count == 1 and len(env.provider.calls) == 1
    assert env.worker.paths() == [("GET", f"/v1/objects/{OBJECT_ID}")]  # a drift check, nothing else
    bound = (env.dir / "bound.glb").read_bytes()
    receipt = hs.read_json(env.dir / "bound-receipt.json")
    assert receipt["boundSha256"] == sha(bound) and receipt["rawSha256"] == sha(env.provider.glb)
    assert receipt["validation"]["measured_meters"] == pytest.approx([BOX["w"], BOX["h"], BOX["d"]], abs=0.001)
    assert receipt["evidence"] == "fake_provider" and receipt["objectId"] == OBJECT_ID
    orientation = hs.read_json(env.dir / "orientation.json")
    assert orientation["evidence"] == "manual_review" and orientation["reviewer"] == "tester"
    assert orientation["rawSha256"] == sha(env.provider.glb) and orientation["rawSha256"][:8] in orientation["name"]
    assert orientation["matrix"] == [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    out = capsys.readouterr().out
    assert sha(bound) in out and str(env.dir / "bound.glb") in out

    binder.reset_mock()
    assert env.bind() == 0  # same orientation: an idempotent report
    assert binder.call_count == 0 and (env.dir / "bound.glb").read_bytes() == bound
    assert env.bind(up="Z+", front="X+") == hs.EXIT_REFUSED  # a different orientation needs --rebind
    assert binder.call_count == 0


def test_orientation_matrix_matches_the_project_frame():
    assert prepare.orientation_matrix("Y+", "Z-") == ((1, 0, 0), (0, 1, 0), (0, 0, 1))
    # The Z-up, X-front profile Ani uses in test_mesh_contract.py (SOURCE_AXES).
    assert prepare.orientation_matrix("Z+", "X+") == ((0, -1, 0), (0, 0, 1), (-1, 0, 0))


def test_rebind_supersedes_an_unapproved_binding_from_the_raw_mesh(env, binder):
    assert env.generate() == 0 and env.bind() == 0
    first = hs.read_json(env.dir / "bound-receipt.json")["boundSha256"]
    assert env.bind(up="Z+", front="X+") == hs.EXIT_REFUSED
    assert env.bind("--rebind", up="Z+", front="X+") == 0
    assert binder.call_count == 2 and len(env.provider.calls) == 1
    assert hs.read_json(env.dir / "orientation.json")["up"] == "Z+"
    assert list((env.dir / "superseded").glob(f"*-{first[:8]}/bound.glb"))


def test_real_output_is_replayed_under_the_cached_real_label(tmp_path):
    env = Env(tmp_path, evidence="real_sf3d")  # the LABEL is asserted; no real generation happens
    assert env.generate() == 0 and env.bind() == 0
    assert hs.read_json(env.dir / "attempt.json")["evidence"] == "real_sf3d"
    receipt = hs.read_json(env.dir / "bound-receipt.json")
    assert receipt["evidence"] == "cached_real_sf3d" and receipt["providerRequestId"] == "req-fake-1"


def test_bind_refuses_before_generate_and_for_an_unresolved_attempt(env, binder):
    env.store.mkdir()
    journal = hs.Journal(env.store)
    journal.begin(env.key, OBJECT_ID, sha(png()))
    journal.close()
    assert env.bind() == hs.EXIT_REFUSED  # in_flight, no raw
    assert env.bind(attempt="0" * 8) == hs.EXIT_REFUSED  # no such attempt
    assert env.bind(attempt=env.key[:4]) == hs.EXIT_REFUSED  # too short to be safe
    assert binder.call_count == 0


def test_bind_refuses_when_the_box_moved_since_generate(env, binder):
    assert env.generate() == 0
    env.worker.objects[OBJECT_ID]["bboxMeters"] = {"w": 1.0, "h": 1.0, "d": 1.0}
    assert env.bind() == hs.EXIT_REFUSED
    assert binder.call_count == 0 and not (env.dir / "bound.glb").exists()


def test_bind_refuses_a_raw_mesh_that_changed_on_disk(env, binder):
    assert env.generate() == 0
    (env.dir / "raw.glb").write_bytes(b"tampered")
    assert env.bind() == hs.EXIT_REFUSED
    assert binder.call_count == 0


def test_an_attempt_prefix_of_eight_characters_is_enough(env):
    assert env.generate() == 0
    assert env.bind(attempt=env.key[:8]) == 0
