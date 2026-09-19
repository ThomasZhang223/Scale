"""The Worker's hydrated /solve shape through the bridge, on fixtures/room-demo.json."""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ.setdefault("UPSTREAM_TOKEN", "test-token")
from app.solve_bridge import Frame, solve_hydrated  # noqa: E402

with open(os.path.join(HERE, "..", "..", "..", "fixtures", "room-demo.json")) as f:
    ROOM = json.load(f)


def obj(oid, name, w, h, d):
    return {"schemaVersion": 1, "objectId": oid, "source": "scan", "state": "ready", "name": name, "category": name,
            "glbUrl": None, "bboxMeters": {"w": w, "h": h, "d": d}}


class Bridge(unittest.TestCase):
    def test_frame_matches_the_fixture(self):
        f = Frame(ROOM)
        # Floor polygon 0..4 × 0..3.5, walls 0.12 thick: inner faces at 0.06 and 3.94 / 3.44.
        self.assertAlmostEqual(f.min_x, 0.06)
        self.assertAlmostEqual(f.max_x, 3.94)
        self.assertAlmostEqual(f.min_z, 0.06)
        self.assertAlmostEqual(f.max_z, 3.44)
        self.assertEqual(f.bounds(), {"minX": -194, "maxX": 194, "minZ": -169, "maxZ": 169})
        doors, windows = f.openings()
        self.assertEqual([d["id"] for d in doors], ["e6b6ff22-d92f-4d90-af34-18be7143095a"])
        self.assertEqual(doors[0]["side"], "north")
        self.assertEqual(windows[0]["side"], "south")

    def test_hydrated_request_places_candidates_inside_the_room(self):
        body = {
            "schemaVersion": 1, "room": ROOM,
            "candidates": [obj("sofa", "sofa", 2.0, 0.8, 0.9), obj("chair", "chair", 0.6, 0.9, 0.6)],
            "fixed": [],
            "plan": {"schemaVersion": 1, "objective": "maximize_walkway",
                     "constraints": [{"kind": "against_wall", "objectId": "sofa", "wallId": None},
                                     {"kind": "near", "objectId": "chair", "otherObjectId": "sofa", "maxMeters": 1.5},
                                     {"kind": "budget", "cents": 120000}],
                     "notes": ""},
        }
        res = solve_hydrated(body)
        self.assertIsNone(res["infeasible"])
        self.assertEqual({p["objectId"] for p in res["placements"]}, {"sofa", "chair"})
        self.assertEqual(res["honoured"], ["against_wall", "near"])
        self.assertEqual(res["ignored"], ["budget"])
        f = Frame(ROOM)
        for p in res["placements"]:
            self.assertTrue(f.min_x <= p["p"][0] <= f.max_x and f.min_z <= p["p"][2] <= f.max_z, p)
            self.assertEqual(p["scale"], 1.0)
            self.assertIn(p["yawDeg"], (0.0, 90.0, 180.0, 270.0))
        sofa = next(p for p in res["placements"] if p["objectId"] == "sofa")
        # Back flush against the wall it faces away from: 0° faces +Z so its back is on the north
        # face, 180° on the south, 90° (facing +X) on the west, 270° on the east. Half depth 0.45.
        back = {0.0: sofa["p"][2] - 0.45 - f.min_z, 180.0: f.max_z - 0.45 - sofa["p"][2],
                90.0: sofa["p"][0] - 0.45 - f.min_x, 270.0: f.max_x - 0.45 - sofa["p"][0]}[sofa["yawDeg"]]
        self.assertLess(abs(back), 0.02, sofa)

    def test_fixed_placements_are_returned_untouched(self):
        fixed = {"placementId": "pl1", "objectId": "table", "p": [2.0, 0.0, 1.0], "yawDeg": 0, "scale": 1, "lockedToWallId": None, "flags": []}
        body = {"schemaVersion": 1, "room": ROOM, "candidates": [obj("table", "table", 1.2, 0.75, 0.6), obj("lamp", "lamp", 0.3, 1.5, 0.3)],
                "fixed": [fixed], "plan": {"schemaVersion": 1, "objective": "minimize_wall_gap", "constraints": [], "notes": ""}}
        res = solve_hydrated(body)
        self.assertIn(fixed, res["placements"])
        lamp = next(p for p in res["placements"] if p["objectId"] == "lamp")
        self.assertNotEqual(lamp["p"][:1], [2.0])

    def test_wrong_schema_version_fails_loud(self):
        with self.assertRaisesRegex(ValueError, "schemaVersion 2"):
            solve_hydrated({"schemaVersion": 2, "room": ROOM, "candidates": [], "fixed": [], "plan": {}})


if __name__ == "__main__":
    unittest.main()
