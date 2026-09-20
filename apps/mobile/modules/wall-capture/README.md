# modules/wall-capture

The RoomPlan fallback: a box-shaped room from six photos. The user picks a face of a
rectangular prism (front, right, back, left, floor, ceiling), frames that whole face, and
captures. Per capture:

1. **Rectangle detection** — Vision `VNDetectRectanglesRequest`, largest quad, tolerant of
   the skew a wall shot from an angle has. Drawn live in green on the camera view.
2. **Four-point transform** — Core Image `CIPerspectiveCorrection` on those corners: the face
   straight on, rotated upright, saved as a JPEG. This is the per-wall rectified photo that
   `appearance.surfaces[wallId].textureUrl` was reserved for.
3. **Metres** — ARKit raycasts on the same four corners (vertical planes for walls, horizontal
   for floor/ceiling; detected plane geometry first, estimated plane second). Width and
   height are edge lengths, the centre is the mean, yaw is the bottom edge's heading.
   If any corner has no surface behind it the capture throws; there is no guessed corner.

`src/ui/roomFromFaces.ts` turns the captured walls into a `RoomCapture v1`: one wall per
captured vertical face, a floor polygon from the walls' bottom corners, no openings, no
objects. Standing rule 1 holds: metres everywhere.

## Ceilings, on purpose

- Rooms are assumed box-shaped. An L-shaped room needs two boxes; not handled.
- Openings and furniture are not detected here. RoomPlan's path stays the primary.
- `northBearingDeg` is 0: the ARSession runs gravity-and-heading so wall yaws are
  true-north relative, but the human cross-check value is not read from the compass here.
- The rectified JPEGs stay on the phone (no room-texture upload kind in workers/ yet).
