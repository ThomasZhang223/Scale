# app — route notes

## The four checks `/fit` owes (`fit.py`)

1. **Door swing** (`block`): a quarter circle of the door's width from its hinge, sweeping
   into the room. Anything inside it blocks the door; `detailMeters` is how deep.
   Geometry: `arc`.
2. **Clearance** (`block`): the corridor straight in through each door — 90 cm wide (or the
   door's width) and 90 cm deep — must stay clear. Geometry: closed `polyline`.
   *Ceiling: walkways between objects elsewhere in the room aren't checked yet; a real path
   search is the upgrade.*
3. **Wall gap** (`warn`): an object 1–4 cm off a wall's inner face is floating, not against
   it. Geometry: a two-point `polyline` from the nearest corner to the wall.
4. **Window occlusion** (`warn`): anything taller than the sill standing on the 60 cm of
   floor in front of a window. Geometry: closed `polyline`.

`ok` is false only when a `block` violation exists. A placement whose `scale` isn't 1.0
adds a line to the optional `warnings` list (the normalisation contract broke upstream).

**Body:** `{ room: RoomCapture v1, placements: Placement v1[], objects?: { [objectId]: bboxMeters } }`.
A placement may also carry `bboxMeters` inline. The service is stateless: when the Worker
proxies the public `{ roomId, placements }` shape, it inlines the room and the boxes.

**Angles:** degrees, counter-clockwise seen from +Y — from +X toward −Z, the same sense as
three.js `rotation.y` and `yawDeg`. `fixtures/fitreport-doorswing.json` has its arc going
0° → 90° from a door on the z = 0 wall, which sweeps *outside* that room; it should read
0° → −90° (or 270° → 360° with the hinge on the other side).

Tests: `python -m unittest discover -s tests` (stdlib only, against `fixtures/room-demo.json`).

## `FitReport v1` geometry types

Three, and only three: `arc`, `polyline`, `rect`. This list belongs to Justin (component E).
Adding a fourth type is a contract change — announce it before pushing (see
`.claude/contracts.md`).
