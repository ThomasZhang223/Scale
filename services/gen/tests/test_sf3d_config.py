"""B01 packaging/wrapper tests. Synthetic mesh and fake ML runtime, NEVER generation proof."""

import base64
import copy
import hashlib
import importlib
import io
import json
from pathlib import Path
import struct
import sys
from contextlib import nullcontext
from types import SimpleNamespace

import httpx
from PIL import Image
import pytest
import yaml
from packaging.requirements import Requirement

PACKAGE = Path(__file__).resolve().parents[1] / "deploy" / "sf3d"
sys.path.insert(0, str(PACKAGE))
transport = importlib.import_module("model.transport")
wrapper = importlib.import_module("model.model")
runner = importlib.import_module("b02_smoke")


def image_bytes(mode="RGB", size=(8, 6), fmt="PNG", exif=None):
    output = io.BytesIO()
    image = Image.new(mode, size, (40, 80, 120, 255) if mode == "RGBA" else (40, 80, 120))
    image.save(output, format=fmt, **({"exif": exif} if exif else {}))
    return output.getvalue()


def synthetic_glb():
    # One hand-authored triangle with a real embedded PNG; not a generated object.
    vertices = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    uvs = struct.pack("<6f", 0, 0, 1, 0, 0, 1)
    png = image_bytes(size=(1, 1))
    binary = vertices + uvs + png
    doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
           "nodes": [{"mesh": 0}], "buffers": [{"byteLength": len(binary)}],
           "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(vertices)},
                           {"buffer": 0, "byteOffset": len(vertices), "byteLength": len(uvs)},
                           {"buffer": 0, "byteOffset": len(vertices + uvs), "byteLength": len(png)}],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
                          "min": [0, 0, 0], "max": [1, 1, 0]},
                         {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC2"}],
           "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "material": 0}]}],
           "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
           "textures": [{"source": 0}], "images": [{"bufferView": 2, "mimeType": "image/png"}]}
    encoded = json.dumps(doc).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    return (struct.pack("<4sII", b"glTF", 2, 28 + len(encoded) + len(binary))
            + struct.pack("<I4s", len(encoded), b"JSON") + encoded
            + struct.pack("<I4s", len(binary), b"BIN\x00") + binary)


def validate_schema_fields(value, rule, root):
    """Validate only schema constructs used by this config, fail on unknown fields.

    Not a substitute for Truss's cross-field validators or a container build.
    Reads the exact release's schema, not a hand-maintained list of YAML strings.
    """
    if "$ref" in rule:
        return validate_schema_fields(value, root["$defs"][rule["$ref"].split("/")[-1]], root)
    if "anyOf" in rule:
        for branch in rule["anyOf"]:
            try:
                validate_schema_fields(value, branch, root)
                return
            except (ValueError, TypeError):
                pass
        raise ValueError("Value does not match any allowed schema type")
    types = {"string": str, "integer": int, "boolean": bool, "array": list, "object": dict,
             "null": type(None)}
    if "type" in rule and type(value) is not types[rule["type"]]:
        raise ValueError("Incorrect configuration value type")
    if "enum" in rule and value not in rule["enum"]:
        raise ValueError("Unknown enum value")
    if isinstance(value, dict):
        properties = rule.get("properties", {})
        for key, item in value.items():
            nested = properties.get(key)
            if nested is None:
                nested = rule.get("additionalProperties")
                # Truss's push-time validation also forbids unknown config fields.
                if not isinstance(nested, dict):
                    raise ValueError(f"Unknown configuration key: {key}")
            validate_schema_fields(item, nested, root)
    elif isinstance(value, list):
        for item in value:
            validate_schema_fields(item, rule["items"], root)


def validate_candidate(config):
    schema = json.loads((PACKAGE / "schema" / "truss-0.18.30.json").read_text())
    validate_schema_fields(config, schema, schema)
    if config["runtime"]["predict_concurrency"] != 1:
        raise ValueError("Only one generation may run at a time")
    if config["resources"] != {"instance_type": "L4:4x16"}:
        raise ValueError("Exactly one L4 requires the explicit L4:4x16 SKU")
    if config["python_version"] != "py311":
        raise ValueError("Python must match the selected image")
    if config["secrets"] != {"hf_access_token": None}:
        raise ValueError("Only null secret declarations may be tracked")
    if "@sha256:" not in config["base_image"]["image"]:
        raise ValueError("A content-addressed base image is required")


