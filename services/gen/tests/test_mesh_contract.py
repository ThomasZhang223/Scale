"""Synthetic software checks; real SF3D evidence is recorded separately."""
import copy
import io
from pathlib import Path
import sys

import numpy as np
import pytest
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).parent / "data" / "mesh"))
from synthetic import fixture, encode
from app.binding import bind_glb, OrientationProfile, BindingError, UnsupportedMesh
from app.binding.glb import unpack, accessor, instances, primitive_arrays, view_bytes

IDENTITY = OrientationProfile("synthetic-project-axes", "1", ((1, 0, 0), (0, 1, 0), (0, 0, 1)), "synthetic_fixture")
SOURCE_AXES = OrientationProfile("synthetic-X-front-Z-up", "1", ((0, -1, 0), (0, 0, 1), (-1, 0, 0)), "synthetic_fixture")
BOX = {"w": 0.73, "h": 1.29, "d": 0.47}


def bind(raw, bbox=BOX, profile=IDENTITY):
    return bind_glb(raw, bbox, profile, scope="synthetic-user")


def changed(raw, operation):
    doc, binary = unpack(raw)
    operation(doc)
    return encode(doc, binary)


@pytest.mark.parametrize("kind", ["simple", "complex", "orientation"])
def test_serialized_contract_and_visual_preservation(kind):
    raw = fixture(kind)
    before = bytes(raw)
    output = bind(raw)
    assert raw == before
    scene = trimesh.load(io.BytesIO(output.glb), file_type="glb", force="scene", process=False)
    lo, hi = scene.bounds
    np.testing.assert_allclose(hi-lo, [0.73, 1.29, 0.47], atol=0.001, rtol=0)
    np.testing.assert_allclose([(lo[0]+hi[0])/2, lo[1], (lo[2]+hi[2])/2], [0, 0, 0], atol=0.001, rtol=0)
    original, binary = unpack(raw)
    final, bound_binary = unpack(output.glb)
    for field in ("materials", "textures", "images", "samplers"):
        assert original[field] == final[field]
    assert view_bytes(original, binary, original["images"][0]["bufferView"]) == view_bytes(final, bound_binary, final["images"][0]["bufferView"])
    original_primitives = [p for _, _, mesh in instances(original) for p in mesh["primitives"]]
    reloaded = instances(final)
    assert len(reloaded) == len(original_primitives)
    for (_, matrix, mesh), source in zip(reloaded, original_primitives):
        np.testing.assert_array_equal(matrix, np.eye(4))
        p = mesh["primitives"][0]
        v, faces = primitive_arrays(final, bound_binary, p)
        assert np.isfinite(v).all() and faces.min() >= 0 and faces.max() < len(v)
        normals = accessor(final, bound_binary, p["attributes"]["NORMAL"])
        face_normals = np.cross(v[faces[:, 1]]-v[faces[:, 0]], v[faces[:, 2]]-v[faces[:, 0]])
        face_normals /= np.linalg.norm(face_normals, axis=1)[:, None]
        # Flat original normals stay perpendicular even after scale/shear/mirroring.
        np.testing.assert_allclose(normals[faces[:, 0]], face_normals, atol=1e-5, rtol=0)
        np.testing.assert_array_equal(accessor(original, binary, source["attributes"]["TEXCOORD_0"]),
                                      accessor(final, bound_binary, p["attributes"]["TEXCOORD_0"]))
        assert p["material"] == source["material"]
    assert output.report["validation"] == "PASS"
    assert output.report["export_reloaded"] is True


@pytest.mark.parametrize("field", ["w", "h", "d"])
@pytest.mark.parametrize("bad", [None, 0, -1, float("nan"), float("inf"), "1", True, []])
def test_invalid_dimensions(field, bad):
    box = {**BOX, field: bad}
    with pytest.raises(BindingError): bind(fixture("simple"), box)


