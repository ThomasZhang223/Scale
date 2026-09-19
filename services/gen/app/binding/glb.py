"""Bounded static GLB codec. Keep original visual records/binary data losslessly.

This deliberately supports a strict glTF subset, not an arbitrary scene converter.
Unsupported deformation/compression/tangent-space features fail closed.
"""
import copy
import io
import json
import struct
import warnings

import numpy as np
from PIL import Image

MAX_BYTES = 64 * 1024 * 1024
MAX_ELEMENTS = 2_000_000


class BindingError(ValueError):
    """Invalid input or failed serialized contract; no usable artifact returned."""


class UnsupportedMesh(BindingError):
    """Feature requires an explicitly tested preservation path."""


def require(condition, message):
    if not condition:
        raise BindingError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def unpack(raw):
    require(isinstance(raw, bytes) and 28 <= len(raw) <= MAX_BYTES, "Invalid GLB byte length")
    require(struct.unpack_from("<4sII", raw) == (b"glTF", 2, len(raw)), "Invalid GLB header")
    chunks, offset = [], 12
    while offset < len(raw):
        require(offset + 8 <= len(raw), "Truncated GLB chunk")
        size, kind = struct.unpack_from("<I4s", raw, offset)
        offset += 8
        require(size % 4 == 0 and offset + size <= len(raw), "Invalid GLB chunk size")
        chunks.append((kind, raw[offset:offset + size]))
        offset += size
    require([c[0] for c in chunks] == [b"JSON", b"BIN\x00"], "Expected JSON and embedded BIN chunks")
    try:
        doc = json.loads(chunks[0][1])
    except (ValueError, UnicodeError):
        raise BindingError("Invalid GLB JSON") from None
    require(isinstance(doc, dict) and doc.get("asset", {}).get("version") == "2.0", "Expected glTF 2.0")
    buffers = doc.get("buffers", [])
    require(len(buffers) == 1 and "uri" not in buffers[0], "Only one embedded buffer supported")
    length = buffers[0].get("byteLength", -1)
    require(type(length) is int and 0 <= length <= len(chunks[1][1]) <= length + 3, "Invalid buffer length")
    return doc, chunks[1][1][:length]


def pack(doc, binary):
    doc = copy.deepcopy(doc)
    doc["buffers"] = [{"byteLength": len(binary)}]
    js = canonical(doc)
    js += b" " * (-len(js) % 4)
    binary = bytes(binary) + b"\x00" * (-len(binary) % 4)
    size = 12 + 8 + len(js) + 8 + len(binary)
    require(size <= MAX_BYTES, "Bound artifact exceeds byte limit")
    return (struct.pack("<4sII", b"glTF", 2, size) + struct.pack("<I4s", len(js), b"JSON")
            + js + struct.pack("<I4s", len(binary), b"BIN\x00") + binary)


def record(items, index):
    require(type(index) is int and 0 <= index < len(items), "Invalid GLB reference")
    return items[index]


def view_bytes(doc, binary, index):
    view = record(doc.get("bufferViews", []), index)
    start, size = view.get("byteOffset", 0), view.get("byteLength")
    require(view.get("buffer", 0) == 0 and type(start) is int and type(size) is int
            and start >= 0 and size > 0 and start + size <= len(binary), "Invalid bufferView")
    return binary[start:start + size]