def test_candidate_schema_and_runtime_constraints():
    config = yaml.safe_load((PACKAGE / "config.yaml").read_text())
    validate_candidate(config)
    mutations = [("runtime", "predict_concurrency", "1"), ("runtime", "predict_concurrency", 2),
                 ("runtime", "predict_concurency", 1), ("resources", "accelerator", "T4"),
                 ("resources", "instance_type", "L4:2x24x96"),
                 ("secrets", "hf_access_token", "not-a-real-token")]
    for section, key, value in mutations:
        broken = copy.deepcopy(config)
        broken[section][key] = value
        with pytest.raises(ValueError):
            validate_candidate(broken)


def test_dependency_pins_satisfy_relevant_truss_server_constraints():
    pins = {}
    for line in (PACKAGE / "requirements.txt").read_text().splitlines():
        if line and not line.startswith("#"):
            req = Requirement(line)
            assert len(list(req.specifier)) == 1
            pin = next(iter(req.specifier))
            assert pin.operator == "=="
            pins[req.name.lower().replace("_", "-")] = pin.version
    assert pins["numpy"] == "1.26.4"
    for line in (PACKAGE / "schema" / "server-constraints.txt").read_text().splitlines():
        if line and not line.startswith("#"):
            req = Requirement(line)
            name = req.name.lower().replace("_", "-")
            if name in pins:
                assert pins[name] in req.specifier, line
    assert "truss" not in pins  # CLI's hub constraint conflicts with SF3D's old hub.


def test_decode_exif_and_transparency():
    exif = Image.Exif()
    exif[274] = 6
    assert transport.decode_image(image_bytes(fmt="JPEG", exif=exif)).size == (6, 8)
    assert transport.decode_image(image_bytes(mode="RGBA")).mode == "RGBA"


@pytest.mark.parametrize("payload", [{}, [], {"image_base64": "bad!"},
                                      {"image_base64": "eA=="}, {"image_url": "https://example.com"},
                                      {"image_base64": "", "texture_resolution": 512}])
def test_reject_bad_or_extra_input(payload):
    with pytest.raises(ValueError):
        transport.decode_request(payload)


def test_image_and_output_size_guards(monkeypatch):
    raw = image_bytes()
    monkeypatch.setattr(transport, "MAX_IMAGE_BYTES", len(raw) - 1)
    with pytest.raises(ValueError):
        transport.decode_image(raw)
    monkeypatch.setattr(transport, "MAX_IMAGE_BYTES", len(raw) + 1)
    monkeypatch.setattr(transport, "MAX_IMAGE_PIXELS", 2)
    with pytest.raises(ValueError):
        transport.decode_image(raw)
    monkeypatch.setattr(transport, "MAX_GLB_BYTES", 32)
    with pytest.raises(ValueError):
        transport.inspect_glb(synthetic_glb())


def test_real_byte_round_trip_and_tamper_detection():
    raw = synthetic_glb()
    response = transport.artifact_response(raw, "input")
    assert transport.decode_response(response, "input") == raw
    for field, value in [("sha256", "wrong"), ("bytes", 1), ("input_sha256", "other"),
                         ("kind", "ready"), ("glb_base64", "eA==")]:
        with pytest.raises(ValueError):
            transport.decode_response({**response, field: value}, "input")
    with pytest.raises(ValueError):
        transport.inspect_glb(raw[:-1])


def test_wrapper_load_once_reuses_runtime_and_unlocks_after_failure(monkeypatch):
    loads, seen = [], []

    class FakeRuntime:
        info = {"fixture": True}

        def __init__(self, token):
            loads.append(True)

        def generate(self, image):
            seen.append((id(self), image.mode))
            return synthetic_glb(), {"synthetic": True}

    monkeypatch.setattr(wrapper, "CudaRuntime", FakeRuntime)
    model = wrapper.Model(secrets={"hf_access_token": "unit-test-only"})
    with pytest.raises(RuntimeError):
        model.predict({})
    model.load()
    model.load()
    with pytest.raises(ValueError):
        model.predict({"image_base64": "invalid"})
    payload = {"image_base64": base64.b64encode(image_bytes()).decode()}
    responses = [model.predict(payload), model.predict(payload)]
    assert loads == [True] and seen[0] == seen[1]
    assert responses[0]["sha256"] == responses[1]["sha256"]
    model._lock.acquire()
    try:
        with pytest.raises(RuntimeError, match="busy"):
            model.predict(payload)
    finally:
        model._lock.release()


