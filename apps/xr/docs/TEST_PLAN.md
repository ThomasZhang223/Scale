# Test plan: scanned objects with physics

Two parts: automated tests in Node (physics, placement, units), and a manual checklist
for the laptop and the Quest.

## Automated tests in Node

Physics and placement can be tested without a browser.

**How to run a test:** write it as a `.ts` file inside the repo (so it can import `src/`
and `three`), bundle it with esbuild, run it with Node:

```bash
npx esbuild my-test.ts --bundle --platform=node --format=esm --outfile=/tmp/my-test.mjs
node /tmp/my-test.mjs
```

Rapier's compat build works in Node as is. GLB **textures** can't decode in Node, so for
tests with real GLBs, make texture-free copies first with `@gltf-transform/core`
(read the file, dispose every texture, write a copy), then parse with `GLTFLoader.parse`.

### Reference numbers for the sample room (`public/room-scan.json`, after recentering)

| Thing | Value |
|---|---|
| Room | 4.2 × 3.6 m, walls 2.5 m high, 0.1 m thick |
| Inner wall faces | x = ±2.05, z = ±1.75 |
| Sofa (detected) | 2.0 × 0.85 × 0.9 m at (0, −1.3), front face at z = −0.85 |
| Table (detected) | 1.0 × 0.45 × 0.6 m at (0, −0.2): x −0.5..0.5, z −0.5..0.1 |
| Chair (detected) | 0.6 × 0.9 × 0.6 m at (1.4, 0.3), rotated −90° |
| Storage (detected) | 0.8 × 1.8 × 0.4 m at (−1.85, 0.8), rotated 90° |

A clear lane for wall tests: z = 1.2 (nothing between x = −1.6 and the east wall).

### Tests

| # | Test | Pass when |
|---|---|---|
| 1 | Units: a box mesh 80 × 90 × 60 (cm) through `prepareObject` | Size is 0.80 × 0.90 × 0.60 m and a unit note is set |
| 2 | Origin: same object, offset from the origin before preparing | Bounding box min y = 0 and centered on x and z |
| 3 | Free spot avoids furniture: `findFreeSpot` for that box preferring (0, 0) | The spot doesn't overlap the table |
| 4 | Landing: add it, step 2 s | y within 1 cm of 0 |
| 5 | Wall: drag to (x, 1.2), then to (10, 1.2), step 3 s | Right edge within 1 cm of x = 2.05; still on the floor |
| 6 | Upright: after hitting the wall | Quaternion x and z ≈ 0 |
| 7 | Detected furniture is solid: drag to (−1, 1.2), then to (−1, −1.3) | Back edge stops at z ≈ −0.85 (the sofa, not the table) and y stays 0 |
| 8 | Stays when released | Moves less than 1 cm in the 2 s after release |
| 9 | Turning: drag target with rotY = 90° | Rotation within 0.05 rad of 90° |
| 10 | Replacing frees the spot: `findFreeSpot` at the chair's spot before and after `removeDetected(chair)` | Before: moved elsewhere. After: exactly the chair's spot |
| 11 | Real chair GLB replacing the detected chair | Real size kept (no unit note), lands on the floor, at (1.40, 0.30) with 0 cm nudge, rotation −90°, fully inside the walls |
| 12 | Real sofa GLB replacing the detected sofa | Real size kept, lands on the floor, within 20 cm of (0, −1.3) (expect about 10 cm), fully inside the walls |

Test 7 must use the x = −1 lane: a straight path at x = 0 hits the **table** first and
passes for the wrong reason. Test 12 is the one that catches the "long sofa treated as a
circle" bug.

## Manual checklist: laptop

1. `npm run dev`. The room rises, then the chair and sofa drop into the detected spots and
   the grey chair and sofa boxes disappear.
2. The panel shows each object's size next to the detected size.
3. Drag the chair into a wall: it stops. Drag it into the sofa: it pushes or stops, never
   passes through. Scroll while dragging turns it in 15° steps.
4. Dragging on empty floor still orbits the camera; dragging an object doesn't.
5. **Show physics shapes**: green outlines match the walls, furniture boxes, and the
   objects' real shapes.
6. Drop a new `.glb` whose name contains no category: it lands at a free spot near the front.
7. Drop a second `chair.glb`: it doesn't take the already-used chair spot.
8. **Reset**: the room rises again with no objects falling through the floor, then
   everything is placed again.
9. Drop a new room `.json`: same as Reset, in the new room.

## Manual checklist: Quest

1. `npm run quest`, open `http://localhost:5173` in the Quest Browser, **Enter VR**.
2. The objects look right: textures, colors, real size compared with your own body.
3. The ray turns blue over an object. Trigger grabs it (small vibration). It follows the
   ray across the floor without snapping its center to the ray.
4. Thumbstick left/right turns the held object smoothly.
5. Walls and furniture stop it; it pushes the other object.
6. Frame rate stays smooth with both objects, and while dragging. If it drops, shrink the
   GLBs: `npx @gltf-transform/cli optimize in.glb out.glb --compress draco --texture-compress webp`.
7. Leave VR: the laptop view comes back and orbiting works.