def accessor(doc, binary, index):
    a = record(doc.get("accessors", []), index)
    if "sparse" in a or a.get("normalized", False):
        raise UnsupportedMesh("Sparse/normalized accessors require a separate preservation path")
    types = {5121: "u1", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
    widths = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    require(a.get("componentType") in types and a.get("type") in widths, "Unsupported accessor type")
    dtype, width = np.dtype(types[a["componentType"]]), widths[a["type"]]
    count, offset = a.get("count"), a.get("byteOffset", 0)
    view = record(doc.get("bufferViews", []), a.get("bufferView"))
    data = view_bytes(doc, binary, a["bufferView"])
    stride = view.get("byteStride", dtype.itemsize * width)
    require(type(count) is int and 0 < count <= MAX_ELEMENTS and type(offset) is int and offset >= 0
            and type(stride) is int and stride >= dtype.itemsize * width
            and stride % dtype.itemsize == 0 and offset % dtype.itemsize == 0
            and offset + (count - 1) * stride + width * dtype.itemsize <= len(data), "Invalid accessor bounds")
    result = np.ndarray((count, width), dtype=dtype, buffer=data, offset=offset,
                        strides=(stride, dtype.itemsize)).copy()
    require(np.isfinite(result).all(), "Nonfinite accessor")
    return result


def append_array(doc, binary, values, *, indices=False):
    values = np.asarray(values, dtype="<u4" if indices else "<f4")
    require(np.isfinite(values).all(), "Float32 export overflow")
    binary.extend(b"\x00" * (-len(binary) % 4))
    view = len(doc.setdefault("bufferViews", []))
    doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": values.nbytes})
    binary.extend(values.tobytes())
    a = {"bufferView": view, "componentType": 5125 if indices else 5126,
         "count": len(values), "type": "SCALAR" if indices else f"VEC{values.shape[1]}"}
    if not indices:
        a.update(min=values.min(axis=0).tolist(), max=values.max(axis=0).tolist())
    doc.setdefault("accessors", []).append(a)
    return len(doc["accessors"]) - 1


def local_transform(node):
    if "matrix" in node:
        require(not any(k in node for k in ("translation", "rotation", "scale")), "Mixed matrix/TRS")
        value = np.asarray(node["matrix"], dtype=float)
        require(value.shape == (16,), "Invalid matrix")
        matrix = value.reshape((4, 4), order="F")
    else:
        t = np.asarray(node.get("translation", [0, 0, 0]), dtype=float)
        s = np.asarray(node.get("scale", [1, 1, 1]), dtype=float)
        q = np.asarray(node.get("rotation", [0, 0, 0, 1]), dtype=float)
        require(t.shape == s.shape == (3,) and q.shape == (4,), "Invalid TRS")
        require(np.isfinite(q).all() and abs(np.linalg.norm(q) - 1) < 1e-6, "Invalid quaternion")
        x, y, z, w = q
        rotation = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                             [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                             [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
        matrix = np.eye(4)
        matrix[:3, :3], matrix[:3, 3] = rotation @ np.diag(s), t
    require(np.isfinite(matrix).all() and np.allclose(matrix[3], [0, 0, 0, 1], atol=1e-12, rtol=0)
            and abs(np.linalg.det(matrix[:3, :3])) > 1e-15, "Nonfinite/singular/nonaffine transform")
    return matrix


def instances(doc):
    require(len(doc.get("scenes", [])) == 1 and doc.get("scene", 0) == 0, "Exactly one scene required")
    nodes, found, visited = doc.get("nodes", []), [], set()
    def walk(index, parent, depth):
        require(depth <= 64 and index not in visited, "Cyclic/shared node or excessive scene depth")
        node = record(nodes, index)
        visited.add(index)
        world = parent @ local_transform(node)
        if "mesh" in node:
            mesh = record(doc.get("meshes", []), node["mesh"])
            require(bool(mesh.get("primitives")), "Empty mesh")
            found.append((index, world, mesh))
        for child in node.get("children", []):
            walk(child, world, depth + 1)
    for root in doc["scenes"][0].get("nodes", []):
        walk(root, np.eye(4), 0)
    require(bool(found) and len(found) <= 1024, "Empty or oversized scene")
    require(len(visited) == len(nodes), "Unreferenced scene nodes are unsupported")
    return found


def primitive_arrays(doc, binary, primitive):
    require(primitive.get("mode", 4) == 4, "Only triangles supported")
    attrs = primitive.get("attributes", {})
    if "TANGENT" in attrs:
        raise UnsupportedMesh("Tangent-space preservation is not verified; refusing TANGENT")
    require(set(attrs) <= {"POSITION", "NORMAL", "TEXCOORD_0", "TEXCOORD_1", "COLOR_0"}, "Unsupported vertex attribute")
    vertices = accessor(doc, binary, attrs.get("POSITION"))
    require(vertices.shape[1] == 3 and vertices.dtype.kind == "f", "Invalid positions")
    indices = accessor(doc, binary, primitive["indices"]) if "indices" in primitive else np.arange(len(vertices), dtype=np.uint32)[:, None]
    require(indices.shape[1] == 1 and indices.dtype.kind == "u" and len(indices) % 3 == 0
            and indices.max() < len(vertices), "Invalid triangle indices")
    faces = indices.reshape((-1, 3))
    require(len(np.unique(faces)) == len(vertices), "Unreferenced vertices could falsify rendered bounds")
    triangles = vertices[faces].astype(float)
    require(np.all(np.linalg.norm(np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0]), axis=1) > 0), "Degenerate triangles")
    for key, value in attrs.items():
        data = accessor(doc, binary, value)
        require(len(data) == len(vertices), "Attribute count mismatch")
        if key == "NORMAL":
            require(data.shape[1] == 3 and data.dtype.kind == "f"
                    and np.all(np.abs(np.linalg.norm(data, axis=1)-1) <= 1e-4), "Invalid normals")
        if key.startswith("TEXCOORD"):
            require(data.shape[1] == 2 and data.dtype.kind == "f", "Invalid UVs")
        if key == "COLOR_0":
            require(data.shape[1] in (3, 4) and data.dtype.kind == "f"
                    and np.all((data >= 0) & (data <= 1)), "Invalid vertex colors")
    if "material" in primitive:
        material = record(doc.get("materials", []), primitive["material"])
        def texture_coordinates(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key.endswith("Texture"):
                        channel = child.get("texCoord", 0)
                        require(type(channel) is int and f"TEXCOORD_{channel}" in attrs, "Material texture has no matching UV channel")
                    texture_coordinates(child)
        texture_coordinates(material)
    return vertices.astype(float), faces


def validate_features(doc, binary):
    if any(doc.get(k) for k in ("animations", "skins", "extensionsUsed", "extensionsRequired")):
        raise UnsupportedMesh("Animated/skinned/extended GLB is unsupported")
    def visit(value):
        if isinstance(value, dict):
            if any(k in value for k in ("extensions", "targets", "skin", "weights")):
                raise UnsupportedMesh("Extensions, skins and morph targets are unsupported")
            for v in value.values(): visit(v)
        elif isinstance(value, list):
            for v in value: visit(v)
    visit(doc)
    for image in doc.get("images", []):
        require("uri" not in image and image.get("mimeType") in ("image/png", "image/jpeg"), "Embedded PNG/JPEG required")
        data = view_bytes(doc, binary, image.get("bufferView"))
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            try:
                with Image.open(io.BytesIO(data)) as decoded:
                    require(decoded.width * decoded.height <= 16_000_000, "Texture exceeds pixel limit")
                    require(decoded.format == {"image/png": "PNG", "image/jpeg": "JPEG"}[image["mimeType"]]
                            and getattr(decoded, "n_frames", 1) == 1, "Invalid texture MIME/animation")
                    decoded.load()
            except (Image.DecompressionBombWarning, Image.DecompressionBombError):
                raise BindingError("Unsafe texture dimensions") from None
    for texture in doc.get("textures", []):
        record(doc.get("images", []), texture.get("source"))
        if "sampler" in texture: record(doc.get("samplers", []), texture["sampler"])
    for material in doc.get("materials", []):
        if "normalTexture" in material:
            raise UnsupportedMesh("Normal-map tangent basis under nonuniform scale is unverified")
        def textures(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key.endswith("Texture"):
                        record(doc.get("textures", []), child.get("index"))
                    textures(child)
        textures(material)
        require(material.get("alphaMode", "OPAQUE") in ("OPAQUE", "MASK", "BLEND"), "Invalid alpha mode")
        require(type(material.get("doubleSided", False)) is bool, "Invalid doubleSided")
        pbr = material.get("pbrMetallicRoughness", {})
        factors = pbr.get("baseColorFactor", [1]*4) + material.get("emissiveFactor", [0]*3)
        require(len(pbr.get("baseColorFactor", [1]*4)) == 4
                and len(material.get("emissiveFactor", [0]*3)) == 3, "Invalid material color shape")
        factors += [pbr.get("metallicFactor", 1), pbr.get("roughnessFactor", 1),
                    material.get("occlusionTexture", {}).get("strength", 1)]
        require(all(type(x) in (int, float) and np.isfinite(x) and 0 <= x <= 1 for x in factors), "Invalid PBR factors")
