"""Validator tests against fixtures/room-demo.json. Run: python -m unittest discover -s tests"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from app.fit import fit, direction, rotate  # noqa: E402

with open(os.path.join(HERE, "..", "..", "..", "fixtures", "room-demo.json")) as f:
    ROOM = json.load(f)

# The fixture: floor 0..4 × 0..3.5. Door 0.9 wide centred at x = 1.2 on the z = 0 wall,
# swing 90°, hinge left. Window 1.2 wide centred at x = 2.8 on the z = 3.5 wall, sill 0.9 m.
# Walls are 0.12 thick, so the east wall's inner face is x = 3.94.


def placement(pid, x, z, w=0.5, h=0.5, d=0.5, yaw=0.0, scale=1.0):
    return {"placementId": pid, "objectId": f"obj-{pid}", "p": [x, 0.0, z], "yawDeg": yaw, "scale": scale,
            "bboxMeters": {"w": w, "h": h, "d": d}}


def kinds(report):
    return sorted(v["kind"] for v in report["violations"])


class Conventions(unittest.TestCase):
    def test_angles_run_from_plus_x_toward_minus_z(self):
        x, z = direction(90)
        self.assertAlmostEqual(x, 0.0)
        self.assertAlmostEqual(z, -1.0)
        x, z = rotate((1.0, 0.0), 90)
        self.assertAlmostEqual(z, -1.0)


class Fit(unittest.TestCase):
    def test_empty_layout_is_ok(self):
        report = fit(ROOM, [])
        self.assertTrue(report["ok"])
        self.assertEqual(report["violations"], [])
        self.assertEqual(report["schemaVersion"], 1)

    def test_far_corner_is_clear(self):
        report = fit(ROOM, [placement("a", 3.2, 2.2)])
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["violations"], [])

    def test_object_in_the_door_swing_blocks_with_an_arc_into_the_room(self):
        report = fit(ROOM, [placement("a", 1.2, 0.5, w=0.3, d=0.3)])
        self.assertFalse(report["ok"])
        self.assertIn("door_swing", kinds(report))
        arc = next(v for v in report["violations"] if v["kind"] == "door_swing")
        self.assertEqual(arc["severity"], "block")
        self.assertGreater(arc["detailMeters"], 0.3)
        g = arc["geometry"]
        self.assertEqual(g["type"], "arc")
        self.assertAlmostEqual(g["center"][0], 0.75)  # left hinge: door centre 1.2 − 0.45
        self.assertAlmostEqual(g["center"][1], 0.0)
        self.assertAlmostEqual(g["radiusM"], 0.9)
        # From the closed door (+X, 0°) sweeping toward +Z, which is −90° in the contract's sense.
        self.assertAlmostEqual(g["startDeg"], 0.0)
        self.assertAlmostEqual(g["endDeg"], -90.0)
        self.assertGreater(direction(g["endDeg"])[1], 0.99, "the arc's end points into the room (+Z)")
        self.assertIn("blocks the door swing by", arc["message"])
        self.assertIn("clearance", kinds(report), "it also narrows the walkway through the door")

    def test_beside_the_door_but_outside_the_swing_is_fine(self):
        # x = 2.0 is 1.25 m from the hinge at 0.75: beyond the 0.9 m swing and outside the corridor.
        report = fit(ROOM, [placement("a", 2.3, 0.4, w=0.3, d=0.3)])
        self.assertEqual(kinds(report), [])

    def test_floating_off_a_wall_is_a_warning(self):
        # Right edge at 3.92; the east wall's inner face is 3.94 → 2 cm gap.
        report = fit(ROOM, [placement("a", 3.67, 2.0)])
        self.assertTrue(report["ok"])  # warnings don't fail the layout
        self.assertEqual(kinds(report), ["wall_gap"])
        v = report["violations"][0]
        self.assertAlmostEqual(v["detailMeters"], 0.02, places=3)
        self.assertEqual(v["geometry"]["type"], "polyline")
        self.assertEqual(len(v["geometry"]["points"]), 2)

    def test_touching_the_wall_is_not_floating(self):
        report = fit(ROOM, [placement("a", 3.69, 2.0)])  # edge exactly on the face
        self.assertEqual(kinds(report), [])

    def test_tall_thing_in_front_of_the_window_occludes_it(self):
        short = fit(ROOM, [placement("a", 2.8, 3.1, h=0.5)])
        self.assertEqual(kinds(short), [], "below the 0.9 m sill: fine")
        tall = fit(ROOM, [placement("a", 2.8, 3.1, h=1.5)])
        self.assertEqual(kinds(tall), ["window_occlusion"])
        v = tall["violations"][0]
        self.assertEqual(v["severity"], "warn")
        self.assertAlmostEqual(v["detailMeters"], 0.6, places=3)
        self.assertEqual(v["geometry"]["type"], "polyline")

    def test_rotated_footprint_is_respected(self):
        # 1.0 × 0.2 slab at x = 2.0, z = 0.4: lying along the wall (yaw 0) its end reaches
        # x = 1.5, 0.75 m from the hinge, inside the swing; turned 90° it doesn't.
        along = fit(ROOM, [placement("a", 2.0, 0.4, w=1.0, d=0.2, yaw=0)])
        self.assertIn("door_swing", kinds(along))
        turned = fit(ROOM, [placement("a", 2.3, 0.6, w=1.0, d=0.2, yaw=90)])
        self.assertNotIn("door_swing", kinds(turned))

    def test_scale_other_than_one_is_reported(self):
        report = fit(ROOM, [placement("a", 3.2, 2.2, scale=1.5)])
        self.assertEqual(len(report["warnings"]), 1)
        self.assertIn("placement a has scale 1.5", report["warnings"][0])

    def test_missing_bbox_fails_loud(self):
        p = placement("a", 3.2, 2.2)
        del p["bboxMeters"]
        with self.assertRaisesRegex(ValueError, "no bboxMeters for objectId obj-a"):
            fit(ROOM, [p])
        report = fit(ROOM, [p], objects={"obj-a": {"w": 0.5, "h": 0.5, "d": 0.5}})
        self.assertTrue(report["ok"])

    def test_raw_roomplan_room_is_accepted(self):
        # apps/xr/public/room-scan.json: RoomPlan's own encoding, no schemaVersion, doors/windows
        # in their own lists, walls 0 thick. Door on the south wall centred at x = 1.5 (raw frame).
        room = json.load(open(os.path.join(HERE, "..", "..", "..", "apps", "xr", "public", "room-scan.json")))
        clear = fit(room, [placement("a", -0.5, 0.0, w=0.3, h=0.5, d=0.3)])
        self.assertEqual(kinds(clear), [])
        blocked = fit(room, [placement("a", 1.5, 2.2, w=0.3, h=0.5, d=0.3)])
        self.assertIn("door_swing", kinds(blocked))
        arc = next(v for v in blocked["violations"] if v["kind"] == "door_swing")["geometry"]
        self.assertEqual(arc["type"], "arc")
        self.assertAlmostEqual(arc["radiusM"], 0.9)

    def test_wrong_schema_version_fails_loud(self):
        with self.assertRaisesRegex(ValueError, "schemaVersion 2, expected 1 — ask Thomas"):
            fit({**ROOM, "schemaVersion": 2}, [])


if __name__ == "__main__":
    unittest.main()
