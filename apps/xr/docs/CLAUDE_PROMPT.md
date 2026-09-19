# Prompt: continue the room-scan VR project

Paste this into Claude Code, opened in this repo.

```markdown
This repo is a three.js WebXR page for the Meta Quest 3S (Hack the North 2026). Read
README.md and every file in src/ before changing anything, and build on the existing
patterns.

What it does now:
- Builds a room from Apple RoomPlan's CapturedRoom JSON (src/roomScan.ts), recentered so
  the floor is y = 0 and the room is centered.
- Loads scanned objects (GLB, e.g. Object Capture) at real-world size with a bottom-center
  origin and a convex-hull collider (src/objects.ts). Files in cm/mm are converted.
- Rapier physics (src/physics.ts): solid floor, walls and detected furniture; objects are
  dynamic, upright (tilt locked), moved by velocity toward a target so they collide.
- An object whose name contains a detected category takes that piece's spot and rotation,
  nudged the minimum distance to fit.
- Quest controllers and laptop mouse move objects through physics (src/interaction.ts).
- Optional Supabase live room updates (src/sync.ts).

Conventions: meters, Y up, room floor center is the origin, GLB pivots at bottom-center.
Keep the page working without Supabase. Keep the Quest at a smooth frame rate.

Task: <describe the next step here>

How to work:
- Short plan first; wait for my OK.
- Typecheck and build before calling anything done. For physics or placement changes,
  write a Node test against public/room-scan.json with Rapier (see how physics was tested:
  bundle a .ts test with esbuild, run with node). GLB textures can't decode in Node; strip
  them with @gltf-transform/core for tests.
- Say plainly what can only be checked on the Quest, with a short manual test list.
- If something in the code or this brief looks wrong, tell me before building around it.
```

Ideas for next steps: sync object positions through Supabase so every headset sees the
same layout; a designer agent that moves objects via physics targets; red/green outlines
when an object doesn't fit; a mixed reality mode that shows the scan over the real room.