def test_generation_pipeline_uses_one_image_session_and_fixed_settings():
    calls = []
    session = object()

    class FakeMesh:
        vertices = [1, 2, 3]
        faces = [1]

        def export(self, **kwargs):
            calls.append(("export", kwargs))
            return synthetic_glb()

    def run_image(image, **kwargs):
        calls.append(("run", image.mode, kwargs))
        return FakeMesh(), {}

    def remove(image, actual_session):
        assert actual_session is session
        calls.append(("remove",))
        return image

    runtime = wrapper.CudaRuntime.__new__(wrapper.CudaRuntime)
    runtime.session = session
    runtime.remove_background = remove
    runtime.resize_foreground = lambda image, ratio: (calls.append(("resize", ratio)) or image)
    runtime.model = SimpleNamespace(run_image=run_image)
    runtime.torch = SimpleNamespace(
        bfloat16="bf16", inference_mode=nullcontext, autocast=lambda **k: nullcontext(),
        cuda=SimpleNamespace(synchronize=lambda: None, reset_peak_memory_stats=lambda: None,
                             max_memory_allocated=lambda: 123))
    raw, timings = runtime.generate(transport.decode_image(image_bytes()))
    assert raw == synthetic_glb()
    assert calls == [("remove",), ("resize", .85),
                     ("run", "RGBA", {"bake_resolution": 1024, "remesh": "none", "vertex_count": -1}),
                     ("export", {"file_type": "glb", "include_normals": True})]
    assert timings["peak_cuda_bytes"] == 123
    calls.clear()
    with pytest.raises(ValueError, match="foreground"):
        runtime.generate(Image.new("RGBA", (8, 8), (0, 0, 0, 0)))
    assert calls == [("remove",)]


def test_missing_secret_does_not_load(monkeypatch):
    monkeypatch.setattr(wrapper, "CudaRuntime", lambda *a: pytest.fail("must not load"))
    with pytest.raises(RuntimeError, match="hf_access_token"):
        wrapper.Model().load()


def test_runner_saves_actual_bytes_once_without_credentials_in_report(tmp_path):
    raw = image_bytes()
    source = tmp_path / "source.png"
    source.write_bytes(raw)
    response = transport.artifact_response(synthetic_glb(), hashlib.sha256(raw).hexdigest(),
                                            revisions=wrapper.REVISIONS)
    calls = []

    def serve(request):
        calls.append(request)
        assert request.headers["Authorization"] == "Bearer unit-secret"
        return httpx.Response(200, json=response, headers={"x-baseten-request-id": "test-only"})

    with httpx.Client(transport=httpx.MockTransport(serve)) as client:
        report = runner.run_once("https://model-test.api.baseten.co/deployment/test/predict",
                                 source, tmp_path / "output", "unit-secret", client=client)
        with pytest.raises(FileExistsError):
            runner.run_once("https://model-test.api.baseten.co/deployment/test/predict",
                            source, tmp_path / "output", "unit-secret", client=client)
    assert len(calls) == 1
    assert (tmp_path / "output/mesh.glb").read_bytes() == synthetic_glb()
    assert "unit-secret" not in json.dumps(report)


@pytest.mark.parametrize("url", ["http://model-test.api.baseten.co/predict",
    "https://example.com/predict", "https://model-test.api.baseten.co/async_predict",
    "https://secret@model-test.api.baseten.co/predict", "https://model-test.api.baseten.co/predict?token=x"])
def test_runner_refuses_unsafe_endpoint(url):
    with pytest.raises(ValueError):
        runner.validate_endpoint(url)


@pytest.mark.parametrize("mode", ["redirect", "oversized", "timeout", "bad_hash"])
def test_runner_failures_never_retry_or_save_mesh(tmp_path, mode):
    source = tmp_path / "input.png"
    raw = image_bytes()
    source.write_bytes(raw)
    calls = []

    def serve(request):
        calls.append(True)
        if mode == "timeout":
            raise httpx.ReadTimeout("possibly running", request=request)
        if mode == "redirect":
            return httpx.Response(302, headers={"location": "https://example.com"})
        if mode == "oversized":
            return httpx.Response(200, headers={"content-length": str(transport.MAX_RESPONSE_BYTES + 1)})
        response = transport.artifact_response(synthetic_glb(), hashlib.sha256(raw).hexdigest())
        response["sha256"] = "bad"
        return httpx.Response(200, json=response)

    with httpx.Client(transport=httpx.MockTransport(serve), follow_redirects=False) as client:
        with pytest.raises((ValueError, RuntimeError)):
            runner.run_once("https://model-test.api.baseten.co/production/predict", source,
                            tmp_path / "output", "unit-secret", client=client)
    assert calls == [True]
    assert not (tmp_path / "output/mesh.glb").exists()


def test_cli_requires_explicit_opt_in(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "run_once", lambda *a, **k: pytest.fail("network must not run"))
    with pytest.raises(SystemExit) as exc:
        runner.main(["--endpoint", "https://model-test.api.baseten.co/production/predict",
                     "--image", "unused.png", "--output-dir", str(tmp_path / "out")])
    assert exc.value.code == 2
