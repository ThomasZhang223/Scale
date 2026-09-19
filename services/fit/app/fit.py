"""POST /fit — the validator, as pure functions over the contract's shapes.

Input: a RoomCapture v1, a list of Placement v1, and each placed object's bboxMeters.
Output: a FitReport v1 whose geometry can be drawn as-is.

Conventions, all from .claude/contracts.md and all in the room's capture frame: metres;
angles in degrees counter-clockwise seen from +Y, which is from +X toward -Z, the same
sense as three.js rotation.y; transforms are 16 floats, column-major, no transpose.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

EXPECTED_SCHEMA_VERSION = 1
CLEARANCE_M = 0.9  # walkway width, also the depth of the corridor kept clear at a door
WALL_GAP_MIN_M = 0.015  # closer than this counts as touching the wall (the solver works in whole cm)
WALL_GAP_MAX_M = 0.04  # further than this is deliberate, not "floating"
WINDOW_PATCH_DEPTH_M = 0.6  # floor in front of a window that direct light reaches
EDGE_SAMPLE_M = 0.02

Vec = tuple[float, float]


# ---------- vectors on the floor (x, z) ----------

def angle_deg(v: Vec) -> float:
    """Direction of a floor vector in the contract's sense (+X = 0°, -Z = 90°)."""
    return math.degrees(math.atan2(-v[1], v[0])) + 0.0  # + 0.0 turns -0.0 into 0.0


def direction(deg: float) -> Vec:
    a = math.radians(deg)
    return (math.cos(a), -math.sin(a))


def add(a: Vec, b: Vec, k: float = 1.0) -> Vec:
    return (a[0] + b[0] * k, a[1] + b[1] * k)


def sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1])


def dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1]


def norm(v: Vec) -> Vec:
    n = math.hypot(*v)
    return (v[0] / n, v[1] / n) if n else (1.0, 0.0)


def rotate(v: Vec, yaw_deg: float) -> Vec:
    """Rotate a floor vector by a yaw in the contract's sense."""
    c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    return (v[0] * c + v[1] * s, -v[0] * s + v[1] * c)


# ---------- the room ----------

@dataclass
class Wall:
    id: str
    center: Vec
    along: Vec  # unit vector down the wall's length (its local +X)
    normal_in: Vec  # unit normal pointing into the room
    length: float
    thickness: float

    def inner_face(self) -> Vec:
        return add(self.center, self.normal_in, self.thickness / 2)


@dataclass
class Opening:
    id: str
    kind: str
    wall: Wall
    center: Vec
    width: float
    height: float
    sill: float  # bottom edge above the floor
    hinge_side: str
    swing_deg: float


DEFAULT_WALL_THICKNESS_M = 0.1  # RoomPlan reports 0 for walls; RoomCapture v1 measures it


def _matrix(t) -> list:
    """16 floats, column-major: flat, or 4 columns of 4 (Swift's encoder does both)."""
    flat = [x for col in t for x in col] if t and isinstance(t[0], list) else list(t)
    if len(flat) != 16:
        raise ValueError(f"transform has {len(flat)} numbers, not 16")
    return flat


def _dims(d) -> list:
    return [d["x"], d["y"], d["z"]] if isinstance(d, dict) else list(d)[:3]


class Room:
    """RoomCapture v1 (the contract) or raw RoomPlan CapturedRoom JSON straight from the phone."""

    def __init__(self, capture: dict):
        version = capture.get("schemaVersion")
        if version is not None and version != EXPECTED_SCHEMA_VERSION:
            raise ValueError(f"RoomCapture schemaVersion {version}, expected {EXPECTED_SCHEMA_VERSION} — ask Thomas")
        walls_raw = capture.get("walls") or []
        if not walls_raw:
            raise ValueError("the room has no walls; nothing to check against")
        parsed = [(_matrix(w["transform"]), _dims(w["dimensions"])) for w in walls_raw]
        self.floor_y = min(m[13] - d[1] / 2 for m, d in parsed)
        polygon = (capture.get("floor") or {}).get("polygon") or [[m[12], m[14]] for m, _ in parsed]
        self.centroid: Vec = (
            sum(p[0] for p in polygon) / len(polygon),
            sum(p[1] for p in polygon) / len(polygon),
        )
        self.walls: dict[str, Wall] = {}
        for i, (w, (m, d)) in enumerate(zip(walls_raw, parsed)):
            wall_id = str(w.get("id") or w.get("identifier") or f"wall-{i}")
            center = (m[12], m[14])
            along = norm((m[0], m[2]))
            normal = norm((m[8], m[10]))
            if dot(normal, sub(self.centroid, center)) < 0:
                normal = (-normal[0], -normal[1])
            thickness = d[2] if d[2] > 0 else DEFAULT_WALL_THICKNESS_M
            self.walls[wall_id] = Wall(wall_id, center, along, normal, d[0], thickness)

        raw_openings = [(o, o.get("kind", "opening")) for o in capture.get("openings") or []]
        raw_openings += [(o, "door") for o in capture.get("doors") or []]
        raw_openings += [(o, "window") for o in capture.get("windows") or []]
        self.openings: list[Opening] = []
        for i, (o, kind) in enumerate(raw_openings):
            m = _matrix(o["transform"])
            d = _dims(o["dimensions"])
            center = (m[12], m[14])
            wall = self.walls.get(o.get("wallId")) if o.get("wallId") else None
            if wall is None and o.get("wallId"):
                raise ValueError(f"opening {o.get('id')} references unknown wallId {o.get('wallId')}")
            if wall is None:  # RoomPlan doesn't link openings to walls: take the nearest
                wall = min(self.walls.values(), key=lambda w: math.hypot(*sub(w.center, center)))
            self.openings.append(
                Opening(
                    id=str(o.get("id") or o.get("identifier") or f"{kind}-{i}"),
                    kind=kind,
                    wall=wall,
                    center=center,
                    width=d[0],
                    height=d[1],
                    sill=(m[13] - d[1] / 2) - self.floor_y,
                    hinge_side=o.get("hingeSide", "unknown"),
                    swing_deg=float(o.get("swingDeg") if o.get("swingDeg") is not None else (90 if kind == "door" else 0)),
                )
            )


