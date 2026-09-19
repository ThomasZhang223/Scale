# Room scan in VR, with scanned objects

A three.js WebXR page for the Meta Quest. It builds a room from a RoomPlan scan
(`CapturedRoom` JSON) and fills it with scanned objects (GLB files, e.g. from Object
Capture) at their real size, with physics: objects land on the floor, can't pass through
walls or furniture, stay upright, and can be grabbed and moved.

**Owner:** Justin (components D and E). Scope in `.claude/workstreams/justin.md`; every
schema and endpoint this consumes is in `.claude/contracts.md`; transform conventions in
`docs/TRANSFORMS.md`.

## Run it

```bash
npm install
npm run dev          # laptop: http://localhost:5173
npm run quest        # Quest over USB: adb reverse, then open http://localhost:5173 → Enter VR
```

The room from `fixtures/room-demo.json` (the team's `RoomCapture v1` sample, at the repo
root) rises out of the floor. The sample chair drops into the spot where a chair was
detected, replacing its grey box; the sample sofa has no match there, so it lands at a
free spot in front of you.

Two room formats are accepted: `RoomCapture v1` as defined in `.claude/contracts.md` (what
the phone app and server send; a `schemaVersion` other than 1 is refused loudly), and raw
RoomPlan `CapturedRoom` JSON straight from Apple's exporter (`public/room-scan.json` is one;
open it with `?scan=/room-scan.json`).

## What happens to a GLB

1. **Real size is kept.** Object Capture exports in meters, so objects are never stretched
   to fit a box. Files that are clearly in centimeters or millimeters (bigger than 5 m)
   are converted, and the panel says so. A `scale` in `objects.json` overrides this.
2. **Origin moves to the bottom-center**, so an object's position is the spot on the floor
   under it.
3. **A physics shape is made from its surface**: a convex hull around the real shape,
   not just a box.
4. **Placement:**
   - If the file name contains a category RoomPlan detected (`chair.glb`,
     `my-sofa-scan.glb`), the object takes that piece's spot and direction, and the grey
     box disappears. If the real object is bigger than RoomPlan's box, it's nudged the
     smallest distance needed to fit (the sample sofa moves 10 cm off the wall).
   - Otherwise it drops at the nearest free spot in front of where you stand.
5. **The panel reports both sizes**, for example
   `sofa: 2.19 × 0.79 × 1.02 m, in place of the detected sofa (2.00 × 0.85 × 0.90 m)`,
   so you can see how the scan compares with what RoomPlan measured. The console prints
   a table of all objects.

## Physics

- The floor, every wall, and every detected piece of furniture are solid, built from the
  same numbers as the visible room, so physics never disagrees with what you see.
