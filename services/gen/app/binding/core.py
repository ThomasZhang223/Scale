"""Pure, deterministic scene-instance binding; no files, network or shared API."""
import copy
from dataclasses import dataclass
import hashlib
import io
import json
import math
from numbers import Real

import numpy as np
import trimesh

from .glb import (BindingError, UnsupportedMesh, require, canonical, unpack, pack,
                  accessor, append_array, instances, primitive_arrays, validate_features, view_bytes)

BINDER_VERSION = "ani-bind-v1"
EXPORTER_VERSION = "ani-glb-preserve-v1"
MARKER = "ani_scale_binding"
TOLERANCE = 0.001


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def dimensions(bbox):
    require(isinstance(bbox, dict) and set(bbox) == {"w", "h", "d"}, "bbox must contain exactly w, h, d")
    values = [bbox[k] for k in ("w", "h", "d")]
    require(all(isinstance(x, Real) and not isinstance(x, (bool, np.bool_))
                and math.isfinite(x) and x > 0 for x in values), "Dimensions must be finite positive metres")
    return np.array(values, dtype=float)


@dataclass(frozen=True)
class OrientationProfile:
    name: str
    version: str
    # Rows of a proper rotation: source world axes -> +Y up / -Z front.
    matrix: tuple
    evidence: str  # synthetic_fixture or manual_review; never inferred automatically.

    def payload(self):
        require(bool(self.name) and bool(self.version) and self.evidence in
                ("synthetic_fixture", "manual_review"), "Explicit orientation evidence required")
        rotation = np.asarray(self.matrix, dtype=float)
        require(rotation.shape == (3, 3) and np.isfinite(rotation).all()
                and np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-9, rtol=0)
                and abs(np.linalg.det(rotation)-1) <= 1e-9, "Orientation must be a proper rotation")
        return {"name": self.name, "version": self.version, "matrix": rotation.tolist(), "evidence": self.evidence}


def _scope(value):
    require(isinstance(value, str) and bool(value.strip()), "Explicit authorized cache scope required")
    return value


def _digest(value):
    require(isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value), "Expected SHA-256")
    return value


def raw_key(*, scope, image_sha256, model_revision, generation_settings):
    """model_revision identifies generator source; settings identify every weight/policy."""
    require(isinstance(model_revision, str) and bool(model_revision), "Generator revision required")
    require(isinstance(generation_settings, dict) and bool(generation_settings), "Generation settings required")
    require({"weights_revision", "secondary_weights", "preprocess_revision", "dtype", "seed", "texture", "remesh"}
            <= generation_settings.keys(), "Incomplete raw generation fingerprint")
    return sha256(canonical({"kind": "raw-v1", "scope": _scope(scope), "image": _digest(image_sha256),
                             "model": model_revision, "settings": generation_settings}))


def bound_key(*, scope, raw_sha256, bbox_meters, orientation_profile):
    target = dimensions(bbox_meters)
    return sha256(canonical({"kind": "bound-v1", "scope": _scope(scope), "raw": _digest(raw_sha256),
                             "bbox_float64_hex": [float(x).hex() for x in target],
                             "orientation": orientation_profile.payload(), "binder": BINDER_VERSION,
                             "exporter": EXPORTER_VERSION, "numpy": np.__version__, "trimesh": trimesh.__version__}))


@dataclass(frozen=True)
class BoundArtifact:
    glb: bytes
    report_json: str

    @property
    def report(self):
        return json.loads(self.report_json)  # Callers cannot mutate stored provenance.


def _already_bound(value):
    if isinstance(value, dict):
        return MARKER in value or any(_already_bound(v) for v in value.values())
    return isinstance(value, list) and any(_already_bound(v) for v in value)


def _bounds(points):
    return np.array([np.min([p.min(axis=0) for p in points], axis=0),
                     np.max([p.max(axis=0) for p in points], axis=0)])


def _transform(vertices, matrix):
    result = vertices @ matrix[:3, :3].T + matrix[:3, 3]
    require(np.isfinite(result).all(), "Transformed vertices are nonfinite")
    return result


def _scene(raw, expected_bounds):
    # Independent scene loader, not the exporter. Visual data is preserved directly
    # in glTF records to avoid lossy material conversion through trimesh exporters.
    scene = trimesh.load(io.BytesIO(raw), file_type="glb", force="scene", process=False)
    require(isinstance(scene, trimesh.Scene) and bool(scene.geometry), "GLB did not reload as a scene")
    require(np.isfinite(scene.bounds).all() and np.allclose(scene.bounds, expected_bounds, atol=1e-7, rtol=1e-7),
            "Independent scene bounds disagree")
    return scene


