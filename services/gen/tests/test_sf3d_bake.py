import base64
from types import SimpleNamespace

import pytest

from test_sf3d_config import image_bytes, synthetic_glb, wrapper


@pytest.mark.parametrize("value", [0, 513, 2048, True, "512", 512.0, None])
def test_resolution_allowlist(value):
    with pytest.raises(ValueError):
        wrapper.validate_bake_resolution(value)


@pytest.mark.parametrize("resolution", [512, 1024])
def test_internal_override_and_provenance(monkeypatch, resolution):
    monkeypatch.setenv("SF3D_PROFILE_ALLOW_BAKE_OVERRIDE", "1")
    model = wrapper.Model()
    seen = []
    def generate(image, bake_resolution=1024):
        seen.append(bake_resolution)
        return synthetic_glb(), {}
    model._runtime = SimpleNamespace(info={}, generate=generate)
    payload = {"image_base64": base64.b64encode(image_bytes()).decode(),
               "_profile_bake_resolution": resolution}
    result = model.predict(payload)
    assert seen == [resolution]
    assert payload["_profile_bake_resolution"] == resolution
    assert result["settings"]["texture_resolution"] == resolution
    assert result["timings"]["effective_bake_resolution"] == resolution
    assert result["settings"]["remesh"] == "none"
    assert wrapper.SETTINGS["texture_resolution"] == 1024


def test_production_rejects_internal_override(monkeypatch):
    monkeypatch.delenv("SF3D_PROFILE_ALLOW_BAKE_OVERRIDE", raising=False)
    model = wrapper.Model()
    model._runtime = SimpleNamespace(info={}, generate=lambda _: pytest.fail("must reject before inference"))
    with pytest.raises(ValueError):
        model.predict({"image_base64": base64.b64encode(image_bytes()).decode(), "_profile_bake_resolution": 512})
