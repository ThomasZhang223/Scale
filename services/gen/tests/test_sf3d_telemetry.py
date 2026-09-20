"""CPU-only semantic and timing tests; no downloads or GPU predictions."""
import base64
from types import SimpleNamespace

import pytest

from test_sf3d_config import image_bytes, synthetic_glb, wrapper, transport
from model.telemetry import Hooks, Timings
from model.telemetry import profile_sf3d


def test_nested_completed_timing_and_reversible_hooks():
    now = [0.0]
    sync = []
    timers = Timings(lambda: sync.append(True), lambda: now[0])
    sentinel = object()

    class Target:
        def inner(self, value):
            now[0] += 2
            return value

        def outer(self, value):
            now[0] += 1
            result = self.inner(value)
            now[0] += 3
            return result

    original = Target.inner
    target = Target()
    with Hooks(timers) as hooks:
        hooks.wrap(Target, "inner", "inner", gpu=True)
        hooks.wrap(target, "outer", "outer", gpu=True)
        assert target.outer(sentinel) is sentinel
    assert Target.inner is original and "outer" not in vars(target)
    assert timers.stages["outer"] == {"wall_ms": 6000, "exclusive_ms": 4000, "calls": 1}
    assert timers.stages["inner"]["wall_ms"] == 2000
    assert len(sync) == 4


def test_hooks_restore_after_failure_and_preserve_property_cache():
    class Target:
        _all_edges = None

        @property
        def all_edges(self):
            if self._all_edges is None:
                self._all_edges = object()
            return self._all_edges

    original = Target.all_edges
    target = Target()
    timers = Timings()
    with pytest.raises(ValueError):
        with Hooks(timers) as hooks:
            hooks.property(Target, "all_edges", "lazy_all_edges")
            first = target.all_edges
            assert target.all_edges is first
            raise ValueError("failure")
    assert Target.all_edges is original
    assert target.all_edges is first
    assert timers.stages["lazy_all_edges"]["calls"] == 1
    assert timers.stages["all_edges_cache_hit"]["calls"] == 1


def test_diagnostics_preserve_exact_artifact_and_input():
    model = wrapper.Model()
    raw = synthetic_glb()
    model._runtime = SimpleNamespace(info={"gpu": "mock"}, generate=lambda image: (raw, {}))
    payload = {"image_base64": base64.b64encode(image_bytes()).decode()}
    first, second = model.predict(payload), model.predict(payload)
    assert transport.decode_response(first, first["input_sha256"]) == raw
    assert first["glb_base64"] == second["glb_base64"]
    assert first["settings"] == second["settings"] == wrapper.SETTINGS
    assert [first["timings"]["request_ordinal"], second["timings"]["request_ordinal"]] == [1, 2]
    assert first["timings"]["server_total_ms"] >= first["timings"]["decode_ms"]
    assert first["timings"]["image_mode"] == "RGBA"


def test_pinned_hook_surface_installs_and_restores(monkeypatch):
    import sys

    class Module:
        def forward(self, *a, **k):
            return a

    class Helper(Module):
        _all_edges = None
        all_edges = property(lambda self: [])

    class Mesh:
        def unwrap_uv(self): pass
        def _compute_vertex_normal(self): pass
        def _compute_vertex_tangent(self): pass

    class Unwrapper:
        def _assign_faces_uv_to_atlas_index(self): pass

    system = SimpleNamespace(dilate_fill=lambda: None, convert_data=lambda: None,
                             float32_to_uint8_np=lambda: None,
                             trimesh=SimpleNamespace(Trimesh=Mesh, visual=SimpleNamespace(
                                 material=SimpleNamespace(PBRMaterial=Module))))
    monkeypatch.setitem(sys.modules, "sf3d", SimpleNamespace(system=system))
    monkeypatch.setitem(sys.modules, "sf3d.models.mesh", SimpleNamespace(Mesh=Mesh))
    monkeypatch.setitem(sys.modules, "uv_unwrapper", SimpleNamespace(Unwrapper=Unwrapper))
    model = SimpleNamespace(prepare_image=lambda x: x, get_scene_codes=lambda: None,
                            triplane_to_meshes=lambda: None, query_triplane=lambda: None,
                            image_processor=SimpleNamespace(convert_and_resize=lambda x: x),
                            decoder=Module(), isosurface_helper=Helper(),
                            baker=SimpleNamespace(rasterize=lambda: None, interpolate=lambda: None))
    for name in ("image_tokenizer", "backbone", "post_processor", "image_estimator"):
        setattr(model, name, Module())
    sentinel = object()
    original = model.prepare_image
    with profile_sf3d(model, Timings()):
        assert model.prepare_image(sentinel) is sentinel
        assert model.image_processor.convert_and_resize(sentinel) is sentinel
    assert model.prepare_image is original
