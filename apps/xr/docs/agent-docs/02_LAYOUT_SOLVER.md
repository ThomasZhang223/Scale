# Layout solver (OR-Tools CP-SAT)

A Python service next to `services/fit`: `services/layout`, endpoint `POST /solve` plus
`GET /health`. It runs on a **team computer**, reached by the Cloudflare agent through a
Cloudflare Tunnel (see `07`). It must reject requests without the Worker's credentials
(shapes in `01_CONTRACT.md` §6). It takes rooms and objects in integer centimeters and
returns positions and rotations that satisfy every hard rule and as many soft rules as
possible, while moving things as little as possible.

Use the same web framework and conventions as `services/fit`. Pin `ortools==9.15.*`
(prototyped with 9.15.6755).

## What the prototype proved

Sample room (410 × 350 cm inside), sofa 219 × 102, chair 83 × 57, table 100 × 60, storage
80 × 40, door keep-out, walkway margins, 4 rotations each, request "sofa against the north
wall facing the room, chair within 120 cm of the table":

- **OPTIMAL in 267 ms** with 8 workers, **~70 ms with 1 worker**. Peak memory ~100 MB.
- Sofa: z = −124 (flush to the north wall face at −175, half depth 51), 0°.
- Table: moved 48 cm to leave the walkway in front of the sofa.
- Chair: moved 32 cm to sit 108 cm from the table, kept its rotation.
- Storage: untouched (moving it wasn't needed).

That last point matters for the demo: minimal movement makes the agent look deliberate.

## Model

### Frame and units
- The Worker sends a frame where the room's main walls are axis-aligned, in whole cm.
- Rotation convention (must match the Worker's conversion): **front faces +Z at 0°**,
  +X at 90°, −Z at 180°, −X at 270°.

### Variables per object
- `x`, `z`: integer center coordinates within the room bounds.
- `r0..r3`: one boolean per rotation, exactly one true.
- `upright = r0 + r2`. Upright footprint is width × depth; otherwise depth × width.

### Hard constraints (always on)
- **No overlaps:** each object gets two *optional* interval pairs (one per footprint
  orientation, enforced by `upright` / `not upright`), all in one `add_no_overlap_2d`.
- **Walkways:** each footprint is inflated by `walkwayCm / 2` on every side inside the
  no-overlap, so neighbors keep `walkwayCm` between them. The **wall bounds use the
  un-inflated footprint**, so furniture can still sit flush against a wall.
- **Walls:** the un-inflated footprint stays inside `boundsCm`.
- **Doors:** each door's `keepOut` is a fixed interval pair in the same no-overlap.
- **Fixed objects** (`movable: false`, or pinned) are fixed intervals, inflated like the rest.

### Rules
Every rule has an enforcement literal. For `must`, the literal is forced true. For
`should`, it's free and its violation is penalized in the objective.

| Rule | How |
|---|---|
| `pin` | `x`, `z`, rotation equal to current values |
| `against_wall` north | `r0` and `z = minZ + depth/2`. South: `r2`, `z = maxZ − depth/2`. West: `r1`, `x = minX + depth/2`. East: `r3`, `x = maxX − depth/2`. `any`: at least one of the four, via booleans |
| `near` | `|dx| + |dz| ≤ maxCm` using `add_abs_equality`. Soft: slack variable, penalty = weight × 20 × slackCm |
| `far_from` | `|dx| + |dz| ≥ minCm` (exact thanks to the abs variables) |
| `facing` a point | for the chosen rotation, the target must lie in that direction's quadrant. For rotation 0: `tz − z ≥ |tx − x|`; the other three are symmetric. Target may be an object's variables or a fixed point (window center, door center, room center). Soft: penalty = weight × 200 when unmet |
| `keep_clear` window | fixed rectangle in front of the window, `marginCm` deep, added to the no-overlap |
| `keep_clear` walkway | raises `walkwayCm` for this solve |

Center distance uses Manhattan distance (`|dx| + |dz|`): it's linear, and slightly
stricter than straight-line distance, which is fine for "near".

### Objective
Minimize:
- total movement: `|x − x0| + |z − z0|` per movable object, in cm,
- rotation changes: +25 for any change, +50 extra for a 180° flip,
- soft-rule penalties as above.

The weights mean one weight-5 soft rule is worth about a meter of movement: the solver will
move things for what you asked, but not for nothing.

### Solver settings
`max_time_in_seconds` from `timeLimitMs` (default 2 s), `num_workers = 1` by default
(measured fastest for rooms this size: ~70 ms), configurable by environment variable, fixed
`random_seed` so the same request gives the same answer in the demo. On timeout, return the
best `FEASIBLE` solution found.

### When it's impossible
Solve with one assumption literal per `must` rule. If the result is `INFEASIBLE`, return
`solver.sufficient_assumptions_for_infeasibility()` mapped back to rule ids as `conflicts`.
The agent uses this to explain *which* wishes clash and to relax them (see `03`, "Messy
data"). Door and walkway constraints are never assumptions: they can't be relaxed.

## Tests (pytest, like `services/fit`)

Use the sample room from the headset repo, converted to cm (inner faces x ±205, z ±175;
door keep-out x 35..125, z 85..175).

| # | Case | Pass when |
|---|---|---|
| 1 | Prototype request (sofa north wall, chair ≤120 cm from table) | OPTIMAL under 1 s; sofa z = −124, 0°; chair–table ≤ 120 |
| 2 | Any solution | Recompute every footprint: no overlaps (with walkway), all inside the walls, none in the door keep-out |
| 3 | `pin` on the chair | Chair unchanged; others still valid |
| 4 | No rules at all | Nothing moves (movedCm = 0) |
| 5 | `must near(chair, door:d1, 30)` | INFEASIBLE; `conflicts` contains that rule |
| 6 | Same rule as `should` | FEASIBLE; rule listed in `violated` with an amount |
| 7 | `against_wall any` for the storage | Flush against one wall, facing the room |
| 8 | `facing(chair, center)` | Chair's front points toward the room center |
| 9 | Same request twice | Identical output (fixed seed) |
| 10 | 12 objects, 6 rules | Returns within the time limit (FEASIBLE or better) |

## Not in v1
Stacking (lamp on a table), non-rectangular rooms beyond their bounding box, curved walls,
exact GLB shapes (footprint boxes are enough for furniture on a floor).