# ---------- placements ----------

@dataclass
class Placed:
    placement_id: str
    center: Vec
    yaw_deg: float
    w: float
    h: float
    d: float

    def corners(self) -> list[Vec]:
        x_axis = rotate((1.0, 0.0), self.yaw_deg)
        z_axis = rotate((0.0, 1.0), self.yaw_deg)
        hw, hd = self.w / 2, self.d / 2
        return [
            add(add(self.center, x_axis, sx * hw), z_axis, sz * hd)
            for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))
        ]


def samples(polygon: list[Vec]) -> list[Vec]:
    """Corners plus points every 2 cm along the edges, for containment tests."""
    out: list[Vec] = []
    for i, a in enumerate(polygon):
        b = polygon[(i + 1) % len(polygon)]
        length = math.hypot(*sub(b, a))
        steps = max(1, int(length / EDGE_SAMPLE_M))
        for k in range(steps):
            t = k / steps
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def polygons_overlap(a: list[Vec], b: list[Vec]) -> bool:
    """Separating-axis test for two convex floor polygons."""
    for poly in (a, b):
        for i, p in enumerate(poly):
            q = poly[(i + 1) % len(poly)]
            axis = (-(q[1] - p[1]), q[0] - p[0])
            pa = [dot(v, axis) for v in a]
            pb = [dot(v, axis) for v in b]
            if max(pa) <= min(pb) + 1e-6 or max(pb) <= min(pa) + 1e-6:
                return False  # touching along an edge is not overlapping
    return True


def point_in_polygon(p: Vec, polygon: list[Vec]) -> bool:
    inside = False
    for i, a in enumerate(polygon):
        b = polygon[(i + 1) % len(polygon)]
        if (a[1] > p[1]) != (b[1] > p[1]):
            x = a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            if p[0] < x:
                inside = not inside
    return inside


# ---------- the four checks ----------

def door_swing(room: Room, placed: list[Placed]) -> list[dict]:
    out = []
    for door in (o for o in room.openings if o.kind == "door" and o.swing_deg > 0):
        wall = door.wall
        side = -1.0 if door.hinge_side in ("left", "unknown") else 1.0
        hinge = add(door.center, wall.along, side * door.width / 2)
        start_dir = (-side * wall.along[0], -side * wall.along[1])  # from the hinge toward the latch
        start = angle_deg(start_dir)
        # Sweep from the closed door toward the inside of the room.
        sign = 1.0 if abs(((angle_deg(wall.normal_in) - start + 180) % 360) - 180 - 90) < 1 else -1.0
        end = start + sign * door.swing_deg
        radius = door.width

        for p in placed:
            polygon = p.corners()
            depth = 0.0
            if point_in_polygon(hinge, polygon):
                depth = radius
            else:
                for s in samples(polygon):
                    v = sub(s, hinge)
                    dist = math.hypot(*v)
                    if dist > radius:
                        continue
                    rel = ((angle_deg(v) - start) * sign) % 360
                    if rel <= door.swing_deg:
                        depth = max(depth, radius - dist)
            if depth > 0:
                out.append(
                    violation(
                        "door_swing", "block", p.placement_id, depth,
                        f"blocks the door swing by {cm(depth)}",
                        {"type": "arc", "center": list(hinge), "radiusM": radius, "startDeg": start, "endDeg": end},
                    )
                )
    return out