- Scanned objects fall, collide, and push each other. Tipping over is locked (turning
  isn't): furniture falling over in a demo looks broken, not realistic.
- Moving an object pulls it toward your pointer instead of teleporting it, so it stops
  at walls and shoves other objects out of the way.
- **Show physics shapes** in the panel draws every collider in green, to check that a
  scan's shape and the room's walls line up.

## Controls

| Where | Add | Move | Turn |
|---|---|---|---|
| Quest | Point the right ray at the palette on your left hand (ray turns green), pull the trigger on a tile, and carry the copy out | Point (ray turns blue), hold the trigger, sweep across the floor | Thumbstick left/right while holding |
| Laptop | **Add …** buttons in the panel | Drag with the mouse | Scroll while dragging (15° steps) |

Letting go leaves the object where it is. Every pull from the palette is a fresh copy.

## Adding your own

- **Room:** open `?scan=<url>` or drop a `.json` on the page, in either format above.
- **Objects:** list them in `public/objects.json`, or drop `.glb` files on the page
  (several at once works):

```json
[
  { "url": "/objects/chair.glb", "name": "chair" },
  { "url": "/objects/lamp.glb", "name": "floor lamp", "scale": 0.01 }
]
```

Every entry appears in the palette. `name` decides what happens at start: include a
RoomPlan category (`chair`, `sofa`, `table`, `bed`, `storage`, `television`, …) and the
object takes that detected piece's place straight away; anything else waits in the palette
until you pull it out.

**Reset** rebuilds the room and puts every object back in its starting spot.

## Files

| File | Job |
|---|---|
| `src/main.ts` | Wires it together: scene, VR button, loading rooms and objects, placement, panel |
| `src/roomScan.ts` | Room JSON → three.js room; recenters ARKit's origin; marks walls and detected furniture for physics |
| `src/objects.ts` | GLB → real-size object with a bottom-center origin and hull points; fixes cm/mm files |
| `src/physics.ts` | Rapier world: solid room, upright objects, free-spot search, collision-aware dragging |
| `src/interaction.ts` | Quest controllers and laptop mouse, both moving objects through physics |
| `src/api.ts` | The team's `/v1` API: room, objects by `glbUrl`, the SSE live feed, schema and bbox checks |
| `src/agent.ts` | The designer agent client: request, poll + SSE, accept / reject / undo, offline fallback |
| `src/apply.ts` | Applies a proposal through physics drag targets (2 cm / 2° arrival, 4 s give-up) |
| `src/ghosts.ts` | Ghost outlines and movement lines for a proposal |
| `src/fit.ts` | Red / amber fit ribbons on the floor |
| `src/placements.ts` | Version v1 placements ↔ scene coordinates |
| `src/palette.ts` | The wrist palette in VR |
| `src/halo.ts` | Blue halo on the pointed-at / held object |
| `public/room-scan.json` | Sample room (off-center like a real ARKit scan) |
| `public/objects.json` | Objects loaded at start |
| `public/objects/` | Sample chair and sofa (CC BY 4.0, see `ATTRIBUTION.md`) |

## Checked so far

`npm test` runs the committed Node tests (`src/roomScan.test.ts`): the fixture room is
recentered with the floor at y = 0, a wall lands where the fixture's floor polygon says
(the column-major, no-transpose proof from `docs/TRANSFORMS.md`), the chair's yaw is +45°,
`openings` split into a solid door and a translucent window, a wrong `schemaVersion`
throws, the raw RoomPlan sample still builds, and Rapier treats the detected chair as
solid until `removeDetected` frees its spot.

Also tested in Node earlier, with the physics engine and the real sample GLBs (textures
stripped, since decoding them needs a browser):

- A file in centimeters is converted to meters; the origin ends up at the bottom-center.
- Objects land exactly on the floor and don't spawn on top of the table.
- Dragged into a wall, an object stops at the wall's face; dragged into the detected
  sofa, it stops at the sofa's front; it stays upright and stays put when released.
- The sample chair lands in the detected chair's exact spot and direction. The sample
  sofa, bigger than RoomPlan's box, lands 10 cm off the wall, inside the room.

**Needs checking on the Quest:** frame rate with several objects, how dragging feels with
the controller ray, and textures (the Node test couldn't decode them). If frame rate
drops, optimize the GLBs first:
`npx @gltf-transform/cli optimize in.glb out.glb --compress draco --texture-compress webp`.

## The designer agent

Pull a **Designer** tile on the wrist (*Reading corner*, *Open up the floor*, *Clear the
door*, *Face the window*) or type a request on the laptop. The wrist shows the agent
working ("Reading room…", the last three decisions), then ghost outlines where things will
go with a line from where they are, the explanation and any trade-off, and **Accept** /
**Reject** / **Ask again**. Accept glides the furniture into place through physics (it still
stops at walls; movers ignore each other so swaps don't jam); **Undo** puts it back.
Whatever you're holding is pinned. The laptop panel keeps the full decision log — that's
the evidence of how the agent handled messy data.

The agent itself is `services/agent` (a Cloudflare Worker, one Durable Object per room);
the page reaches it at `/v1/agent`, proxied by Vite to `VITE_AGENT_PROXY` (default
`http://127.0.0.1:8789`). With the agent down, the built-in sample proposal plays and the
wrist says "Offline". `?agentstub=1` uses the agent's fixture timeline. See
`docs/agent/` for the whole design.

## The server

The page talks to the team's Worker (Thomas's, `workers/`) exactly as `.claude/contracts.md`
lays out, and every request carries `X-Stub: 1` by default, so his committed fixtures come
back until the real backend exists:

- `GET /v1/rooms/{id}` — the room at start (`?room=<id>`; default `VITE_ROOM_ID`, else the
  fixture's id). If the server doesn't answer, the committed fixture is shown and the panel
  says so.
- `GET /v1/objects/{id}` — `?object=<id>[,<id>]` loads objects by their `glbUrl` at scale 1.
  A GLB is never rescaled here; if its box differs from `bboxMeters` by more than 1 mm, the
  panel says the normalisation contract broke upstream.
- `GET /v1/sync/{roomId}` — the room's live feed. Every `object` event with `state: "ready"`
  is loaded and placed. `version` and `fit` events are logged for now.

In dev, Vite proxies `/v1` to `VITE_API_PROXY` (default `http://127.0.0.1:8787`, i.e.
`wrangler dev` in `workers/`), so there's no CORS to configure and the Quest reaches it over
the same USB port-forward. Copy `.env.example` to `.env` to change any of this;
`VITE_API_STUB=0` drops the stub header.
