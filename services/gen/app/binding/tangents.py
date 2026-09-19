"""Angle-weighted tangent frames built from final, serialized geometry.

glTF reconstructs B as cross(N, T.xyz) * T.w. Opposite handedness corners
cannot share one vertex; duplicate those vertices without changing any corner's
position, normal, UV, color or material. This is not a MikkTSpace implementation.
"""
import numpy as np

from .glb import require


def tangent_frames(positions, normals, uv, faces):
    """Return unit VEC4 tangents, source vertex mapping and corrected indices."""
    tri, tex = positions[faces], uv[faces].astype(float)
    edge1, edge2 = tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    duv1, duv2 = tex[:, 1] - tex[:, 0], tex[:, 2] - tex[:, 0]
    det = duv1[:, 0] * duv2[:, 1] - duv1[:, 1] * duv2[:, 0]
    uv_area_scale = np.linalg.norm(duv1, axis=1) * np.linalg.norm(duv2, axis=1)
    require(np.all(np.abs(det) > 1e-12 * uv_area_scale),
            "Degenerate normal-map UV triangle: cannot construct tangent basis")
    tangent = (edge1 * duv2[:, 1, None] - edge2 * duv1[:, 1, None]) / det[:, None]
    bitangent = (edge2 * duv1[:, 0, None] - edge1 * duv2[:, 0, None]) / det[:, None]
    n = normals[faces].astype(float)
    n /= np.linalg.norm(n, axis=2)[..., None]
    corner_t = tangent[:, None, :] - n * np.sum(n * tangent[:, None, :], axis=2)[..., None]
    lengths = np.linalg.norm(corner_t, axis=2)
    require(np.isfinite(lengths).all() and np.all(lengths > 1e-12 * np.linalg.norm(tangent, axis=1)[:, None]),
            "Normal-map tangent is undefined against final normal")
    corner_t /= lengths[..., None]
    handedness = np.sum(np.cross(n, corner_t) * bitangent[:, None, :], axis=2)
    require(np.isfinite(handedness).all() and np.all(np.abs(handedness) >
            1e-12 * np.linalg.norm(bitangent, axis=1)[:, None]), "Normal-map bitangent is undefined")
    signs = np.where(handedness < 0, -1, 1)

    low, high = np.full(len(positions), 2), np.full(len(positions), -2)
    np.minimum.at(low, faces.ravel(), signs.ravel())
    np.maximum.at(high, faces.ravel(), signs.ravel())
    seams = np.flatnonzero(low != high)
    mapping = np.concatenate((np.arange(len(positions)), seams))
    require(len(mapping) <= 2_000_000, "Tangent seam vertex budget exceeded")
    duplicates = np.arange(len(positions))
    duplicates[seams] = np.arange(len(positions), len(mapping))
    indices = np.where(signs == low[faces], faces, duplicates[faces])
    vertex_sign = np.concatenate((low, high[seams]))

    # Corner-angle weighting avoids dependence on UV chart area/density.
    accumulated = np.zeros((len(mapping), 3))
    for corner in range(3):
        a = tri[:, (corner + 1) % 3] - tri[:, corner]
        b = tri[:, (corner + 2) % 3] - tri[:, corner]
        angle = np.arctan2(np.linalg.norm(np.cross(a, b), axis=1), np.sum(a * b, axis=1))
        np.add.at(accumulated, indices[:, corner], corner_t[:, corner] * angle[:, None])
    final_n = normals[mapping].astype(float)
    final_n /= np.linalg.norm(final_n, axis=1)[:, None]
    accumulated -= final_n * np.sum(final_n * accumulated, axis=1)[:, None]
    length = np.linalg.norm(accumulated, axis=1)
    require(np.isfinite(length).all() and np.all(length > 1e-12),
            "Conflicting normal-map tangents: cannot construct vertex basis")
    return np.column_stack((accumulated / length[:, None], vertex_sign)), mapping, indices
