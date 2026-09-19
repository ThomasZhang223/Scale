"""POST /solve — the layout solver, as a pure function over the contract's shapes.

OR-Tools CP-SAT places rectangles in a room so that every hard rule holds and as many
soft rules as possible, while moving things as little as possible. It only ever sees
integer centimetres in a frame where the room's main walls are on the axes, and it never
sees names or request text: the Worker translates both ways (docs/agent/08_PROTOCOL.md).

Rotation: front faces +Z at 0°, +X at 90°, -Z at 180°, -X at 270°.
"""

from __future__ import annotations

import os
import time

from ortools.sat.python import cp_model

ROTATIONS = (0, 90, 180, 270)
NEAR_PENALTY_PER_CM = 20  # × weight, per cm of slack on a soft near/far_from rule
FACING_PENALTY = 200  # × weight, when a soft facing rule is unmet
ROTATION_CHANGE_COST = 25
FLIP_EXTRA_COST = 50
MAX_OBJECTS = 40
SEED = 7

DIRECTION_SIDE = {"north": 0, "east": 1, "south": 2, "west": 3}  # rotation index whose front faces that wall's opposite


def half(n: int) -> int:
    """Half a size, rounded up: a 1 cm-conservative footprint keeps every check honest."""
    return (int(n) + 1) // 2


class _Obj:
    def __init__(self, m: cp_model.CpModel, o: dict, bounds: dict):
        self.id = o["id"]
        self.w = int(o["widthCm"])
        self.d = int(o["depthCm"])
        self.x0 = int(o["xCm"])
        self.z0 = int(o["zCm"])
        self.rot0 = int(o.get("rotDeg", 0)) % 360
        if self.rot0 not in ROTATIONS:
            raise ValueError(f"object {self.id}: rotDeg {self.rot0} is not a multiple of 90; snap it before solving")
        self.k0 = ROTATIONS.index(self.rot0)
        self.movable = bool(o.get("movable", True))
        self.x = m.NewIntVar(bounds["minX"], bounds["maxX"], f"x_{self.id}")
        self.z = m.NewIntVar(bounds["minZ"], bounds["maxZ"], f"z_{self.id}")
        self.r = [m.NewBoolVar(f"r{k}_{self.id}") for k in range(4)]
        m.AddExactlyOne(self.r)
        self.upright = m.NewBoolVar(f"up_{self.id}")
        m.Add(self.upright == self.r[0] + self.r[2])
        if not self.movable:
            m.Add(self.x == self.x0)
            m.Add(self.z == self.z0)
            m.Add(self.r[self.k0] == 1)

    def half_sizes(self, upright: bool) -> tuple[int, int]:
        return (half(self.w), half(self.d)) if upright else (half(self.d), half(self.w))