@pytest.mark.parametrize("bad", [{"w": 1, "h": 1}, {}, None, [1, 2, 3], {"w": 1, "h": 1, "d": 1, "unit": "m"}])
def test_missing_or_malformed_box(bad):
    with pytest.raises(BindingError): bind(fixture("simple"), bad)


@pytest.mark.parametrize("raw", [b"", b"bad", b"glTF" + b"\0"*40])
def test_malformed_glb(raw):
    with pytest.raises(BindingError): bind(raw)


@pytest.mark.parametrize("edit", [
    lambda d: d.update(nodes=[]),
    lambda d: d["meshes"][0].update(primitives=[]),
    lambda d: d["accessors"][0].update(count=0),
    lambda d: d["accessors"][0].update(count=999999),
    lambda d: d["nodes"][0].update(scale=[0, 1, 1]),
    lambda d: d["nodes"][0].update(children=[0]),
    lambda d: d["images"][0].update(uri="https://example.invalid/texture.png"),
    lambda d: d["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"].update(texCoord=1),
    lambda d: d["materials"][0]["pbrMetallicRoughness"].update(roughnessFactor=-1),
    lambda d: d["images"][0].update(mimeType="image/jpeg"),
])
def test_invalid_scene_rejected(edit):
    with pytest.raises(BindingError): bind(changed(fixture("simple"), edit))


@pytest.mark.parametrize("edit", [
    lambda d: d.update(animations=[{}]),
    lambda d: d["meshes"][0]["primitives"][0].update(targets=[{}]),
    lambda d: d["materials"][0].update(normalTexture={"index": 0, "texCoord": 1}),
    lambda d: d["meshes"][0]["primitives"][0]["attributes"].update(TANGENT=0),
    lambda d: d.update(extensionsUsed=["KHR_draco_mesh_compression"]),
])
def test_unsupported_preservation_fails_loud(edit):
    with pytest.raises(UnsupportedMesh): bind(changed(fixture("simple"), edit))


@pytest.mark.parametrize("axis", [0, 1, 2])
def test_degenerate_extent(axis):
    doc, binary = unpack(fixture("simple"))
    blob = bytearray(binary)
    # Make an almost-flat but nonzero valid source: explicit <=1e-8 extent gate.
    for p in doc["meshes"][0]["primitives"]:
        a = doc["accessors"][p["attributes"]["POSITION"]]
        view = doc["bufferViews"][a["bufferView"]]
        v = np.frombuffer(blob, dtype="<f4", count=a["count"]*3, offset=view["byteOffset"]).reshape((-1, 3))
        v[:, axis] *= 1e-10
    with pytest.raises(BindingError, match="Degenerate source extent"):
        bind(encode(doc, blob))


def test_nonfinite_positions_invalid_faces_and_zero_triangles():
    from app.binding.glb import append_array
    for case in ("nan", "bad_face", "zero_area"):
        doc, binary = unpack(fixture("simple"))
        blob = bytearray(binary)
        p = doc["meshes"][0]["primitives"][0]
        if case == "bad_face":
            p["indices"] = append_array(doc, blob, [[999999], [0], [1]], indices=True)
        else:
            a = doc["accessors"][p["attributes"]["POSITION"]]
            offset = doc["bufferViews"][a["bufferView"]]["byteOffset"]
            v = np.frombuffer(blob, dtype="<f4", count=a["count"]*3, offset=offset).reshape((-1, 3))
            if case == "nan": v[0, 0] = float("nan")
            else: v[:3] = 0
        with pytest.raises(BindingError): bind(encode(doc, blob))


