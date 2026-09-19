"""Solver tests: the 10 from apps/xr/docs/agent/02_LAYOUT_SOLVER.md plus S1–S4 from 09, now inside services/fit.
Run: python -m unittest discover -s tests -v"""

import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ.setdefault("UPSTREAM_TOKEN", "test-token")
from app.solver import solve, half  # noqa: E402

PIPELINE = os.path.join(HERE, "..", "..", "agent", "fixtures", "pipeline")

# The sample room in the solver frame: inner faces x ±205, z ±175; door keep-out x 35..125,
# z 85..175 (south wall); window on the north wall centred at x = -50, 120 wide.
ROOM = {
    "boundsCm": {"minX": -205, "maxX": 205, "minZ": -175, "maxZ": 175},
    "doors": [{"id": "d1", "keepOut": {"minX": 35, "maxX": 125, "minZ": 85, "maxZ": 175}}],
    "windows": [{"id": "win1", "xCm": -50, "zCm": -175, "widthCm": 120, "side": "north"}],
    "walls": [{"id": "n1", "side": "north"}, {"id": "s1", "side": "south"}, {"id": "e1", "side": "east"}, {"id": "w1", "side": "west"}],
}
OBJECTS = [
    {"id": "obj_sofa", "widthCm": 219, "depthCm": 102, "xCm": 0, "zCm": -124, "rotDeg": 0, "movable": True},
    {"id": "obj_chair", "widthCm": 83, "depthCm": 57, "xCm": 140, "zCm": 30, "rotDeg": 270, "movable": True},
    {"id": "obj_table", "widthCm": 100, "depthCm": 60, "xCm": 0, "zCm": 28, "rotDeg": 0, "movable": True},
    {"id": "obj_storage", "widthCm": 80, "depthCm": 40, "xCm": -185, "zCm": 80, "rotDeg": 90, "movable": True},
]
DOOR_POINT = [80, 175]


def request(rules, objects=OBJECTS, walkway=60):
    return {"room": ROOM, "objects": copy.deepcopy(objects), "rules": rules, "settings": {"walkwayCm": walkway, "timeLimitMs": 2000}}


def footprint(o, p):
    upright = p["rotDeg"] in (0, 180)
    hw, hd = (half(o["widthCm"]), half(o["depthCm"])) if upright else (half(o["depthCm"]), half(o["widthCm"]))
    return (p["xCm"] - hw, p["xCm"] + hw, p["zCm"] - hd, p["zCm"] + hd)


def assert_valid(tc, req, res):
    """Test 2 as a helper: recompute every footprint and check the hard rules."""
    objs = {o["id"]: o for o in req["objects"]}
    walkway = req["settings"]["walkwayCm"]
    close = {frozenset((a, b)): g for a, b, g in req["settings"].get("closePairs", [])}
    b = req["room"]["boundsCm"]
    boxes = {p["id"]: footprint(objs[p["id"]], p) for p in res["placements"]}
    tc.assertEqual(set(boxes), set(objs), "every object comes back")
    for pid, (x0, x1, z0, z1) in boxes.items():
        tc.assertGreaterEqual(x0, b["minX"], pid)
        tc.assertLessEqual(x1, b["maxX"], pid)
        tc.assertGreaterEqual(z0, b["minZ"], pid)
        tc.assertLessEqual(z1, b["maxZ"], pid)
        for d in req["room"]["doors"]:
            k = d["keepOut"]
            overlaps = x0 < k["maxX"] and x1 > k["minX"] and z0 < k["maxZ"] and z1 > k["minZ"]
            tc.assertFalse(overlaps, f"{pid} is in the door keep-out")
    ids = list(boxes)
    for i, a in enumerate(ids):
        for c in ids[i + 1:]:
            ax0, ax1, az0, az1 = boxes[a]
            cx0, cx1, cz0, cz1 = boxes[c]
            gap_x = max(cx0 - ax1, ax0 - cx1)
            gap_z = max(cz0 - az1, az0 - cz1)
            need = close.get(frozenset((a, c)), walkway)
            tc.assertTrue(gap_x >= need or gap_z >= need, f"{a} and {c} closer than {need} cm")


def manhattan(p, q):
    return abs(p[0] - q[0]) + abs(p[1] - q[1])


def placement(res, oid):
    return next(p for p in res["placements"] if p["id"] == oid)