def _visual_signature(doc, binary):
    return {"records": {k: doc.get(k, []) for k in ("materials", "textures", "samplers", "images")},
            "image_hashes": [sha256(view_bytes(doc, binary, image["bufferView"])) for image in doc.get("images", [])]}


def bind_glb(raw_glb, bbox_meters, orientation_profile, *, scope):
    """Return serialized/reloaded contract evidence or raise BindingError.

    Normals are inverse-transpose transformed; tangents and normal maps explicitly
    raise UnsupportedMesh until their visual preservation can be established.
    """
    try:
        return _bind(raw_glb, bbox_meters, orientation_profile, scope)
    except BindingError:
        raise
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError, OSError,
            RecursionError, np.linalg.LinAlgError) as exc:
        raise BindingError(f"Malformed or unsupported mesh ({type(exc).__name__})") from None


def _bind(raw_glb, bbox, orientation, scope):
    target = dimensions(bbox)
    require(isinstance(orientation, OrientationProfile), "Explicit orientation profile required")
    profile = orientation.payload()
    rotation = np.eye(4)
    rotation[:3, :3] = profile["matrix"]
    doc, binary = unpack(raw_glb)
    require(not _already_bound(doc), "Already bound: retrieve immutable raw artifact before rebinding")
    validate_features(doc, binary)
    source_instances = instances(doc)
    total, primitives, world_points, oriented_points = 0, [], [], []
    for node_id, world, mesh in source_instances:
        for primitive in mesh["primitives"]:
            vertices, faces = primitive_arrays(doc, binary, primitive)
            total += len(vertices)
            require(total <= 2_000_000, "Instanced vertex budget exceeded")
            world_points.append(_transform(vertices, world))
            oriented_points.append(_transform(vertices, rotation @ world))
            primitives.append((node_id, world, primitive, vertices, faces))
    _scene(raw_glb, _bounds(world_points))
    bounds = _bounds(oriented_points)
    extents = bounds[1] - bounds[0]
    require(np.all(extents > 1e-8), "Degenerate source extent")
    scale = target / extents
    require(np.isfinite(scale).all() and np.all(scale > 0), "Invalid dimension correction")
    ratio = float(scale.max() / scale.min())
    require(math.isfinite(ratio), "Unrepresentable distortion ratio")
    diagnostic = "eligible_for_visual_review" if ratio <= 1.25 else "review_required" if ratio <= 1.5 else "proxy_recommended"
    centre = (bounds[0] + bounds[1]) / 2
    centre[1] = bounds[0, 1]
    correction = np.eye(4)
    correction[:3, :3] = np.diag(scale)
    correction[:3, 3] = -centre * scale
    transform = correction @ rotation
    raw_hash = sha256(raw_glb)
    # Snapshot mutable caller dictionaries/rotation arrays before computing identity.
    resolved_orientation = OrientationProfile(profile["name"], profile["version"],
                                               tuple(tuple(row) for row in profile["matrix"]), profile["evidence"])
    key = bound_key(scope=scope, raw_sha256=raw_hash, bbox_meters=dict(zip(("w", "h", "d"), target.tolist())),
                    orientation_profile=resolved_orientation)
    provenance = {"raw_sha256": raw_hash, "bound_key": key, "target_meters": target.tolist(),
                  "binder": BINDER_VERSION, "exporter": EXPORTER_VERSION, "orientation": profile, "units": "metres"}
    out, blob = copy.deepcopy(doc), bytearray(binary)
    out["meshes"], out["nodes"] = [], []
    out["scenes"] = [{"nodes": [], "extras": {MARKER: provenance}}]
    out["scene"] = 0
    out["asset"].setdefault("extras", {})[MARKER] = provenance
    transforms, expected, generated_normals = [], [], 0
    for node_id, world, primitive, vertices, faces in primitives:
        final = transform @ world
        p = copy.deepcopy(primitive)
        p["attributes"]["POSITION"] = append_array(out, blob, _transform(vertices, final))
        if "NORMAL" in primitive["attributes"]:
            normals = accessor(doc, binary, primitive["attributes"]["NORMAL"]).astype(float)
        else:
            normals = np.zeros_like(vertices)
            tri = vertices[faces]
            area = np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0])
            for column in faces.T: np.add.at(normals, column, area)
            generated_normals += 1
        normals = normals @ np.linalg.inv(final[:3, :3])
        lengths = np.linalg.norm(normals, axis=1)
        require(np.isfinite(normals).all() and np.all(lengths > 0), "Invalid transformed normals")
        normals /= lengths[:, None]
        p["attributes"]["NORMAL"] = append_array(out, blob, normals)
        if np.linalg.det(final[:3, :3]) < 0:
            faces = faces[:, ::-1].copy()
        p["indices"] = append_array(out, blob, faces.reshape((-1, 1)), indices=True)
        mesh_id = len(out["meshes"])
        out["meshes"].append({"primitives": [p], "name": f"bound-instance-{node_id}-{mesh_id}"})
        # Flatten instances, not visual primitives/materials. Every node is identity.
        out["nodes"].append({"mesh": mesh_id, "name": doc["nodes"][node_id].get("name", str(node_id)),
                             "extras": {MARKER: {"bound_key": key}}})
        out["scenes"][0]["nodes"].append(mesh_id)
        transforms.append({"source_node": node_id, "matrix_rows": final.tolist()})
        expected.append((primitive, normals, faces))
    result = pack(out, blob)
    reloaded, reloaded_binary = unpack(result)
    validate_features(reloaded, reloaded_binary)
    points = []
    reloaded_instances = instances(reloaded)
    require(len(reloaded_instances) == len(primitives), "Lost geometry instances")
    for (_, matrix, mesh), (source, normals, faces) in zip(reloaded_instances, expected):
        require(np.array_equal(matrix, np.eye(4)), "Export contains nonidentity node transform")
        p = mesh["primitives"][0]
        vertices, actual_faces = primitive_arrays(reloaded, reloaded_binary, p)
        points.append(vertices)
        require(np.array_equal(actual_faces, faces), "Topology changed during export")
        require(np.allclose(accessor(reloaded, reloaded_binary, p["attributes"]["NORMAL"]), normals, atol=1e-6, rtol=0), "Normals changed")
        require(p.get("material") == source.get("material"), "Material assignment changed")
        for name, index in source["attributes"].items():
            if name not in ("POSITION", "NORMAL"):
                require(np.array_equal(accessor(doc, binary, index), accessor(reloaded, reloaded_binary, p["attributes"][name])), "Visual attribute changed")
    measured = _bounds(points)
    _scene(result, measured)
    measured_extents = measured[1] - measured[0]
    origin_error = [float((measured[0, 0]+measured[1, 0])/2), float(measured[0, 1]), float((measured[0, 2]+measured[1, 2])/2)]
    require(np.all(np.abs(measured_extents-target) <= TOLERANCE), "Serialized dimensions exceed 1 mm tolerance")
    require(np.all(np.abs(origin_error) <= TOLERANCE), "Serialized bottom-centre exceeds 1 mm tolerance")
    visual = _visual_signature(doc, binary)
    require(visual == _visual_signature(reloaded, reloaded_binary), "Materials/textures changed during export")
    report = {**provenance, "bound_sha256": sha256(result), "orientation_then_binding_matrix_rows": transform.tolist(),
              "instance_transforms": transforms, "source_oriented_extents": extents.tolist(), "axis_scale": scale.tolist(),
              "distortion_ratio": ratio, "distortion_diagnostic": diagnostic,
              "publication_requires_visual_review": True, "measured_meters": measured_extents.tolist(),
              "dimension_error_meters": np.abs(measured_extents-target).tolist(), "bottom_centre_error_meters": origin_error,
              "validation": "PASS", "export_reloaded": True, "primitive_instances": len(primitives),
              "materials": len(doc.get("materials", [])), "textures": len(doc.get("textures", [])),
              "embedded_image_hashes": visual["image_hashes"], "generated_normal_primitives": generated_normals,
              "tangent_normal_map_support": "unsupported_rejected", "physical_measurement_accuracy": "not_established",
              "numpy": np.__version__, "trimesh": trimesh.__version__}
    return BoundArtifact(result, canonical(report).decode())


@dataclass(frozen=True)
class GeneratedAsset:
    raw_glb: bytes
    image_sha256: str


@dataclass(frozen=True)
class SelectedProduct:
    object_id: str
    image_sha256: str
    bbox_meters: dict


def bind_selected(generated, selected, orientation_profile, *, scope):
    """Ani-only seam: no query-object dimensions accepted or consulted."""
    require(bool(selected.object_id), "Selected product identity required")
    require(_digest(generated.image_sha256) == _digest(selected.image_sha256), "Generation image is not selected product image")
    artifact = bind_glb(generated.raw_glb, selected.bbox_meters, orientation_profile, scope=scope)
    report = artifact.report
    report["selected_object_id"] = selected.object_id
    report["selected_image_sha256"] = selected.image_sha256
    return BoundArtifact(artifact.glb, canonical(report).decode())
