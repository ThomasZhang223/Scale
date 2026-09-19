"""Normal-map regressions inspect exported GLB accessors and independent reloads."""
import io

import numpy as np
import pytest
import trimesh

from test_mesh_contract import fixture, bind, BOX, BindingError
from app.binding.glb import unpack, pack, accessor, append_array, instances, primitive_arrays, view_bytes


def normal_fixture(kind="simple", stale=False):
    doc, binary = unpack(fixture(kind))
    blob = bytearray(binary)
    for material in doc["materials"]:
        material["normalTexture"] = {"index": 0, "scale": 0.65}
    if stale:
        for p in doc["meshes"][0]["primitives"]:
            n = accessor(doc, binary, p["attributes"]["NORMAL"])
            p["attributes"]["TANGENT"] = append_array(doc, blob, np.tile([1, 0, 0, -1], (len(n), 1)))
    return pack(doc, blob)


@pytest.mark.parametrize("kind", ["simple", "complex"])
@pytest.mark.parametrize("stale", [False, True])
def test_normal_map_nonuniform_export(kind, stale):
    raw = normal_fixture(kind, stale)
    result = bind(raw)
    source, sb = unpack(raw)
    doc, binary = unpack(result.glb)
    assert result.report["distortion_ratio"] > 1
    assert result.report["tangent_primitives"] == len(doc["meshes"])
    for key in ("materials", "textures", "samplers", "images"):
        assert doc[key] == source[key]
    for img in source["images"]:
        assert view_bytes(source, sb, img["bufferView"]) == view_bytes(doc, binary, img["bufferView"])
    original = [(w, p) for _, w, m in instances(source) for p in m["primitives"]]
    saw_mirror = False
    for (_, matrix, mesh), (world, old) in zip(instances(doc), original):
        np.testing.assert_array_equal(matrix, np.eye(4))
        p = mesh["primitives"][0]
        pos, faces = primitive_arrays(doc, binary, p)
        _, old_faces = primitive_arrays(source, sb, old)
        mirrored = np.linalg.det(world[:3, :3]) < 0
        saw_mirror |= mirrored
        np.testing.assert_array_equal(faces, old_faces[:, ::-1] if mirrored else old_faces)
        n = accessor(doc, binary, p["attributes"]["NORMAL"])
        t = accessor(doc, binary, p["attributes"]["TANGENT"])
        uv = accessor(doc, binary, p["attributes"]["TEXCOORD_0"])
        np.testing.assert_array_equal(uv, accessor(source, sb, old["attributes"]["TEXCOORD_0"]))
        a = doc["accessors"][p["attributes"]["TANGENT"]]
        assert a["type"] == "VEC4" and a["componentType"] == 5126 and a["count"] == len(pos)
        np.testing.assert_allclose(np.linalg.norm(t[:, :3], axis=1), 1, atol=1e-6)
        np.testing.assert_allclose(np.sum(n * t[:, :3], axis=1), 0, atol=1e-6)
        assert set(t[:, 3]) <= {-1, 1}
        # Fixture UV0 has U along original corner 0 -> 1. This analytic oracle
        # checks actual direction/sign, not merely unit/perpendicular vectors.
        for old_face, face in zip(old_faces, faces):
            expected_t = pos[old_face[1]] - pos[old_face[0]]
            expected_t /= np.linalg.norm(expected_t)
            np.testing.assert_allclose(t[face, :3], np.tile(expected_t, (3, 1)), atol=1e-6)
            v_direction = pos[old_face[2]] - (pos[old_face[0]] + pos[old_face[1]]) / 2
            b = np.cross(n[face], t[face, :3]) * t[face, 3, None]
            assert np.all(b @ v_direction > 0)
            face_n = np.cross(pos[face[1]] - pos[face[0]], pos[face[2]] - pos[face[0]])
            assert np.all(n[face] @ face_n > 0)
        assert doc["materials"][p["material"]]["normalTexture"] == {"index": 0, "scale": 0.65}
    assert saw_mirror == (kind == "complex")
    scene = trimesh.load(io.BytesIO(result.glb), file_type="glb", force="scene", process=False)
    lo, hi = scene.bounds
    np.testing.assert_allclose(hi - lo, list(BOX.values()), atol=0.001, rtol=0)
    np.testing.assert_allclose([(lo[0]+hi[0])/2, lo[1], (lo[2]+hi[2])/2], 0, atol=0.001)
    assert result.report["units"] == "metres"
    assert result.report["raw_sha256"] != result.report["bound_sha256"]
    with pytest.raises(BindingError, match="Already bound"):
        bind(result.glb)


def test_shared_opposite_handedness_splits_vertices_preserving_corners():
    doc, binary = unpack(normal_fixture())
    blob = bytearray(binary)
    pos = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]])
    normals = np.array([[0, 1, 1], [0, 1, 1], [0, 0, 1], [0, 1, 0]], dtype=float)
    normals /= np.linalg.norm(normals, axis=1)[:, None]
    uv = np.array([[0, 0], [1, 0], [0, 1], [0, 1]])
    color = np.array([[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 1, 0, 1]])
    faces = np.array([[0, 1, 2], [0, 3, 1]])
    p = {"attributes": {name: append_array(doc, blob, a) for name, a in
         [("POSITION", pos), ("NORMAL", normals), ("TEXCOORD_0", uv), ("COLOR_0", color)]},
         "indices": append_array(doc, blob, faces.reshape(-1, 1), indices=True), "material": 0}
    doc["meshes"][0]["primitives"] = [p]
    result = bind(pack(doc, blob))
    out, ob = unpack(result.glb)
    p = out["meshes"][0]["primitives"][0]
    v, f = primitive_arrays(out, ob, p)
    assert result.report["tangent_seam_vertices"] == 2 and len(v) == 6
    for name, before in [("TEXCOORD_0", uv), ("COLOR_0", color)]:
        np.testing.assert_array_equal(accessor(out, ob, p["attributes"][name])[f], before[faces])
    t = accessor(out, ob, p["attributes"]["TANGENT"])
    np.testing.assert_array_equal(t[f[0], 3], 1)
    np.testing.assert_array_equal(t[f[1], 3], -1)
    np.testing.assert_allclose(t[:, :3], np.tile([1, 0, 0], (6, 1)), atol=1e-6)
    assert out["materials"] == doc["materials"]


@pytest.mark.parametrize("case", ["missing", "zero", "collinear", "wrong_shape", "nonfinite"])
def test_unconstructible_normal_map_uv_rejected(case):
    doc, binary = unpack(normal_fixture())
    blob = bytearray(binary)
    p = doc["meshes"][0]["primitives"][0]
    index = p["attributes"]["TEXCOORD_0"]
    if case == "missing":
        del p["attributes"]["TEXCOORD_0"]
    elif case == "wrong_shape":
        doc["accessors"][index]["type"] = "VEC3"
    else:
        a = doc["accessors"][index]
        offset = doc["bufferViews"][a["bufferView"]]["byteOffset"]
        uv = np.frombuffer(blob, dtype="<f4", count=a["count"] * 2, offset=offset).reshape(-1, 2)
        if case == "zero": uv[:] = 0
        elif case == "collinear": uv[:, 1] = 0
        else: uv[0, 0] = np.nan
    with pytest.raises(BindingError):
        bind(pack(doc, blob))
