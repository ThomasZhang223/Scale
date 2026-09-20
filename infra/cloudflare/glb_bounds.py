#!/usr/bin/env python3
"""Print the axis-aligned bounds of a GLB, in the file's own units, as one JSON line.

Used by seed-library.sh. Standard library only: no numpy, no trimesh.

  python3 glb_bounds.py path/to/model.glb
  -> {"min":[x,y,z],"max":[x,y,z],"extent":[w,h,d],"transformed":false,"primitives":3}

glTF 2.0 defines its units as metres, and this script never converts a unit: it reports what
the file says and nothing else. The caller decides whether the numbers are plausible.

How the bounds are taken: the POSITION accessor `min`/`max` of every mesh primitive that a scene
node reaches, unioned. glTF requires those two arrays on POSITION, so no vertex data is read.
If any node on the way carries a transform (matrix, or a non-identity translation, rotation or
scale), the eight corners of each primitive's box are pushed through the node's world matrix.
`transformed` in the output says whether that happened.

Fails loud (exit 1, message on stderr) on anything it cannot answer: not a GLB, no scene
nodes, a primitive without POSITION, a missing min/max, or a non-float POSITION accessor
(KHR_mesh_quantization changes what min/max mean, and a guess would be a silent unit error).
"""
import json
import struct
import sys


def die(msg):
    print(f"glb_bounds: {msg}", file=sys.stderr)
    sys.exit(1)


def read_json_chunk(path):
    with open(path, "rb") as f:
        head = f.read(12)
        if len(head) < 12:
            die(f"{path}: shorter than a GLB header")
        magic, version, length = struct.unpack("<4sII", head)
        if magic != b"glTF":
            die(f"{path}: first four bytes are {magic!r}, not 'glTF'")
        if version != 2:
            die(f"{path}: GLB version {version}, expected 2")
        chunk_head = f.read(8)
        if len(chunk_head) < 8:
            die(f"{path}: no first chunk")
        chunk_len, chunk_type = struct.unpack("<I4s", chunk_head)
        if chunk_type != b"JSON":
            die(f"{path}: first chunk is {chunk_type!r}, not JSON")
        return json.loads(f.read(chunk_len).decode("utf-8"))


def identity():
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def mul(a, b):
    """Column-major 4x4 product a*b, as glTF stores matrices."""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def node_matrix(node):
    """(matrix, has_transform) for one node."""
    if "matrix" in node:
        m = [float(v) for v in node["matrix"]]
        return m, m != identity()
    t = node.get("translation", [0.0, 0.0, 0.0])
    q = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    s = node.get("scale", [1.0, 1.0, 1.0])
    has = list(t) != [0.0, 0.0, 0.0] or list(q) != [0.0, 0.0, 0.0, 1.0] or list(s) != [1.0, 1.0, 1.0]
    x, y, z, w = q
    r = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0.0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0.0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
    m = [
        r[0] * s[0], r[1] * s[0], r[2] * s[0], 0.0,
        r[4] * s[1], r[5] * s[1], r[6] * s[1], 0.0,
        r[8] * s[2], r[9] * s[2], r[10] * s[2], 0.0,
        t[0], t[1], t[2], 1.0,
    ]
    return m, has


def apply(m, p):
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]


# ceiling: the box of the eight transformed corners is exact for translation and scale and
# conservative (never too small) for a rotation. A tight rotated bound would need the vertices.
def bounds(path):
    doc = read_json_chunk(path)
    nodes = doc.get("nodes", [])
    accessors = doc.get("accessors", [])
    meshes = doc.get("meshes", [])
    scenes = doc.get("scenes", [])
    if not nodes or not scenes:
        die(f"{path}: no scene nodes")
    roots = scenes[doc.get("scene", 0)].get("nodes", [])

    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    state = {"transformed": False, "primitives": 0}

    def visit(index, parent):
        node = nodes[index]
        local, has = node_matrix(node)
        if has:
            state["transformed"] = True
        world = mul(parent, local)
        if "mesh" in node:
            for prim in meshes[node["mesh"]].get("primitives", []):
                if "POSITION" not in prim.get("attributes", {}):
                    die(f"{path}: a primitive of mesh {node['mesh']} has no POSITION")
                acc = accessors[prim["attributes"]["POSITION"]]
                if acc.get("componentType") != 5126:
                    die(f"{path}: POSITION componentType {acc.get('componentType')}, not FLOAT (5126)")
                if "min" not in acc or "max" not in acc:
                    die(f"{path}: POSITION accessor has no min/max")
                state["primitives"] += 1
                for cx in (acc["min"][0], acc["max"][0]):
                    for cy in (acc["min"][1], acc["max"][1]):
                        for cz in (acc["min"][2], acc["max"][2]):
                            p = apply(world, [cx, cy, cz])
                            for i in range(3):
                                lo[i] = min(lo[i], p[i])
                                hi[i] = max(hi[i], p[i])
        for child in node.get("children", []):
            visit(child, world)

    for root in roots:
        visit(root, identity())
    if state["primitives"] == 0:
        die(f"{path}: no mesh primitive reachable from the scene")
    return {
        "min": lo,
        "max": hi,
        "extent": [hi[i] - lo[i] for i in range(3)],
        "transformed": state["transformed"],
        "primitives": state["primitives"],
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: glb_bounds.py <file.glb>", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(bounds(sys.argv[1])))
