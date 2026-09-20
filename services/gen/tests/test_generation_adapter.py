"""Fake-provider software evidence, with the actual B04 binder and serialized GLB."""
import base64
import hashlib
import io
import json
from unittest.mock import Mock

import httpx
import pytest
from PIL import Image

from test_mesh_contract import fixture, IDENTITY
from app import generation as g
from app.generation_io import SF3DProvider, WorkerArtifactSink, response_bytes, private_http
from deploy.sf3d.model.model import REVISIONS
from deploy.sf3d.model.transport import artifact_response


def png(color="red"):
    out = io.BytesIO()
    Image.new("RGB", (4, 5), color).save(out, format="PNG")
    return out.getvalue()


def request(source="scan", object_id="owned-A", color="red", dimensions=None):
    image = png(color)
    return g.GenerationInput.from_object({"objectId": object_id, "source": source,
        "bboxMeters": dimensions or {"w": .61, "h": 1.07, "d": .49}}, image,
        image_sha256=hashlib.sha256(image).hexdigest(), image_ref="fixtures/" + color + ".png",
        scope="test-session")


class FakeProvider:
    def __init__(self):
        self.calls = []
        self.glb = fixture()

    def generate(self, image, image_sha256):
        self.calls.append((image, image_sha256))
        return g.RawGeneration(self.glb, image_sha256, "synthetic-fixture-v1", "fake_provider")


def review(artifact):
    return g.VisualReview(artifact.receipt["boundSha256"], "test-runner", "synthetic_test")


def prepare(req=None):
    provider = FakeProvider()
    attempt = g.GenerationAttempt(req or request(), provider, IDENTITY)
    return attempt.prepare(), attempt, provider