def test_orientation_labels_wrong_and_swapped_axes():
    raw = fixture("orientation")
    output = bind(raw, profile=SOURCE_AXES)
    doc, binary = unpack(output.glb)
    centres = {}
    for index, _, mesh in instances(doc):
        vertices, _ = primitive_arrays(doc, binary, mesh["primitives"][0])
        centres.setdefault(doc["nodes"][index]["name"], []).append(vertices)
    centres = {k: np.concatenate(v).mean(axis=0) for k, v in centres.items()}
    assert centres["FRONT_+X"][2] < centres["BODY"][2]
    assert centres["UP_+Z"][1] > centres["BODY"][1]
    assert centres["LEFT_+Y"][0] < centres["BODY"][0]
    assert bind(raw).glb != output.glb  # Same target box alone cannot establish semantic front.
    for matrix in (((0, 1, 0), (1, 0, 0), (0, 0, 1)), ((2, 0, 0), (0, 1, 0), (0, 0, 1))):
        with pytest.raises(BindingError, match="proper rotation"):
            bind(raw, profile=OrientationProfile("bad", "1", matrix, "synthetic_fixture"))
    with pytest.raises(BindingError): bind(raw, profile=None)


@pytest.mark.parametrize("ratio,label", [(1.0, "eligible_for_visual_review"), (1.3, "review_required"), (2.0, "proxy_recommended")])
def test_distortion_diagnostics(ratio, label):
    raw = fixture("simple")
    # Original asymmetric dimensions are 1.3 x 2 x 3.
    output = bind(raw, {"w": 1.3*ratio, "h": 2, "d": 3})
    assert output.report["distortion_diagnostic"] == label
    assert output.report["distortion_ratio"] == pytest.approx(ratio, abs=1e-6)
    assert output.report["publication_requires_visual_review"]


def test_matrix_node_transform_and_missing_normals():
    doc, binary = unpack(fixture("simple"))
    matrix = np.array([[0, 0, 1.7, 9], [0, 0.5, 0, -3], [-2, 0, 0, 4], [0, 0, 0, 1]])
    doc["nodes"][0]["matrix"] = matrix.flatten(order="F").tolist()
    for p in doc["meshes"][0]["primitives"]: del p["attributes"]["NORMAL"]
    output = bind(encode(doc, binary))
    assert output.report["generated_normal_primitives"] == 2
    assert output.report["validation"] == "PASS"


def test_serialized_float32_precision_cannot_weaken_tolerance():
    # Deliberately unrepresentable target at this scale. Must fail after serialization.
    with pytest.raises(BindingError, match="Serialized dimensions"):
        bind(fixture("simple"), {"w": 10000000.123, "h": 2, "d": 3})


def test_indexed_interleaved_attributes():
    from app.binding.glb import append_array
    doc, binary = unpack(fixture("simple"))
    blob = bytearray(binary)
    for p in doc["meshes"][0]["primitives"]:
        count = doc["accessors"][p["attributes"]["POSITION"]]["count"]
        p["indices"] = append_array(doc, blob, np.arange(count)[:, None], indices=True)
        position = accessor(doc, blob, p["attributes"]["POSITION"])
        uv = accessor(doc, blob, p["attributes"]["TEXCOORD_0"])
        interleaved = np.column_stack([position, uv]).astype("<f4")
        start = len(blob)
        blob.extend(interleaved.tobytes())
        doc["bufferViews"].append({"buffer": 0, "byteOffset": start, "byteLength": interleaved.nbytes, "byteStride": 20})
        for name, offset in (("POSITION", 0), ("TEXCOORD_0", 12)):
            doc["accessors"][p["attributes"][name]].update(bufferView=len(doc["bufferViews"])-1, byteOffset=offset)
    assert bind(encode(doc, blob)).report["validation"] == "PASS"


def test_shared_indexed_vertices_generate_valid_normals():
    from app.binding.glb import append_array
    doc, binary = unpack(fixture("simple"))
    blob = bytearray(binary)
    box = trimesh.creation.box(extents=[1, 2, 3])
    doc["meshes"][0]["primitives"] = [{"attributes": {
        "POSITION": append_array(doc, blob, box.vertices)},
        "indices": append_array(doc, blob, box.faces.reshape((-1, 1)), indices=True)}]
    assert bind(encode(doc, blob)).report["generated_normal_primitives"] == 1
