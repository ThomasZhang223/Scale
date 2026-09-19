# modules/object-measure

LiDAR raycast-and-grow measurement, no machine learning. See the plan
(`~/.claude/plans/you-are-the-planning-stateful-badger.md`, section 1) for the full reasoning;
this file is the short version.

## The protocol

The object sits alone on a table the presenter controls. That single constraint is what lets the
measurement skip machine learning entirely: ARKit finds the table as a horizontal plane, and
everything above it, within a growing radius of the tap, is the object.

## Own ARSession, separate from room-capture

This module runs its own `ARSession` with `frameSemantics = [.sceneDepth]`. It never shares a
session with `modules/room-capture` — iOS gives the camera to one session at a time, and the room
scan and the object scan are always separate screens. `ARSessionDelegate` fires depth updates only
here.

## The one thing to verify first, on a real device

`DepthUnprojector.worldPoint` converts a depth-map pixel into a world point via
`K⁻¹ · pixel · depth`, then a Y/Z sign flip from the computer-vision pinhole convention (X right, Y
down, Z forward) into ARKit's own camera-local convention (X right, Y up, Z backward). This is the
single highest-risk line in the module. Plan section 1's own test settles it in thirty seconds:
point the phone at a flat wall at 1 m. If the reconstructed points do not form a flat,
forward-facing plane, the bug is here — not in the filtering, the radius growth, or the rectangle
fit.

`MinimumAreaRectangle.swift` has a second, independent thing worth checking: fit a rectangle known
to be at 0 degrees and one at 45 degrees, and confirm the reported `yawDeg` sign matches
`.claude/contracts.md`'s "CCW seen from +Y" convention. Getting this backwards does not show up as
a wrong width or depth — it shows up as a correctly-sized object rotated the wrong way, which is a
much easier bug to ship by accident.

## Known gaps, on purpose

- The RGB sweep collects 16 candidate frames and keeps the sharpest 8, cropped to the measured
  box's projected hull. Section 1 also says "the phone sends a sweep either way" without pinning
  an exact count; 8 matches the "six to eight frames" range named there.
- The point-cloud ghost (`ObjectMeasureNativeView.showGhost`) leans on RealityKit's
  `MeshDescriptor` point-primitive API. It is real, but unlike the RoomPlan APIs in
  `modules/room-capture`, it was not re-verified against live Apple docs this session. It fails
  silently rather than crashing if mesh generation throws — a missing decorative effect carries no
  decision weight; a wrong `bboxMeters` would.
- Yaw is medianed as a plain number across frames, not circularly. An object sitting right at the
  0/90-degree boundary can have frames disagree on which edge is "width" — untested on a real
  device.
- Exposure and white balance are locked before the RGB sweep; focus is never touched, because
  visual-inertial tracking depends on it (plan section 1).
