"""Offline proof for the already reviewed chair artifact. Never generates a mesh.

Run explicitly with --raw <saved mesh.glb> --output <new directory outside Git>.
The target is a software exercise derived from the mesh, NOT chair measurements.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.binding import bind_glb, BindingError, OrientationProfile
from app.binding.glb import unpack, accessor, primitive_arrays, instances

RAW_SHA = "6291edefcd2e1342903b57619d9c17ebf676a2a33774d17ab629fa76ae4e4956"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    if args.output.resolve().is_relative_to(repo):
        parser.error("Artifacts must be outside the repository")
    raw = args.raw.read_bytes()
    if hashlib.sha256(raw).hexdigest() != RAW_SHA:
        parser.error("Orientation review applies only to the saved 6291edef chair")
    doc, binary = unpack(raw)
    source = instances(doc)
    assert len(source) == 1 and np.array_equal(source[0][1], np.eye(4))
    p = source[0][2]["primitives"][0]
    v, f = primitive_arrays(doc, binary, p)
    bounds = np.array([v.min(0), v.max(0)])
    factors = np.array([1.08, 1.0, 0.96])
    target = dict(zip(("w", "h", "d"), ((bounds[1] - bounds[0]) * factors).tolist()))
    profile = OrientationProfile("sf3d-chair-6291edef-manual-review", "1",
                                 ((1, 0, 0), (0, 1, 0), (0, 0, 1)), "manual_review")
    result = bind_glb(raw, target, profile, scope="ani-local-sf3d-software-proof")
    out, ob = unpack(result.glb)
    bp = out["meshes"][0]["primitives"][0]
    bv, bf = primitive_arrays(out, ob, bp)
    n = accessor(out, ob, bp["attributes"]["NORMAL"])
    t = accessor(out, ob, bp["attributes"]["TANGENT"])
    # Independent corner comparison includes duplicates introduced at UV seams.
    np.testing.assert_array_equal(accessor(doc, binary, p["attributes"]["TEXCOORD_0"])[f],
                                  accessor(out, ob, bp["attributes"]["TEXCOORD_0"])[bf])
    np.testing.assert_allclose(np.linalg.norm(t[:, :3], axis=1), 1, atol=1e-6)
    np.testing.assert_allclose(np.sum(n * t[:, :3], axis=1), 0, atol=1e-6)
    assert np.all(np.abs(t[:, 3]) == 1)
    assert out["materials"] == doc["materials"]
    assert "normalTexture" in out["materials"][0]
    assert "baseColorTexture" in out["materials"][0]["pbrMetallicRoughness"]
    try:
        bind_glb(result.glb, target, profile, scope="ani-local-sf3d-software-proof")
    except BindingError as exc:
        assert "Already bound" in str(exc)
    else:
        raise AssertionError("Double binding was accepted")
    report = {**result.report, "raw_bytes": len(raw), "bound_bytes": len(result.glb),
              "raw_vertices": len(v), "raw_faces": len(f), "bound_vertices": len(bv), "bound_faces": len(bf),
              "source_aabb": bounds.tolist(), "software_target_factors": factors.tolist(),
              "target_provenance": "Derived raw AABB software target; NOT independently measured chair dimensions",
              "uv_corners_preserved": True, "double_binding_rejected": True,
              "max_tangent_length_error": float(np.max(np.abs(np.linalg.norm(t[:, :3], axis=1) - 1))),
              "max_tangent_normal_dot": float(np.max(np.abs(np.sum(n * t[:, :3], axis=1)))),
              "visual_review": "Required separately; numeric success alone is not a visual pass"}
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / "chair-bound.glb").write_bytes(result.glb)
    (args.output / "binding-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
