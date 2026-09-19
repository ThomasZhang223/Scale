# Justin — components D and E

## Scope

You own the WebXR/Quest runtime (D) and the fit engine and solver (E). D rebuilds the scanned
room from `RoomCapture v1` primitives in three.js with `@react-three/xr` — walls as boxes,
openings as gaps, unscanned furniture as per-category proxies, no mesh download for the room by
design — loads GLBs by URL onto the Quest, lets a user grab/move/rotate an object, scrubs
through versions, and draws `FitReport` violations in red. E is two HTTP endpoints: `/fit`
validates a layout against clearance, door swing, window occlusion, and wall adjacency; `/solve`
optimises a layout on a grid with OR-Tools or `scipy.optimize`, taking an LLM-authored objective
and constraints but never LLM-authored coordinates.

**You own**
- Room reconstruction from `RoomCapture v1` JSON (boxes, gaps, proxies).
- GLB loading, glTF transform correctness (column-major, no transpose).
- Grab/move/rotate, version scrubber, `FitReport` geometry rendering (`arc`, `polyline`, `rect`).
- `POST /fit` — clearance corridors, door swing arcs, window occlusion, wall adjacency.
- `POST /solve` — grid discretisation, optimiser, LLM-to-objective translation.

**You do not own**
- The iOS app, backend, or the four schemas (Thomas).
- Baseten, inference, or the scale binding (Ani).
- OMNI voice or catalog scraping (Paul).

## Your interfaces

You are a pure consumer for D and a pure producer for E.

| Direction | What | Schema / endpoint | Counterparty |
| --- | --- | --- | --- |
| Consume | Room primitives to rebuild | `RoomCapture v1` via `GET /rooms/{id}` | Thomas (B) |
| Consume | Version list and a specific version | `GET /rooms/{id}/versions`, `GET /versions/{id}` → `Version v1` | Thomas (B) |
| Consume | Object metadata and mesh URL | `Object v1` (`glbUrl`, `bboxMeters`) via `GET /objects/{id}` | Thomas (B) / Ani (C) |
| Consume | Live updates, no polling | `GET /sync/{roomId}` SSE — `object`, `version`, `fit` events | Thomas (B) |
| Consume | Bound mesh satisfying the normalisation contract | `objects/{objectId}/mesh.glb` in R2 | Ani (C) |
| Produce | Layout validation | `POST /fit` → `FitReport v1` | Thomas (A, phone) and yourself (D draws it) |
| Produce | Optimised placements | `POST /solve` → `{ placements, objective, infeasible? }` | Paul (F, agent loop) |

`FitReport v1` geometry is your list to own: only `arc`, `polyline`, `rect`. Adding a fourth is a
contract change — announce it before you push it.

## Hour by hour

| Hour | Task | Blocks whom |
| --- | --- | --- |
| H-4–H0 | Quest in developer mode; browser reaches the laptop over the travel router | — |
| H0–H1.5 | three.js + `@react-three/xr` scene shell; headset reaches the laptop | — |
| H1.5–H4 | Fixture room renders in the Quest at correct scale, from `fixtures/room-demo.json` | Skeleton gate (H4, judged by Ani) — if the fixture GLB doesn't travel phone→server→Quest, all four stop and debug transport |
| H4 | Sync: report status, confirm skeleton gate passed | — |
| H4–H10 | Room rebuild from a real capture; real GLB load; glTF transform handling; grab and move | Needs Thomas's real `RoomCapture v1` (due H6) and Ani's real bound GLB (due H8) to go past fixtures |
| H6 | Verify a real `RoomCapture v1` renders correctly | Binding gate (H6) is Ani/Thomas's, not yours — just confirm you received the real capture |
| H8 | Load a real bound GLB from Ani; verify 1:1 with a tape measure | If this fails, the demo spine (H10) is at risk — flag immediately, don't sit on it |
| H10 | Exit: a stranger's object reaches the headset at true scale | Demo spine gate (H10, judged by Paul) — failing this cuts the headset per sprint plan |
| H10–H16 | Fit validator: door swing arcs, clearance corridors; draw `FitReport` geometry in red | `FitReport v1` consumed-and-drawn proof owed to Thomas by H12 |
| H12 | Prove the `FitReport v1` shape by consuming and drawing a real one | Thomas — this is the contract's only hard deadline in your outbound direction |
| H16 | Stop starting new work; rehearse one complete path, badly | — |
| H16–H20 | Freeze a candidate path; write your track submission text | — |
| H20 | Track lock sync — fit engine's existence is judged here | All four, for the pitch |
| H20–H28 | The solver: grid discretisation, OR-Tools or `scipy.optimize` | Paul's agent loop (`scout → fit → style → budget`) reads `/solve` — no hard hour committed, but it's on the critical path for his loop |
| H26 | Sync: status check | — |
| H28–H31 | Hardening: solver edge cases, infeasible-case wording, headset polish | — |
| H31 | Feature freeze. Nothing merges except fixes | All four |
| H31–H33 | Rehearsal on the venue network, floor full, five full runs | The demo itself |
| H33–H34 | Buffer; submit at H34, not H36 | — |