def clearance(room: Room, placed: list[Placed]) -> list[dict]:
    """The corridor straight in through each door must stay clear: at least 90 cm wide and deep."""
    out = []
    for door in (o for o in room.openings if o.kind == "door"):
        corridor = patch(door, max(door.width, CLEARANCE_M), CLEARANCE_M)
        for p in placed:
            if polygons_overlap(p.corners(), corridor):
                depth = overlap_depth(p.corners(), corridor, door.wall.normal_in)
                if depth < 0.005:
                    continue  # a solver's whole-centimetre position grazing the corridor edge
                out.append(
                    violation(
                        "clearance", "block", p.placement_id, depth,
                        f"narrows the walkway through the door by {cm(depth)}",
                        {"type": "polyline", "points": [list(v) for v in corridor + [corridor[0]]]},
                    )
                )
    return out


def wall_gap(room: Room, placed: list[Placed]) -> list[dict]:
    """An object 1–4 cm off a wall is floating, not against it."""
    out = []
    for p in placed:
        corners = p.corners()
        best: tuple[float, Wall, Vec] | None = None
        for wall in room.walls.values():
            face = wall.inner_face()
            for c in corners:
                rel = sub(c, face)
                if abs(dot(rel, wall.along)) > wall.length / 2:
                    continue
                gap = dot(rel, wall.normal_in)
                if WALL_GAP_MIN_M <= gap <= WALL_GAP_MAX_M and (best is None or gap < best[0]):
                    best = (gap, wall, c)
        if best:
            gap, wall, corner = best
            foot = add(corner, wall.normal_in, -gap)
            out.append(
                violation(
                    "wall_gap", "warn", p.placement_id, gap,
                    f"floats {cm(gap)} off the wall",
                    {"type": "polyline", "points": [list(corner), list(foot)]},
                )
            )
    return out


def window_occlusion(room: Room, placed: list[Placed]) -> list[dict]:
    """Something taller than the sill standing in the light in front of a window."""
    out = []
    for window in (o for o in room.openings if o.kind == "window"):
        light = patch(window, window.width, WINDOW_PATCH_DEPTH_M)
        for p in placed:
            if p.h > window.sill and polygons_overlap(p.corners(), light):
                over = p.h - window.sill
                out.append(
                    violation(
                        "window_occlusion", "warn", p.placement_id, over,
                        f"blocks the window by {cm(over)} above the sill",
                        {"type": "polyline", "points": [list(v) for v in light + [light[0]]]},
                    )
                )
    return out


# ---------- helpers ----------

def patch(opening: Opening, width: float, depth: float) -> list[Vec]:
    """The floor rectangle just inside an opening: `width` along the wall, `depth` into the room."""
    wall = opening.wall
    face_center = add(opening.center, wall.normal_in, dot(sub(wall.inner_face(), opening.center), wall.normal_in))
    a = add(face_center, wall.along, -width / 2)
    b = add(face_center, wall.along, width / 2)
    return [a, b, add(b, wall.normal_in, depth), add(a, wall.normal_in, depth)]


def overlap_depth(polygon: list[Vec], corridor: list[Vec], inward: Vec) -> float:
    """How far across the corridor's width the object reaches, measured along the wall."""
    along = (inward[1], -inward[0])
    pa = [dot(v, along) for v in polygon]
    pc = [dot(v, along) for v in corridor]
    return max(0.0, min(max(pa), max(pc)) - max(min(pa), min(pc)))


def cm(m: float) -> str:
    return f"{round(m * 100)} cm"


def violation(kind: str, severity: str, placement_id: str, detail: float, message: str, geometry: dict) -> dict:
    return {
        "kind": kind,
        "severity": severity,
        "placementId": placement_id,
        "detailMeters": round(detail, 4),
        "message": message,
        "geometry": geometry,
    }


def load_placements(placements: list[dict], objects: dict[str, dict] | None) -> tuple[list[Placed], list[str]]:
    placed: list[Placed] = []
    warnings: list[str] = []
    for p in placements:
        bbox = p.get("bboxMeters") or (objects or {}).get(p["objectId"])
        if not bbox:
            raise ValueError(
                f"no bboxMeters for objectId {p['objectId']} — the Worker must inline each placed object's bboxMeters"
            )
        scale = p.get("scale", 1.0)
        if scale != 1.0:
            warnings.append(
                f"placement {p['placementId']} has scale {scale}; the normalisation contract requires 1.0 (a rescale upstream?)"
            )
        x, _y, z = p["p"]
        placed.append(Placed(p["placementId"], (x, z), float(p.get("yawDeg", 0.0)), bbox["w"], bbox["h"], bbox["d"]))
    return placed, warnings


def fit(capture: dict, placements: list[dict], objects: dict[str, dict] | None = None) -> dict:
    """FitReport v1 for a layout. Raises ValueError when the input can't be judged."""
    room = Room(capture)
    placed, warnings = load_placements(placements, objects)
    violations = door_swing(room, placed) + clearance(room, placed) + wall_gap(room, placed) + window_occlusion(room, placed)
    report = {
        "schemaVersion": 1,
        "ok": not any(v["severity"] == "block" for v in violations),
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "violations": violations,
    }
    if warnings:
        report["warnings"] = warnings  # optional field: adding one breaks nobody
    return report
