# Build spec: scanned objects with physics in the room scan

Adds to the existing `room-scan-headset` repo. The room already loads from RoomPlan JSON
and rises out of the floor. This step drops **scanned objects** (GLB, e.g. from Apple
Object Capture) into that room at **real-world size**, with **physics**: they land on the
floor, can't pass through walls or furniture, stay upright, and can be grabbed and moved
on the Quest and on the laptop.

## Goal, as the user sees it

1. The room rises out of the floor, as now.
2. Scanned objects drop in. An object whose name contains a category RoomPlan detected
   (`chair.glb`) lands exactly where that chair was detected, facing the same way, and
   the grey box disappears.
3. On the Quest: point at an object, hold the trigger, sweep it across the floor. It stops
   at walls and pushes other objects. Thumbstick turns it. Let go and it stays.
4. On the laptop: drag with the mouse, scroll while dragging to turn.
5. The panel reports each object's size next to the size RoomPlan measured.

## Decisions (and why)

| Decision | Why |
|---|---|
| Keep the GLB's real size; never stretch it to RoomPlan's box | Object Capture exports in meters. The scan is the truth; RoomPlan's box is an estimate. |
| Convert only files that are obviously cm or mm (largest side > 5 m) | Some exporters use other units. Anything over 5 m isn't furniture. |
| Origin at the bottom-center of every object | "Position" then means "the spot on the floor", the same convention as the room. |
| Physics engine: Rapier (`@dimforge/rapier3d-compat`) | Fast, runs in the browser as WebAssembly, the compat build needs no bundler setup. |
| Convex hull collider around the object's real shape, box as fallback | Closer to the real shape than a box, still cheap enough for the Quest. |
| Lock tipping (X and Z rotation), allow turning (Y) | Furniture falling over in a demo looks broken, not realistic. |
| Move objects by setting velocity toward a target, not by teleporting | Collisions still happen while dragging: objects stop at walls and shove each other. |
| Room colliders built from the visible meshes and the same scan data | Physics can never disagree with what the user sees. |
| Detected furniture is solid until a scan replaces it | A new object can't be placed inside the detected sofa. |

## Dependencies and assets

- Add `@dimforge/rapier3d-compat` (tested with 0.20). Initialize with `await RAPIER.init()`.
- **Don't use top-level `await`** in `main.ts`: Vite's default build target rejects it.
  Wrap startup in an `async function start()` and call it.
- Sample objects for testing, both CC BY 4.0 © Wayfair, from the Khronos glTF Sample Assets
  repo (`Models/<Name>/glTF-Binary/<Name>.glb` on raw.githubusercontent.com):
  - `ChairDamaskPurplegold` → save as `public/objects/chair.glb` (about 0.83 × 0.69 × 0.57 m, 2 MB)
  - `GlamVelvetSofa` → save as `public/objects/sofa.glb` (about 2.19 × 0.79 × 1.02 m, 3 MB)
  - Add `public/objects/ATTRIBUTION.md` crediting them.
- `public/objects.json`: a list of `{ url, name, scale? }` loaded at startup.
  `name` drives matching; `scale` overrides unit detection.

## File-by-file

### `src/roomScan.ts` (change)

- `ScannedObject` gains two fields:
  - `identifier`: RoomPlan's `identifier` string, or `category-index` if missing.
  - `node`: the object's grey box as a `THREE.Group`.
- Build each detected object's box with its **origin at the bottom-center**: box geometry
  shifted up by half its height, group positioned at the recentered bottom-center, rotated
  by `rotationY`. Add these groups directly to the room's root group (already-recentered
  space), not to the offset content group. A model can then take a box's place by using
  the same position and rotation.
- Tag every wall mesh with `userData.collider = 'wall'` so physics can find them.
  Doors, windows and openings are not tagged (walls are full slabs anyway).

### `src/objects.ts` (new): GLB → object ready for the room

`ObjectLoader` wraps `GLTFLoader` (with Draco, KTX2 and Meshopt decoders, same setup as
any three.js project) and caches by URL; each load returns a fresh clone.

A separate, exported `prepareObject(model, scaleOverride?)` does the real work, so it can
be tested without loading files:

1. Wrap the model in a new group.
2. **Units:** measure the bounding box. If the largest side is over 5 m, scale by 0.01 when
   that brings it under 5 m (centimeters), otherwise by 0.001 (millimeters). Record a
   short note for the panel when this happens.
3. **Origin:** re-measure and shift the model so the box's bottom-center sits at the group's origin.
4. **Hull points:** collect vertex positions in the group's space, rounded to 1 cm with
   duplicates dropped, capped at 4000 points (sample with a stride on big meshes).
5. Return `{ node, size, hull, note }`: size in meters, hull as a flat `Float32Array`.

Measure with `Box3.setFromObject(obj, true)` (precise mode) after `updateMatrixWorld(true)`.

### `src/physics.ts` (new): Rapier world

Created once through an async factory that initializes Rapier. Gravity −9.81.

**Room (`setRoom(built)`)**, called with a freshly built room **before** it is added to
the scene or the rise animation scales it:

- Remove the previous room's fixed body (this removes its colliders).
- One fixed body holding:
  - **Floor:** a cuboid 1 m thick with its top at y = 0, extending 2 m beyond the room.
  - **Walls:** for each mesh tagged `wall`, a cuboid from its box geometry size and its
    world position and rotation.
  - **Detected furniture:** a cuboid per detected object (size from `dimensions`, center
    at its bottom-center plus half its height, rotated by `rotationY`), stored by identifier.
- `removeDetected(identifier)` removes that collider when a scanned object replaces it.

**Scanned objects (`addObject`)**:

- Dynamic body at the chosen spot, dropped from 0.3 m so the landing is visible.
- Rotations enabled on Y only. Linear damping 0.6, angular damping 3, CCD on.
- Collider: convex hull of the hull points (needs at least 4 points), falling back to the
  bounding box if the hull fails. Friction 0.8, restitution 0.05, density 250.

**Stepping:** fixed 1/60 s steps with an accumulator (at most 5 steps per frame), then copy
each body's position and rotation to its three.js node. If an object falls below y = −3,
put it back at a free spot.

**Dragging:** `drag(id, x, z, rotY)` stores a target; before every physics step, set the
body's horizontal velocity to `(target − position) × 12`, capped at 3 m/s, keeping its
vertical velocity (gravity still works). Turn with angular velocity `angleError × 10`
around Y. `release(id)` clears the target and zeroes horizontal and angular velocity, so
the object stops where it was let go instead of sliding.

**Finding a free spot (`findFreeSpot(size, rotY, prefer)`)**: test a box the object's
size (plus 2 cm margin) with Rapier's `intersectionWithShape`, and check the object's
**rotated footprint** stays inside the room. Try the preferred spot, then rings around it:
every 5 cm out to 60 cm first (small nudges), then every 20 cm across the room. Return
the first free spot.

**Debug view:** a green wireframe for every collider, hidden by default, toggled from the panel.

### `src/interaction.ts` (new): moving objects

Both inputs hand physics a target; neither moves objects directly.

- **Quest controllers:** a ray on each controller that turns blue over an object. Trigger
  down: raycast, find the object, remember the offset between the object's position and
  where the ray meets the floor (so it doesn't snap its center to the ray). While held,
  each frame: intersect the ray with the floor plane, drag to that point plus the offset.
  Thumbstick X (axis 2) turns it. Trigger up: release. Short haptic pulse on grab.
- **Laptop mouse:** the same logic with a camera ray. Listen to `pointerdown` in the
  **capture phase** and stop propagation when an object is hit, or OrbitControls will also
  start orbiting. Disable OrbitControls while dragging. Scroll while dragging turns 15° per
  notch (also capture phase, not passive). Cursor shows grab/grabbing.

### `src/main.ts` (change)

- Start-up order: create physics, loader, interaction; load the room scan and wait for it;
  load `objects.json`; start Supabase watching (unchanged).
- **Placing objects waits for the room.** Objects that finish loading while the walls are
  still rising are placed when the rise completes.
- **On a new or reset room:** first remove every object's body and take its node out of
  the scene (otherwise they fall through the missing floor during the rise), then set the
  new room, then place everything again once the walls are up.
- **Placement rule for each object:**
  1. Find a detected piece whose category appears in the object's name (case-insensitive)
     and isn't already taken by another object.
  2. If found: hide its box, remove its collider, prefer its position and rotation.
  3. If not: prefer the spot 1 m in front of the room center (where you face on entering VR), rotation 0.
  4. Run `findFreeSpot` from the preferred spot, then add the object to the scene and physics.
- **Panel report** after placing: object size, and if it replaced something, the detected
  size; plus the unit note if units were converted. Also log a `console.table` of all objects.
- Dropped files: `.json` loads a room (as now), `.glb`/`.gltf` load objects (object URL
  from the file, name = file name). Several files at once should work.

### `index.html` (change)

Panel: **Add room or object** (file picker for `.json`, `.glb`, `.gltf`, multiple),
**Reset** (rebuild the current room and re-place everything), a **Show physics shapes**
checkbox, and a one-line hint about dropping files and dragging.

## Pitfalls found while building this

- **Rapier's spatial queries only update when the world steps.** Right after adding or
  removing colliders, `intersectionWithShape` still sees the old state, so objects spawn
  inside the table. After `setRoom`, `removeDetected` and `addObject`, run one
  `world.step()` (1/60 s, unnoticeable).
- **Don't approximate a long object as a circle** when checking room bounds. A 2.2 m sofa
  treated as a 1.1 m-radius circle can't be placed anywhere near a wall and ends up across
  the room. Use the rotated footprint: half-extent in X = |cos θ|·w/2 + |sin θ|·d/2, and
  in Z = |sin θ|·w/2 + |cos θ|·d/2.
- **Real scans are rarely the same size as RoomPlan's box.** The sample sofa is 2.19 ×
  1.02 m against a 2.00 × 0.90 m box next to a wall; it needs a ~10 cm nudge. That's
  expected behavior, not a bug.
- **Debug wireframes must not be pickable.** Give them an empty `raycast` function, or the
  controller ray grabs the collider view instead of the object.
- **The bundle grows by about 2–3 MB** because Rapier's WebAssembly is inlined. Fine over
  local USB; worth knowing for hosting.

## Out of scope for this step

Syncing object positions between headsets, a designer agent, fit warnings, mixed reality.
Keep the page working without Supabase.