## Done when

**D**
- A person in the headset stands in the scanned room at 1:1 scale.
- An object pushed from the phone appears in the headset within 3 seconds.
- Grab, move, and rotate work on a placed object.
- The version scrubber replays history (phone is the fallback location if this is cut).

**E**
- `POST /fit` reports door-swing and clearance violations with correct `arc`/`polyline`/`rect` geometry, drawable without re-deriving anything.
- `POST /solve` returns placements for a solvable room without any LLM-emitted coordinate.
- The solver returns `infeasible` on an over-stuffed room, and the system states why in words: e.g. no arrangement of these three pieces keeps a 90 cm walkway to the door — drop the ottoman, or go 20 cm narrower on the couch.
- A `scale` other than 1.0 on any placement raises a warning — it means the normalisation contract broke upstream.

## Cut list, in order

D is cut before E. Cut the headset down to nothing before you touch the validator.

1. The version scrubber in the headset — keep it on the phone, where the Expo judges see it.
2. Object manipulation in the headset — a read-only walkthrough still lands the 1:1 beat.
3. The whole headset — fall back to the phone-only demo.
4. The solver (`/solve`) — keep the validator. A warning is 80% of the beat for 20% of the work.
5. Window occlusion and wall adjacency in the validator — keep door swing and clearance.
6. Sun simulation (an optional extension of window occlusion) — never fake it if it's cut; a fake sun costs credibility for zero savings once `worldAlignment` already gives real compass bearings.

## Traps

- **Column-major, no transpose.** `THREE.Matrix4.fromArray` on the 16-float transform with no
  transpose matches `simd_float4x4` memory order. Prove it before trusting it: load
  `fixtures/room-demo.json`, render one wall, and check it lands where the fixture's floor
  polygon and compass bearing say it should — not just "looks like a room." A wrong convention
  produces a room that looks plausible and is mirrored or rotated. That is the most expensive
  silent bug available to you.
- **Never rescale a GLB.** The mesh normalisation contract guarantees the bounding box already
  equals `bboxMeters`, origin at bottom-centre, +Y up, −Z front, node scale 1. A second rescale
  on your end squares the error and nobody finds it until the demo.
- **Do not use Unity.** It costs about five hours in build-and-deploy cycles that WebXR doesn't
  have. WebXR hot-reloads from the laptop and renders the same scene in a desktop browser for
  the casting monitor.
- **Quest browser speech is inconsistent.** Don't plan on in-headset voice. If voice must reach
  the headset, that's push-to-talk streaming audio to the server, and it's Paul's call, not
  yours.
- **The room has no downloadable mesh, by design.** Transport is JSON primitives, never USDZ —
  this is deliberate and sidesteps the USDZ→GLB conversion chain entirely. Don't go looking for
  a room mesh; there isn't one.
- **Conference Wi-Fi will not carry the sync.** Everything — phone, server, Quest — goes on the
  travel router. Test the full push path on it during rehearsal, not with the access point to
  yourself at 3am.
- **You can build the entire runtime with no phone and no server.** All four fixtures
  (`fixtures/room-demo.json`, `fixtures/object-macbook.json`, `fixtures/mesh-macbook.glb`,
  `fixtures/fitreport-doorswing.json`) are committed at H0 and every `/v1` endpoint answers them
  when the request carries `X-Stub: 1`. If you're blocked on a person, you're doing it wrong.
- **No AR/VR track in 2026.** Ubisoft ran one in 2024, Snap in 2025, nothing this year. Every
  Quest hour earns zero sponsor points and is demo spend, not investment. E is the unclaimed
  half of the pitch. If you're behind, E beats D — cut D toward the phone-only fallback first.

## Who to ask

| Person | They owe you | Due | You owe them | Due |
| --- | --- | --- | --- | --- |
| Thomas (A, B) | Fixtures and the `X-Stub: 1` layer; a real `RoomCapture v1` from a real scan | H1.5; H6 | `FitReport v1` consumed and drawn, so the shape is proven | H12 |
| Ani (C) | A real GLB that satisfies the mesh normalisation contract | H8 | Nothing | — |
| Paul (F, P3) | Nothing | — | `/solve` answering, so his agent loop has an optimiser | H24 |

Every edge above comes from the dependency table in `.claude/contracts.md`, which is the
authority. If you are going to miss one, say so at the previous sync point, not at the due hour.