class Solver(unittest.TestCase):
    def test_01_prototype_request(self):
        req = request([
            {"id": "r1", "type": "against_wall", "a": "obj_sofa", "wall": "north", "priority": "must"},
            {"id": "r2", "type": "near", "a": "obj_chair", "b": {"object": "obj_table"}, "maxCm": 120, "priority": "must"},
        ])
        res = solve(req)
        self.assertEqual(res["status"], "OPTIMAL")
        self.assertLess(res["solveMs"], 1000)
        sofa = placement(res, "obj_sofa")
        self.assertEqual((sofa["zCm"], sofa["rotDeg"]), (-124, 0))
        chair, table = placement(res, "obj_chair"), placement(res, "obj_table")
        self.assertLessEqual(manhattan((chair["xCm"], chair["zCm"]), (table["xCm"], table["zCm"])), 120)
        assert_valid(self, req, res)

    def test_02_any_solution_is_valid(self):
        req = request([{"id": "r1", "type": "near", "a": "obj_chair", "b": {"point": [-50, -175]}, "maxCm": 100, "priority": "must"}])
        assert_valid(self, req, solve(req))

    def test_03_pin(self):
        req = request([
            {"id": "r1", "type": "pin", "a": "obj_chair", "priority": "must"},
            {"id": "r2", "type": "near", "a": "obj_table", "b": {"object": "obj_chair"}, "maxCm": 120, "priority": "must"},
        ])
        res = solve(req)
        self.assertIn(res["status"], ("OPTIMAL", "FEASIBLE"))
        chair = placement(res, "obj_chair")
        self.assertEqual((chair["xCm"], chair["zCm"], chair["rotDeg"]), (140, 30, 270))
        assert_valid(self, req, res)

    def test_03b_soft_pin_is_kept_when_cheap_and_reported_when_broken(self):
        kept = solve(request([{"id": "r1", "type": "pin", "a": "obj_chair", "priority": "should", "weight": 3}]))
        self.assertEqual(kept["violated"], [])
        broken = solve(request([
            {"id": "r1", "type": "near", "a": "obj_chair", "b": {"point": [-50, -175]}, "maxCm": 100, "priority": "must"},
            {"id": "r2", "type": "pin", "a": "obj_chair", "priority": "should", "weight": 3},
        ]))
        self.assertIn(broken["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertEqual([v["ruleId"] for v in broken["violated"]], ["r2"])
        self.assertIs(broken["violated"][0]["amountCm"], True)

    def test_04_no_rules_nothing_moves(self):
        res = solve(request([]))
        self.assertEqual(res["status"], "OPTIMAL")
        self.assertEqual(res["movedCm"], 0)
        for o in OBJECTS:
            p = placement(res, o["id"])
            self.assertEqual((p["xCm"], p["zCm"], p["rotDeg"]), (o["xCm"], o["zCm"], o["rotDeg"]))

    def test_05_must_near_the_door_is_infeasible_and_named(self):
        res = solve(request([{"id": "r1", "type": "near", "a": "obj_chair", "b": {"point": DOOR_POINT}, "maxCm": 30, "priority": "must"}]))
        self.assertEqual(res["status"], "INFEASIBLE")
        self.assertIn("r1", res["conflicts"])

    def test_06_same_rule_as_should_is_feasible_and_reported(self):
        req = request([{"id": "r1", "type": "near", "a": "obj_chair", "b": {"point": DOOR_POINT}, "maxCm": 30, "priority": "should", "weight": 5}])
        res = solve(req)
        self.assertIn(res["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertEqual([v["ruleId"] for v in res["violated"]], ["r1"])
        self.assertGreater(res["violated"][0]["amountCm"], 0)
        assert_valid(self, req, res)

    def test_07_against_any_wall(self):
        req = request([{"id": "r1", "type": "against_wall", "a": "obj_storage", "wall": "any", "priority": "must"}])
        res = solve(req)
        s = placement(res, "obj_storage")
        hd = half(40)
        b = ROOM["boundsCm"]
        flush = {
            0: s["zCm"] == b["minZ"] + hd, 2: s["zCm"] == b["maxZ"] - hd,
            1: s["xCm"] == b["minX"] + hd, 3: s["xCm"] == b["maxX"] - hd,
        }
        self.assertTrue(flush[s["rotDeg"] // 90], f"storage at {s} is not flush and facing in")
        assert_valid(self, req, res)

    def test_08_facing_center(self):
        req = request([{"id": "r1", "type": "facing", "a": "obj_chair", "target": {"point": [0, 0]}, "priority": "must"}])
        res = solve(req)
        c = placement(res, "obj_chair")
        dx, dz = -c["xCm"], -c["zCm"]
        front = {0: dz >= abs(dx), 90: dx >= abs(dz), 180: -dz >= abs(dx), 270: -dx >= abs(dz)}
        self.assertTrue(front[c["rotDeg"]], f"chair at {c} doesn't face the centre")
        assert_valid(self, req, res)

    def test_09_deterministic(self):
        req = request([{"id": "r1", "type": "near", "a": "obj_chair", "b": {"point": [-50, -175]}, "maxCm": 100, "priority": "must"}])
        a, b = solve(req), solve(req)
        self.assertEqual(a["placements"], b["placements"])

    def test_11_close_pairs_let_a_chair_sit_at_its_table(self):
        objects = [
            {"id": "table", "widthCm": 120, "depthCm": 70, "xCm": 0, "zCm": 0, "rotDeg": 0, "movable": True},
            {"id": "chair", "widthCm": 50, "depthCm": 50, "xCm": 150, "zCm": 120, "rotDeg": 0, "movable": True},
        ]
        rule = [{"id": "r1", "type": "near", "a": "chair", "b": {"object": "table"}, "maxCm": 80, "priority": "must"}]
        apart = solve(request(rule, objects))
        self.assertEqual(apart["status"], "INFEASIBLE", "with a 60 cm walkway between them, 80 cm centre to centre can't hold")
        req = request(rule, objects)
        req["settings"]["closePairs"] = [["chair", "table", 5]]
        together = solve(req)
        self.assertEqual(together["status"], "OPTIMAL")
        chair, table = placement(together, "chair"), placement(together, "table")
        self.assertLessEqual(manhattan((chair["xCm"], chair["zCm"]), (table["xCm"], table["zCm"])), 80)
        assert_valid(self, req, together)

    def test_10_twelve_objects_six_rules_in_time(self):
        objects = []
        for i in range(12):
            objects.append({"id": f"o{i}", "widthCm": 60, "depthCm": 40, "xCm": -150 + (i % 4) * 100, "zCm": -120 + (i // 4) * 100, "rotDeg": 0, "movable": True})
        rules = [
            {"id": "r1", "type": "against_wall", "a": "o0", "wall": "any", "priority": "must"},
            {"id": "r2", "type": "near", "a": "o1", "b": {"object": "o2"}, "maxCm": 150, "priority": "must"},
            {"id": "r3", "type": "far_from", "a": "o3", "b": {"object": "o4"}, "minCm": 200, "priority": "should", "weight": 3},
            {"id": "r4", "type": "facing", "a": "o5", "target": {"point": [0, 0]}, "priority": "should", "weight": 2},
            {"id": "r5", "type": "keep_clear", "zone": "walkway", "marginCm": 60, "priority": "must"},
            {"id": "r6", "type": "near", "a": "o6", "b": {"point": [-50, -175]}, "maxCm": 120, "priority": "should", "weight": 4},
        ]
        req = request(rules, objects)
        res = solve(req)
        self.assertIn(res["status"], ("OPTIMAL", "FEASIBLE"))
        self.assertLess(res["solveMs"], 2500)
        assert_valid(self, req, res)


class Fixtures(unittest.TestCase):
    def test_S1_golden_request_solves_optimal(self):
        with open(os.path.join(PIPELINE, "solve-request.json")) as f:
            req = json.load(f)
        res = solve(req)
        self.assertEqual(res["status"], "OPTIMAL")
        self.assertIn("r1", res["satisfied"])
        self.assertIn("r2", res["satisfied"])
        chair = placement(res, "obj_chair")
        self.assertLessEqual(manhattan((chair["xCm"], chair["zCm"]), (-50, -175)), 100)
        assert_valid(self, req, res)

    def test_S2_golden_infeasible_request(self):
        with open(os.path.join(PIPELINE, "solve-infeasible-request.json")) as f:
            req = json.load(f)
        res = solve(req)
        self.assertEqual(res["status"], "INFEASIBLE")
        self.assertIn("r1", res["conflicts"])


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from app.main import app
        cls.client = TestClient(app)

    def test_S3_no_credential_is_401(self):
        res = self.client.post("/solve", json=request([]))
        self.assertEqual(res.status_code, 401)
        self.assertEqual(self.client.get("/health").status_code, 200, "health stays open for the Docker healthcheck")

    def test_S4_health_reports_ortools(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["ortools"].startswith("9.15"))

    def test_solve_over_http(self):
        res = self.client.post("/solve", json=request([]), headers={"X-Upstream-Token": "test-token"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["movedCm"], 0)


if __name__ == "__main__":
    unittest.main()
