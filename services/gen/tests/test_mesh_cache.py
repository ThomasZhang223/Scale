"""No storage calls; cache identities and immutable raw/bound separation."""
import copy
from dataclasses import replace

import numpy as np
import pytest

from test_mesh_contract import fixture, bind, IDENTITY, BOX
from app.binding import raw_key, bound_key, BindingError
from app.binding.core import sha256


def test_double_binding_and_independent_boxes():
    raw = fixture("complex")
    digest = sha256(raw)
    a = bind(raw)
    b = bind(raw, {"w": 2.3, "h": 0.4, "d": 1.1})
    assert sha256(raw) == digest
    assert a.glb == bind(raw).glb
    assert a.report["bound_key"] != b.report["bound_key"]
    assert a.report["bound_sha256"] != b.report["bound_sha256"]
    assert a.report["raw_sha256"] == b.report["raw_sha256"] == digest
    for bound in (a, b):
        with pytest.raises(BindingError, match="Already bound"): bind(bound.glb)
    mutable_report = a.report
    mutable_report["target_meters"][0] = 100
    assert a.report["target_meters"][0] == BOX["w"]


def test_bound_keys_include_exact_dimensions_scope_versions_and_orientation(monkeypatch):
    from app.binding import core
    kwargs = dict(scope="user-A", raw_sha256=sha256(fixture()), bbox_meters=BOX, orientation_profile=IDENTITY)
    baseline = bound_key(**kwargs)
    assert bound_key(**{**kwargs, "bbox_meters": dict(reversed(list(BOX.items())))}) == baseline
    changes = [dict(scope="user-B"), dict(raw_sha256="b"*64),
               dict(bbox_meters={**BOX, "w": float(np.nextafter(BOX["w"], 1))}),
               dict(orientation_profile=replace(IDENTITY, version="2")),
               dict(orientation_profile=replace(IDENTITY, matrix=((0, 0, 1), (0, 1, 0), (-1, 0, 0))))]
    for change in changes: assert bound_key(**{**kwargs, **change}) != baseline
    monkeypatch.setattr(core, "BINDER_VERSION", "next")
    assert bound_key(**kwargs) != baseline
    monkeypatch.setattr(core, "BINDER_VERSION", "ani-bind-v1")
    monkeypatch.setattr(core, "EXPORTER_VERSION", "next")
    assert bound_key(**kwargs) != baseline


def test_raw_keys_are_deterministic_and_scope_settings_sensitive():
    args = dict(scope="user-A", image_sha256="a"*64, model_revision="synthetic-model-rev",
                generation_settings={"preprocess_revision": "p1", "weights_revision": "w1", "secondary_weights": "s1",
                                     "dtype": "float32", "seed": 0, "texture": 1024, "remesh": "none"})
    baseline = raw_key(**args)
    assert raw_key(**copy.deepcopy(args)) == baseline
    for change in (dict(scope="user-B"), dict(image_sha256="b"*64), dict(model_revision="other"),
                   dict(generation_settings={**args["generation_settings"], "texture": 512})):
        assert raw_key(**{**args, **change}) != baseline
    with pytest.raises(BindingError): raw_key(**{**args, "scope": ""})
    with pytest.raises(BindingError): raw_key(**{**args, "generation_settings": {"seed": 0}})
