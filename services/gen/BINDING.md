# The scale binding

This is the technical thesis of the whole project, not a feature. Owner: **Ani**, sole owner —
see below.

## One sentence for a technical judge

The generative model gives shape, the depth sensor gives size, and we bind them.

## What it does

Generated meshes come back at normalised scale, roughly -1 to 1 per axis. The binding rescales the
generated bounding box to the measured box (`bboxMeters` from `Object v1`, see
`.claude/contracts.md`). It is about ten lines of code: compute the generated mesh's AABB, compute
the per-axis scale factor to match `bboxMeters`, apply it, re-centre the origin to bottom-centre.

## What this project does not solve

Metric-scale reconstruction from single-view RGB-D has no reliable general solution. That is why
every consumer image-to-3D tool ships dimensionally meaningless output — a plausible-looking mesh
with no real-world size. This project does not solve that problem. It sidesteps it with a depth
sensor: LiDAR (or, for the catalog path, extracted/declared dimensions) supplies the size, and the
generator only ever has to supply the shape.

## The mesh normalisation contract — checklist

Taken exactly from `.claude/contracts.md`. All four are required on every GLB this service
publishes:

- [ ] **1. AABB match.** The mesh axis-aligned bounding box equals `bboxMeters` to within 1 mm.
- [ ] **2. Origin at bottom-centre.** The origin sits at the bottom-centre of that box, so a
      placement `y` of 0 means "on the floor".
- [ ] **3. +Y up, -Z front.** +Y is up and -Z is the front face.
- [ ] **4. Units in metres, node scale = 1.** Units in the GLB are metres, so the glTF node scale
      is 1.

A consumer that applies its own scale factor is a bug, not a preference.

## Sole ownership

Ani is the **sole owner** of this binding. Nothing downstream — the fit solver, the WebXR runtime,
the phone renderer — ever rescales a GLB. If two components rescale, the error squares and nobody
finds it until the demo.

## How to verify — before telling anyone it works

The verification is a tape measure on the table, not a script that looks right:

1. Measure the physical object with a tape measure.
2. Compute the exported mesh's AABB (script or viewer).
3. Diff the AABB against `bboxMeters` — must be under 1 mm on all three axes.
4. Confirm the min Y of the AABB is 0, and (min+max)/2 is 0 in X and Z.
5. Load the GLB in a viewer: the object stands upright, front face points toward -Z.
6. Inspect the glTF node: scale is `[1, 1, 1]`, no wrapping transform.

Do not tell anyone the binding works until steps 1-3 agree to within 1 mm on the physical object,
not just in code. This is also the H6/H8/H10 kill criterion — see `.claude/workstreams/ani.md`. If
a generated mesh fails to measure true, fall back to a textured box at the measured dimensions
immediately; don't debug the binding live at H10.
