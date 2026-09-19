# Headset: talking to the designer agent

Extends the current headset step. Reuses what exists: the wrist palette, halo, fit
ribbons, physics drag targets, `api.ts`, and `placements.ts` conversions. Everything here
must work against the stub fixtures before the real agent exists.

## What the person sees

**Wrist panel, new "Designer" row:** tiles *Reading corner*, *Open up the floor*,
*Clear the door*, *Face the window*. Same pull-the-trigger interaction as object tiles.

While the agent works, the row becomes a **status area**: one status line ("Solving…")
and the last three log lines, with warnings in amber. Text should be short enough to read
at arm's length; long lines are truncated with the full text on the laptop.

**When a proposal arrives:**
- **Ghosts:** a translucent copy of each object that will move, at its target spot and
  rotation, plus a thin line on the floor from where it is to where it's going. Objects
  that will move get the dim blue halo.
- **Fit ribbons for the proposed layout**, using the existing `fit.ts` renderer (the
  headset calls `POST /fit` for the proposed placements, exactly like it does for the
  current layout).
- The wrist shows the **explanation** (1–2 lines) and the **first tradeoff**, and three
  tiles: **Accept**, **Reject**, **Ask again**.

**Accept:** ghosts fade, and every moving object glides to its ghost through physics.
**Undo** stays on the wrist afterwards until the next request.

**Laptop (spectator view):** a text box for typed requests and a full, scrolling decision
log with timestamps. For the Rox judges, this log is the proof that the agent handled
messy data, so keep it visible during the demo.

## New module: `agent.ts`

A small state machine the palette and laptop both drive.

| State | Enters when | Shows |
|---|---|---|
| `idle` | start, after accept/reject/fail | Designer tiles |
| `working` | request sent (`202`) | status line + last 3 log lines |
| `proposed` | `agent.proposal` event or poll result | ghosts, proposal ribbons, explanation, Accept/Reject/Ask again |
| `applying` | accept returned `200` | objects gliding; tiles disabled |
| `failed` | `agent.failed` or poll error | the message, and "Try again" |

- **Sending:** `POST /v1/agent/{roomId}/requests` with the preset or text, `baseVersionId`
  (current Version), and `pins`: the object being held, plus anything placed in the last 60 s.
- **Listening:** subscribe to `agent.*` events on the existing sync feed **and** poll
  `GET .../requests/{id}` every second while `working` (sync is still a stub). Ignore
  duplicate log entries (same `at` + `message`).
- **Accept `409`:** the room changed since the proposal (someone moved something). Show
  "The room changed. Ask again?" and re-send the same request on the new Version.
- **Server down:** use the built-in proposal fixture, like the room fixture, and say so on
  the wrist ("Offline: showing the sample proposal").

## Applying a proposal with physics

Each move becomes a drag target through the same path as grabbing, so objects still stop at
walls and slide along them.

1. Convert each `to` placement with `placements.ts` (Version v1 → scene).
2. **While applying, moving objects don't collide with each other**, only with the room and
   non-moving objects (Rapier collision groups). Otherwise two objects swapping places jam
   halfway. Restore the normal groups when all have arrived.
3. An object has arrived when it's within 2 cm and 2° of its target: release it.
4. After 4 s, release anything still moving and log "Couldn't reach its spot" for it. The
   saved layout is then whatever physics settled on, which is honest and visible.
5. When all are released, save the layout as usual, so the stored Version matches what's
   actually in the room.

If the person grabs an object during `proposed` or `applying`, that object is excluded
from the move and stays in their hand; the rest continue.

## Ghost rendering (Quest performance)
- Ghosts share the objects' geometry with one shared translucent material; no extra textures.
- Detected boxes without a GLB get an outline box as their ghost.
- At most one proposal's ghosts exist at a time; dispose them on accept/reject.

## Tests (Node, like the existing 22)
| # | Test | Pass when |
|---|---|---|
| 1 | State machine walks the stub timeline | idle → working → proposed with all fixture log entries, in order, no duplicates |
| 2 | Poll and SSE deliver the same proposal | Only one proposal handled |
| 3 | Accept `409` | Moves to "room changed" and re-sends with the new base Version |
| 4 | Ghost placement | Proposal placements → `placements.ts` → scene → back gives the same numbers |
| 5 | Apply: two objects swapping places | Both arrive within 2 cm and 2° (collision groups off between them) |
| 6 | Apply: target inside a wall (bad data) | Object stops at the wall; "couldn't reach" logged after 4 s |
| 7 | Pins | A held object is sent in `pins` and never gets a drag target |
| 8 | Palette hit-testing | New Designer tiles are hit where drawn, like the object tiles |

## Quest checklist
1. Designer tiles readable and hittable on the wrist; ray goes green on them.
2. Status and log lines readable while working.
3. Ghosts clearly distinguishable from real objects; movement lines visible on the floor.
4. Proposal ribbons appear, and match the fit ribbons after accepting.
5. Accept: objects glide smoothly, don't jam, stop at walls; frame rate stays smooth.
6. Undo restores the previous layout.
7. Grabbing an object during a proposal keeps it in your hand.