def test_owned_object_real_b04_once_and_worker_inline_result(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    binder = Mock(wraps=g.bind_selected)
    monkeypatch.setattr(g, "bind_selected", binder)
    artifact, attempt, provider = prepare()
    assert attempt.prepare() is artifact
    assert binder.call_count == len(provider.calls) == 1
    receipt = artifact.receipt
    assert receipt["source"] == "scan"
    assert receipt["evidence"] == "fake_provider"
    assert receipt["scale"] == 1
    assert receipt["validation"]["measured_meters"] == pytest.approx([.61, 1.07, .49], abs=.001)
    assert receipt["boundSha256"] == hashlib.sha256(artifact.glb).hexdigest()
    assert receipt["rawSha256"] == hashlib.sha256(provider.glb).hexdigest()
    assert all(t >= 0 for t in receipt["timings"].values())
    response = artifact.worker_result(review(artifact))
    assert base64.b64decode(response["glbBase64"]) == artifact.glb
    receipt["objectId"] = "mutated"
    assert artifact.receipt["objectId"] == "owned-A"
    assert list(tmp_path.iterdir()) == []  # no temporary files to leak or remove


def test_selected_b_uses_b_image_and_dimensions_not_query_a():
    query_a = request(dimensions={"w": 8, "h": 9, "d": 7})
    selected_b = request("catalog", "product-B", "blue", {"w": .3, "h": .7, "d": .5})
    artifact, _, provider = prepare(selected_b)
    assert provider.calls == [(selected_b.image, selected_b.image_sha256)]
    assert provider.calls[0][0] != query_a.image
    assert artifact.receipt["validation"]["target_meters"] == [.3, .7, .5]
    assert artifact.receipt["objectId"] == "product-B"


@pytest.mark.parametrize("kind", ["exception", "malformed", "wrong_image", "unsupported", "already_bound"])
def test_provider_or_binding_failure_never_completes_or_retries(kind, monkeypatch):
    req, provider = request(), FakeProvider()
    if kind == "exception":
        provider.generate = Mock(side_effect=RuntimeError("SECRET signed-url"))
    elif kind == "malformed":
        provider.glb = b"not a mesh"
    elif kind == "wrong_image":
        provider.generate = Mock(return_value=g.RawGeneration(provider.glb, "f" * 64, "test", "fake_provider"))
    elif kind == "unsupported":
        monkeypatch.setattr(g, "bind_selected", Mock(side_effect=g.BindingError("unsupported")))
    else:
        provider.glb = prepare()[0].glb
    attempt = g.GenerationAttempt(req, provider, IDENTITY)
    with pytest.raises(g.GenerationError) as error:
        attempt.prepare()
    assert "SECRET" not in str(error.value)
    with pytest.raises(g.GenerationError, match="already_attempted"):
        attempt.prepare()


def test_ambiguous_timeout_is_never_resubmitted(caplog):
    provider = Mock()
    provider.generate.side_effect = TimeoutError("https://private/?token=SECRET")
    attempt = g.GenerationAttempt(request(), provider, IDENTITY)
    for _ in range(2):
        with pytest.raises(g.AmbiguousGeneration, match="do_not_resubmit"):
            attempt.prepare()
    assert provider.generate.call_count == 1
    assert "SECRET" not in caplog.text


def test_delivery_retry_reuses_prepared_bytes():
    artifact, attempt, provider = prepare()
    sink = Mock()
    sink.put.side_effect = [RuntimeError("secret"), "objects/owned-A/mesh.glb"]
    with pytest.raises(g.GenerationError, match="delivery_failed_retry_same_bytes"):
        g.deliver(artifact, sink, review(artifact))
    result = g.deliver(artifact, sink, review(artifact))
    assert result["glbKey"] == "objects/owned-A/mesh.glb"
    assert sink.put.call_args_list[0] == sink.put.call_args_list[1]
    assert attempt.prepare() is artifact and len(provider.calls) == 1


@pytest.mark.parametrize("review_kind", ["none", "wrong_hash", "wrong_evidence"])
def test_completion_requires_matching_review(review_kind):
    artifact, _, _ = prepare()
    candidate = {"none": None,
        "wrong_hash": g.VisualReview("0" * 64, "test", "synthetic_test"),
        "wrong_evidence": g.VisualReview(artifact.receipt["boundSha256"], "test", "manual_review")}[review_kind]
    with pytest.raises(g.GenerationError):
        artifact.worker_result(candidate)


def test_worker_request_maps_hydrated_source_and_keeps_actual_reference():
    req = request()
    body = {"tier": "live", "object_id": req.object_id, "bbox_meters": req.bbox_meters,
            "image_url": "https://worker.invalid/v1/assets/objects/owned-A/frames/0.png",
            "upload_url": "https://worker.invalid/v1/uploads", "want_embedding": True}
    with pytest.raises(g.GenerationError, match="source"):
        g.worker_request(body, req.image, scope=req.scope, image_sha256=req.image_sha256, image_ref=req.image_ref)
    body["source"] = "scan"
    assert g.worker_request(body, req.image, scope=req.scope, image_sha256=req.image_sha256,
                            image_ref=req.image_ref) == req


@pytest.mark.parametrize("tier,accepted", [("live", True), ("quality", True), ("cheap", False), (None, False)])
def test_worker_request_accepts_every_contract_tier(tier, accepted):
    """.claude/contracts.md: POST /objects/{id}/generate takes "live" OR "quality"."""
    req = request()
    body = {"object_id": req.object_id, "source": "scan", "bbox_meters": req.bbox_meters,
            "image_url": "https://worker.invalid/v1/assets/objects/owned-A/frames/0.png"}
    if tier is not None:
        body["tier"] = tier
    call = lambda: g.worker_request(body, req.image, scope=req.scope,
                                    image_sha256=req.image_sha256, image_ref=req.image_ref)
    if accepted:
        assert call() == req
    else:
        with pytest.raises(g.GenerationError, match="unsupported_generation_tier"):
            call()


def test_paid_disabled_by_default():
    client = Mock()
    with pytest.raises(g.GenerationError, match="not_enabled"):
        SF3DProvider("https://model-unit.api.baseten.co/production/predict", "test-token", client=client).generate(b"", "")
    client.stream.assert_not_called()


def test_stream_deadline_and_byte_limit():
    with pytest.raises(TimeoutError, match="deadline"):
        response_bytes(httpx.Response(200, content=b"data"), 10, deadline=0)
    with pytest.raises(g.GenerationError, match="too_large"):
        response_bytes(httpx.Response(200, content=b"data"), 3)


def test_lazy_core_transport_does_not_log_credentials(caplog):
    import logging
    caplog.set_level(logging.DEBUG)
    with private_http():
        for name in ("httpx", "httpcore.connection", "httpcore.http11", "httpcore.http2", "httpcore.proxy", "httpcore.socks"):
            logging.getLogger(name).debug("private-transport-test-secret")
    assert "private-transport-test-secret" not in caplog.text
    logging.getLogger("httpx").info("unrelated-normal-log")
    assert "unrelated-normal-log" in caplog.text


@pytest.mark.parametrize("behavior", ["ok", "timeout", "corrupt", "revision", "redirect"])
def test_sf3d_transport_fake_network_only(behavior):
    req = request()
    def handler(http_request):
        assert json.loads(http_request.content)["image_base64"] == base64.b64encode(req.image).decode()
        if behavior == "timeout":
            raise httpx.ReadTimeout("SECRET", request=http_request)
        payload = artifact_response(fixture(), req.image_sha256, revisions=REVISIONS)
        if behavior == "corrupt":
            payload["sha256"] = "0" * 64
        if behavior == "revision":
            payload["revisions"] = {}
        return httpx.Response(302 if behavior == "redirect" else 200, json=payload)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        provider = SF3DProvider("https://model-unit.api.baseten.co/production/predict", "test-token",
                                allow_paid=True, client=client)
        if behavior == "ok":
            result = provider.generate(req.image, req.image_sha256)
            assert result.glb == fixture()  # transport mock: NOT real generation evidence
        else:
            with pytest.raises(g.AmbiguousGeneration if behavior == "timeout" else g.GenerationError):
                provider.generate(req.image, req.image_sha256)


@pytest.mark.parametrize("behavior", ["ok", "upload_fails", "foreign_grant", "wrong_bytes"])
def test_thomas_upload_shape_verified_with_mock_storage(behavior, caplog):
    import logging
    caplog.set_level(logging.DEBUG)
    artifact, _, provider = prepare()
    calls = []
    def handler(req):
        calls.append(req.method)
        if req.method == "POST":
            assert json.loads(req.content) == {"kind": "objectMesh", "ext": "glb", "objectId": "owned-A"}
            host = "evil.invalid" if behavior == "foreign_grant" else "worker.invalid"
            return httpx.Response(200, json={"key": "objects/owned-A/mesh.glb",
                "putUrl": f"https://{host}/v1/uploads/objects/owned-A/mesh.glb?t=test-only"})
        if req.method == "PUT":
            assert req.content == artifact.glb
            return httpx.Response(500 if behavior == "upload_fails" else 200)
        assert req.url.path == "/v1/assets/objects/owned-A/mesh.glb"
        return httpx.Response(200, content=b"wrong" if behavior == "wrong_bytes" else artifact.glb)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        sink = WorkerArtifactSink("https://worker.invalid", client=client)
        if behavior == "ok":
            assert g.deliver(artifact, sink, review(artifact))["glbKey"] == "objects/owned-A/mesh.glb"
            assert calls == ["POST", "PUT", "GET"]
        else:
            with pytest.raises(g.GenerationError):
                g.deliver(artifact, sink, review(artifact))
    assert len(provider.calls) == 1
    assert "test-only" not in caplog.text