def solve(request: dict) -> dict:
    started = time.perf_counter()
    room = request["room"]
    bounds = room["boundsCm"]
    settings = request.get("settings") or {}
    walkway = int(settings.get("walkwayCm", 60))
    time_limit_ms = int(settings.get("timeLimitMs", 2000))
    rules = list(request.get("rules") or [])

    # keep_clear walkway raises the walkway for this solve; window zones become obstacles.
    obstacles: list[dict] = [{"id": f"door:{d['id']}", **d["keepOut"]} for d in room.get("doors") or []]
    for r in rules:
        if r["type"] == "keep_clear":
            zone = r.get("zone")
            if zone == "walkway":
                walkway = max(walkway, int(r.get("marginCm", walkway)))
            elif isinstance(zone, dict) and "rect" in zone:
                obstacles.append({"id": r["id"], **zone["rect"]})

    m = cp_model.CpModel()
    objs = [_Obj(m, o, bounds) for o in request["objects"]]
    if len(objs) > MAX_OBJECTS:
        raise ValueError(f"{len(objs)} objects; the limit is {MAX_OBJECTS}")
    by_id = {o.id: o for o in objs}

    # Half sizes as linear expressions in `upright`, so one constraint covers both orientations.
    for o in objs:
        hw_u, hd_u = o.half_sizes(True)
        hw_r, hd_r = o.half_sizes(False)
        o.hw = hw_r + (hw_u - hw_r) * o.upright
        o.hd = hd_r + (hd_u - hd_r) * o.upright
        # ---- walls: the footprint stays inside the room ----
        m.Add(o.x - o.hw >= bounds["minX"])
        m.Add(o.x + o.hw <= bounds["maxX"])
        m.Add(o.z - o.hd >= bounds["minZ"])
        m.Add(o.z + o.hd <= bounds["maxZ"])

    # ---- separation, pair by pair ----
    # A walkway between any two pieces, except pairs the caller says belong together (a chair
    # at its table, a coffee table before the sofa), which only need their own small gap.
    close: dict[frozenset, int] = {}
    for pair in settings.get("closePairs") or []:
        a, b, gap = pair
        close[frozenset((a, b))] = int(gap)

    def separated(a, b_x, b_hw, b_z, b_hd, gap: int, name: str):
        lits = [m.NewBoolVar(f"{name}_{k}") for k in range(4)]
        m.Add(a.x + a.hw + gap <= b_x - b_hw).OnlyEnforceIf(lits[0])
        m.Add(b_x + b_hw + gap <= a.x - a.hw).OnlyEnforceIf(lits[1])
        m.Add(a.z + a.hd + gap <= b_z - b_hd).OnlyEnforceIf(lits[2])
        m.Add(b_z + b_hd + gap <= a.z - a.hd).OnlyEnforceIf(lits[3])
        m.AddBoolOr(lits)

    for i, oi in enumerate(objs):
        for oj in objs[i + 1:]:
            if not oi.movable and not oj.movable:
                continue  # fixed things are where they are; don't let them make the model infeasible
            gap = close.get(frozenset((oi.id, oj.id)), walkway)
            separated(oi, oj.x, oj.hw, oj.z, oj.hd, gap, f"sep_{oi.id}_{oj.id}")
        # Keep-outs are already clearance zones: a footprint may touch their edge, never enter.
        if oi.movable:
            for ob in obstacles:
                cx = (int(ob["minX"]) + int(ob["maxX"])) // 2
                cz = (int(ob["minZ"]) + int(ob["maxZ"])) // 2
                separated(oi, cx, (int(ob["maxX"]) - int(ob["minX"])) // 2, cz, (int(ob["maxZ"]) - int(ob["minZ"])) // 2, 0, f"ob_{oi.id}_{ob['id']}")

    # ---- rules ----
    objective: list = []
    assumptions: list[tuple[cp_model.IntVar, str]] = []
    soft: list[dict] = []  # {ruleId, kind, slack|unmet}
    span = max(bounds["maxX"] - bounds["minX"], bounds["maxZ"] - bounds["minZ"]) * 2

    def abs_diff(expr, name):
        v = m.NewIntVar(0, span, name)
        m.AddAbsEquality(v, expr)
        return v

    def point_of(ref, name):
        """A rule target: another object's variables, or a fixed point."""
        if isinstance(ref, dict) and "object" in ref:
            o = by_id.get(ref["object"])
            if o is None:
                raise ValueError(f"{name}: unknown object {ref['object']}")
            return o.x, o.z
        if isinstance(ref, dict) and "point" in ref:
            return int(ref["point"][0]), int(ref["point"][1])
        raise ValueError(f"{name}: target must be {{object}} or {{point}}")

    for r in rules:
        rid = r["id"]
        must = r.get("priority", "must") == "must"
        weight = int(r.get("weight", 1))
        if r["type"] == "keep_clear":
            continue
        a = by_id.get(r.get("a"))
        if a is None:
            raise ValueError(f"{rid}: unknown object {r.get('a')}")
        lit = m.NewBoolVar(f"rule_{rid}")
        if must:
            assumptions.append((lit, rid))
        elif r["type"] in ("pin", "against_wall"):
            # Soft all-or-nothing rules: pay for breaking them, and report it.
            objective.append(weight * FACING_PENALTY * lit.Not())
            soft.append({"ruleId": rid, "unmet": lit.Not()})

        if r["type"] == "pin":
            m.Add(a.x == a.x0).OnlyEnforceIf(lit)
            m.Add(a.z == a.z0).OnlyEnforceIf(lit)
            m.Add(a.r[a.k0] == 1).OnlyEnforceIf(lit)

        elif r["type"] == "against_wall":
            side = r.get("wall", "any")
            hw_u, hd_u = a.half_sizes(True)
            options = {
                "north": (a.r[0], a.z == bounds["minZ"] + hd_u),
                "south": (a.r[2], a.z == bounds["maxZ"] - hd_u),
                "west": (a.r[1], a.x == bounds["minX"] + hd_u),
                "east": (a.r[3], a.x == bounds["maxX"] - hd_u),
            }
            if side == "any":
                picks = []
                for name, (rot, eq) in options.items():
                    b = m.NewBoolVar(f"{rid}_{name}")
                    m.AddImplication(b, rot)
                    m.Add(eq).OnlyEnforceIf(b)
                    picks.append(b)
                m.AddBoolOr(picks).OnlyEnforceIf(lit)
            elif side in options:
                rot, eq = options[side]
                m.AddImplication(lit, rot)
                m.Add(eq).OnlyEnforceIf(lit)
            else:
                raise ValueError(f"{rid}: wall must be north/south/east/west/any")

        elif r["type"] in ("near", "far_from"):
            bx, bz = point_of(r.get("b"), f"{rid}.b")
            dist = abs_diff(a.x - bx, f"{rid}_dx") + abs_diff(a.z - bz, f"{rid}_dz")
            if r["type"] == "near":
                limit = int(r["maxCm"])
                if must:
                    m.Add(dist <= limit).OnlyEnforceIf(lit)
                else:
                    slack = m.NewIntVar(0, span, f"{rid}_slack")
                    m.Add(dist <= limit + slack)
                    objective.append(weight * NEAR_PENALTY_PER_CM * slack)
                    soft.append({"ruleId": rid, "slack": slack})
            else:
                limit = int(r["minCm"])
                if must:
                    m.Add(dist >= limit).OnlyEnforceIf(lit)
                else:
                    slack = m.NewIntVar(0, span, f"{rid}_slack")
                    m.Add(dist + slack >= limit)
                    objective.append(weight * NEAR_PENALTY_PER_CM * slack)
                    soft.append({"ruleId": rid, "slack": slack})

        elif r["type"] == "facing":
            tx, tz = point_of(r.get("target"), f"{rid}.target")
            adx = abs_diff(tx - a.x, f"{rid}_adx")
            adz = abs_diff(tz - a.z, f"{rid}_adz")
            # The target lies in the quadrant the front faces.
            m.Add(tz - a.z >= adx).OnlyEnforceIf([lit, a.r[0]])
            m.Add(tx - a.x >= adz).OnlyEnforceIf([lit, a.r[1]])
            m.Add(a.z - tz >= adx).OnlyEnforceIf([lit, a.r[2]])
            m.Add(a.x - tx >= adz).OnlyEnforceIf([lit, a.r[3]])
            if not must:
                objective.append(weight * FACING_PENALTY * lit.Not())
                soft.append({"ruleId": rid, "unmet": lit.Not()})
        else:
            raise ValueError(f"{rid}: unknown rule type {r['type']}")

    # ---- objective: move as little as possible ----
    moves = []
    for o in objs:
        if not o.movable:
            continue
        mx = abs_diff(o.x - o.x0, f"mx_{o.id}")
        mz = abs_diff(o.z - o.z0, f"mz_{o.id}")
        moves.append(mx + mz)
        objective.append(ROTATION_CHANGE_COST * o.r[o.k0].Not())
        objective.append(FLIP_EXTRA_COST * o.r[(o.k0 + 2) % 4])
    m.Minimize(sum(objective) + sum(moves))
    if assumptions:
        m.AddAssumptions([lit for lit, _ in assumptions])

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_ms / 1000
    solver.parameters.num_workers = int(os.environ.get("SOLVER_WORKERS", "1"))
    solver.parameters.random_seed = SEED
    status = solver.Solve(m)
    elapsed_ms = round((time.perf_counter() - started) * 1000)

    if status == cp_model.INFEASIBLE:
        core = set(solver.SufficientAssumptionsForInfeasibility())
        conflicts = [rid for lit, rid in assumptions if lit.Index() in core] or [rid for _, rid in assumptions]
        return {"status": "INFEASIBLE", "placements": [], "satisfied": [], "violated": [], "conflicts": conflicts,
                "movedCm": 0, "solveMs": elapsed_ms}
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"status": "TIMEOUT", "placements": [], "satisfied": [], "violated": [], "conflicts": [],
                "movedCm": 0, "solveMs": elapsed_ms}

    placements = []
    moved = 0
    for o in objs:
        x, z = solver.Value(o.x), solver.Value(o.z)
        k = next(i for i in range(4) if solver.Value(o.r[i]))
        placements.append({"id": o.id, "xCm": x, "zCm": z, "rotDeg": ROTATIONS[k]})
        moved += abs(x - o.x0) + abs(z - o.z0)
    violated = []
    for s in soft:
        if "slack" in s and solver.Value(s["slack"]) > 0:
            violated.append({"ruleId": s["ruleId"], "amountCm": solver.Value(s["slack"])})
        elif "unmet" in s and solver.Value(s["unmet"]):
            violated.append({"ruleId": s["ruleId"], "amountCm": True})
    violated_ids = {v["ruleId"] for v in violated}
    satisfied = [r["id"] for r in rules if r["type"] != "keep_clear" and r["id"] not in violated_ids]
    return {
        "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        "placements": placements,
        "satisfied": satisfied,
        "violated": violated,
        "conflicts": [],
        "movedCm": moved,
        "solveMs": elapsed_ms,
    }
