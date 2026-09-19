"""POST /solve in the Worker's hydrated shape (workers/src/lib/contracts.ts: SolveRequest →
SolveResponse), translated to and from the OR-Tools solver in app/solver.py.

  { schemaVersion, room: RoomCapture v1, candidates: [Object v1], fixed: [Placement v1],
    plan: ConstraintPlan v1 }
  → { placements: [Placement v1], objective, infeasible, honoured, ignored }

Everything here is in the room's capture frame (metres) except the solver call, which sees
integer centimetres with the room's floor centre at the origin. A constraint kind the solver
doesn't implement is ignored and named, never a failure (the plan is an open list).
"""

from __future__ import annotations

import uuid

from .fit import Room, Vec, dot
from .solver import solve as run_solve

SEATING = ("sofa", "couch", "chair", "armchair", "bench")
FACING = {0: "south", 90: "east", 180: "north", 270: "west"}


def _side(normal_in: Vec) -> str:
    nx, nz = normal_in
    if abs(nz) >= abs(nx):
        return "north" if nz > 0 else "south"
    return "west" if nx > 0 else "east"


class Frame:
    """The room's axis-aligned inner rectangle and its floor centre, capture frame → solver frame."""

    def __init__(self, capture: dict):
        self.room = Room(capture)
        walls = list(self.room.walls.values())
        faces: dict[str, list[float]] = {"north": [], "south": [], "east": [], "west": []}
        self.sides: dict[str, str] = {}
        for w in walls:
            side = _side(w.normal_in)
            self.sides[w.id] = side
            face = w.inner_face()
            faces[side].append(face[1] if side in ("north", "south") else face[0])
        xs = [w.center[0] + s * w.along[0] * w.length / 2 for w in walls for s in (-1, 1)]
        zs = [w.center[1] + s * w.along[1] * w.length / 2 for w in walls for s in (-1, 1)]
        self.min_x = max(faces["west"]) if faces["west"] else min(xs)
        self.max_x = min(faces["east"]) if faces["east"] else max(xs)
        self.min_z = max(faces["north"]) if faces["north"] else min(zs)
        self.max_z = min(faces["south"]) if faces["south"] else max(zs)
        self.cx = (self.min_x + self.max_x) / 2
        self.cz = (self.min_z + self.max_z) / 2
        self.floor_y = self.room.floor_y

    def cm(self, x: float, z: float) -> tuple[int, int]:
        return round((x - self.cx) * 100), round((z - self.cz) * 100)

    def metres(self, x_cm: int, z_cm: int) -> tuple[float, float]:
        return round(x_cm / 100 + self.cx, 4), round(z_cm / 100 + self.cz, 4)

    def bounds(self) -> dict:
        return {"minX": round((self.min_x - self.cx) * 100), "maxX": round((self.max_x - self.cx) * 100),
                "minZ": round((self.min_z - self.cz) * 100), "maxZ": round((self.max_z - self.cz) * 100)}

    def openings(self) -> tuple[list[dict], list[dict]]:
        b = self.bounds()
        doors, windows = [], []
        for o in self.room.openings:
            side = self.sides[o.wall.id]
            cx, cz = self.cm(*o.center)
            half = round(o.width * 50) + 2
            depth = round(o.width * 100) + 5
            if o.kind == "door":
                keep = (
                    {"minX": cx - half, "maxX": cx + half, "minZ": b["maxZ"] - depth, "maxZ": b["maxZ"]} if side == "south"
                    else {"minX": cx - half, "maxX": cx + half, "minZ": b["minZ"], "maxZ": b["minZ"] + depth} if side == "north"
                    else {"minX": b["maxX"] - depth, "maxX": b["maxX"], "minZ": cz - half, "maxZ": cz + half} if side == "east"
                    else {"minX": b["minX"], "maxX": b["minX"] + depth, "minZ": cz - half, "maxZ": cz + half}
                )
                doors.append({"id": o.id, "keepOut": keep, "side": side})
            elif o.kind == "window":
                on = b["minZ"] if side == "north" else b["maxZ"] if side == "south" else b["maxX"] if side == "east" else b["minX"]
                windows.append({"id": o.id, "xCm": cx if side in ("north", "south") else on,
                                "zCm": on if side in ("north", "south") else cz, "widthCm": round(o.width * 100), "side": side})
        return doors, windows

    def zone(self, opening_id: str, margin_cm: int = 60) -> dict | None:
        """A keep_clear rectangle in front of an opening, for the solver."""
        doors, windows = self.openings()
        b = self.bounds()
        for d in doors:
            if d["id"] == opening_id:
                k = d["keepOut"]
                return {"minX": k["minX"] - margin_cm, "maxX": k["maxX"] + margin_cm,
                        "minZ": max(b["minZ"], k["minZ"] - margin_cm), "maxZ": min(b["maxZ"], k["maxZ"] + margin_cm)}
        for w in windows:
            half = w["widthCm"] // 2
            if w["id"] == opening_id:
                s = w["side"]
                return (
                    {"minX": w["xCm"] - half, "maxX": w["xCm"] + half, "minZ": b["minZ"], "maxZ": b["minZ"] + margin_cm} if s == "north"
                    else {"minX": w["xCm"] - half, "maxX": w["xCm"] + half, "minZ": b["maxZ"] - margin_cm, "maxZ": b["maxZ"]} if s == "south"
                    else {"minX": b["maxX"] - margin_cm, "maxX": b["maxX"], "minZ": w["zCm"] - half, "maxZ": w["zCm"] + half} if s == "east"
                    else {"minX": b["minX"], "maxX": b["minX"] + margin_cm, "minZ": w["zCm"] - half, "maxZ": w["zCm"] + half}
                )
        return None


def solve_hydrated(body: dict) -> dict:
    if body.get("schemaVersion", 1) != 1:
        raise ValueError(f"SolveRequest schemaVersion {body.get('schemaVersion')}, expected 1 — ask Thomas")
    frame = Frame(body["room"])
    candidates = {o["objectId"]: o for o in body.get("candidates") or []}
    fixed = list(body.get("fixed") or [])
    plan = body.get("plan") or {}
    b = frame.bounds()
    doors, windows = frame.openings()

    # Objects: fixed placements stay; other candidates are movable and start at the room centre.
    objects: list[dict] = []
    placements_by_object: dict[str, dict] = {}
    fixed_ids = set()
    for p in fixed:
        obj = candidates.get(p["objectId"]) or _from_room(body["room"], p["objectId"])
        if not obj:
            continue
        x, z = frame.cm(p["p"][0], p["p"][2])
        rot = round(float(p.get("yawDeg", 0)) / 90) * 90 % 360
        bb = obj["bboxMeters"]
        objects.append({"id": p["objectId"], "widthCm": round(bb["w"] * 100), "depthCm": round(bb["d"] * 100),
                        "xCm": x, "zCm": z, "rotDeg": rot, "movable": False})
        placements_by_object[p["objectId"]] = p
        fixed_ids.add(p["objectId"])
    for oid, obj in candidates.items():
        if oid in fixed_ids:
            continue
        bb = obj.get("bboxMeters") or {}
        if not (bb.get("w") and bb.get("d")):
            continue
        objects.append({"id": oid, "widthCm": round(bb["w"] * 100), "depthCm": round(bb["d"] * 100),
                        "xCm": 0, "zCm": 0, "rotDeg": 0, "movable": True})
    if not objects:
        raise ValueError("nothing to place: no candidates with bboxMeters")

    # Constraints → rules. Unknown kinds are ignored and named.
    rules: list[dict] = []
    honoured: list[str] = []
    ignored: list[str] = []
    close_pairs: list[list] = []
    walkway = 60
    n = 0
    for c in plan.get("constraints") or []:
        kind = c.get("kind")
        n += 1
        rid = f"c{n}"
        if kind == "min_clearance":
            walkway = max(walkway, round(float(c["meters"]) * 100))
            honoured.append(kind)
        elif kind == "against_wall" and c.get("objectId") in {o["id"] for o in objects}:
            side = frame.sides.get(c.get("wallId") or "", "any")
            rules.append({"id": rid, "type": "against_wall", "a": c["objectId"], "wall": side, "priority": "should", "weight": 8})
            honoured.append(kind)
        elif kind == "near" and c.get("objectId") in {o["id"] for o in objects} and c.get("otherObjectId") in {o["id"] for o in objects}:
            rules.append({"id": rid, "type": "near", "a": c["objectId"], "b": {"object": c["otherObjectId"]},
                          "maxCm": max(20, round(float(c["maxMeters"]) * 100)), "priority": "should", "weight": 6})
            close_pairs.append([c["objectId"], c["otherObjectId"], 20])
            honoured.append(kind)
        elif kind == "keep_clear":
            rect = frame.zone(str(c.get("openingId")))
            if rect:
                rules.append({"id": rid, "type": "keep_clear", "zone": {"rect": rect}, "priority": "must"})
                honoured.append(kind)
            else:
                ignored.append(f"{kind}: unknown opening {c.get('openingId')}")
        else:
            ignored.append(str(kind))

    objective = plan.get("objective")
    movable = [o for o in objects if o["movable"]]
    if objective == "maximize_walkway":
        walkway = max(walkway, 90)
    elif objective in ("maximize_free_floor", "minimize_wall_gap"):
        for o in movable:
            n += 1
            rules.append({"id": f"o{n}", "type": "against_wall", "a": o["id"], "wall": "any", "priority": "should", "weight": 5})
    elif objective == "group_seating":
        seating = [o for o in movable if any(k in _category(candidates, o["id"]) for k in SEATING)]
        for i, a in enumerate(seating):
            for b2 in seating[i + 1:]:
                n += 1
                rules.append({"id": f"o{n}", "type": "near", "a": a["id"], "b": {"object": b2["id"]}, "maxCm": 150, "priority": "should", "weight": 5})
                close_pairs.append([a["id"], b2["id"], 20])

    request = {
        "room": {"boundsCm": b, "doors": [{"id": d["id"], "keepOut": d["keepOut"]} for d in doors], "windows": windows,
                 "walls": [{"id": wid, "side": side} for wid, side in frame.sides.items()]},
        "objects": objects,
        "rules": rules,
        "settings": {"walkwayCm": walkway, "timeLimitMs": 3000 if len(objects) > 8 else 2000, "closePairs": close_pairs},
    }
    result = run_solve(request)

    if result["status"] in ("INFEASIBLE", "TIMEOUT"):
        return {"placements": fixed, "objective": 0, "infeasible": (
            "no arrangement satisfies the plan" if result["status"] == "INFEASIBLE" else "no layout found in time"),
            "honoured": honoured, "ignored": ignored}

    placements: list[dict] = []
    for p in result["placements"]:
        if p["id"] in fixed_ids:
            placements.append(placements_by_object[p["id"]])
            continue
        x, z = frame.metres(p["xCm"], p["zCm"])
        placements.append({"placementId": str(uuid.uuid4()), "objectId": p["id"], "p": [x, round(frame.floor_y, 4), z],
                           "yawDeg": float(p["rotDeg"]), "scale": 1.0, "lockedToWallId": None, "flags": []})
    total = len(result["satisfied"]) + len(result["violated"])
    return {
        "placements": placements,
        "objective": round(len(result["satisfied"]) / total, 3) if total else 1.0,
        "infeasible": None,
        "honoured": honoured,
        "ignored": ignored,
        "solveMs": result["solveMs"],
        "movedCm": result["movedCm"],
    }


def _category(candidates: dict, object_id: str) -> str:
    o = candidates.get(object_id) or {}
    return f"{o.get('category', '')} {o.get('name', '')}".lower()


def _from_room(room: dict, object_id: str) -> dict | None:
    """A detected RoomCapture object as a stand-in Object v1 (bboxMeters only)."""
    for o in room.get("objects") or []:
        if str(o.get("id") or o.get("identifier")) == object_id:
            d = o.get("dimensions")
            d = [d["x"], d["y"], d["z"]] if isinstance(d, dict) else list(d)
            return {"objectId": object_id, "category": o.get("category", ""), "bboxMeters": {"w": d[0], "h": d[1], "d": d[2]}}
    return None
