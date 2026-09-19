# End-to-end tests

Each hop of the pipeline is tested on its own with committed fixtures, then the whole chain
is tested together, then rehearsed on the Quest. Commit the fixtures under
`fixtures/pipeline/` so every piece tests against the same data.

## Golden fixtures (commit these first)

Build them from the worked example in `08_PROTOCOL.md` (sample room, "Reading corner by the window").

| File | Contents | Used by |
|---|---|---|
| `room-facts.json` | Hop ① input: the room summary sent to the LLM | Worker |
| `plan.json` | Hop ② output: the constraint plan | Worker, solver |
| `plan-invalid.json` | A plan with an unknown id, a self-reference and `maxCm: 5` | Worker |
| `solve-request.json` | Hop ④: the resolved request | Solver |
| `solve-response.json` | Hop ⑤: the response with the real numbers | Worker, headset stub |
| `solve-infeasible-request.json` | Chair `must` near the door (30 cm) + the door keep-out | Solver, Worker |
| `proposal.json` | Hop ⑦: the proposal the headset receives | Headset |
| `conversion-vectors.json` | Pose conversion test vectors (below) | Worker **and** headset |

`solve-response.json` records one real solve. The solver may return a different but equally
good answer after code changes, so **solver tests check properties, not exact coordinates**;
the fixture is used as fixed input by the Worker and headset tests.

## Conversion vectors (shared by Worker and headset)

The two conversion points (Worker: solver ↔ Version; headset: Version ↔ scene) must agree.
One file of vectors, tested on both sides:

| Case | Solver frame | Scene |
|---|---|---|
| Origin, facing forward | (0, 0), 0° | (0, 0, 0), rotY 0 |
| Chair from the example | (−115, −140), 0° | (−1.15, 0, −1.40), rotY 0 |
| Storage | (−185, 80), 90° | (−1.85, 0, 0.80), rotY π/2 |
| Facing −Z | (50, 50), 180° | (0.50, 0, 0.50), rotY π |
| Facing −X | (−50, 0), 270° | (−0.50, 0, 0), rotY 3π/2 (or −π/2) |
| Room rotated θ = 12°, object at solver (100, 0), 0° | | (0.978, 0, −0.208), rotY 12° in radians |
| Unmoved odd angle: original rotY 37° | returned unchanged | rotY 37° exactly (not snapped) |

Also include each vector converted through Version v1, so both sides test the Version form.

For the rotated case: rotating (1.00, 0) by +12° about Y in three.js gives
x = cos 12° ≈ 0.978, z = −sin 12° ≈ −0.208. Check the sign with three.js itself
(`new Vector3(1,0,0).applyAxisAngle(up, θ)`) when writing the test, and use that as the truth.

## Hop tests

### Solver (pytest), in addition to the 10 tests in `02`
| # | Input | Pass when |
|---|---|---|
| S1 | `solve-request.json` | `OPTIMAL`; r1 and r2 satisfied; chair ≤100 cm (Manhattan) from (−50, −175); no overlaps including 60 cm walkways; nothing in the door keep-out; all inside the walls |
| S2 | `solve-infeasible-request.json` | `INFEASIBLE`; `conflicts` contains the near-door rule |
| S3 | Request without credentials header | `401`, no solve |
| S4 | `GET /health` | `200` with the OR-Tools version |

### Worker
| # | Test | Pass when |
|---|---|---|
| W1 | Build room facts from the sample room | Equals `room-facts.json` |
| W2 | Validate `plan-invalid.json` | Three precise errors, matching `08` ③ wording |
| W3 | Resolve `plan.json` | Equals the rules in `solve-request.json` (window → point, center → point) |
| W4 | Add hard rules | Door keep-out, walkway, pins and preferences appear; LLM can't remove them |
| W5 | Convert `solve-response.json` back | Placements match `conversion-vectors.json`; storage (unmoved) keeps its exact original pose |
| W6 | Repair loop with the infeasible fixture (solver stubbed) | Relaxes the latest conflicting `must`, logs it, re-solves once |
| W7 | Fit loop (fit stubbed to return one red, then clean) | Strengthened rule added; second round accepted; 2 log entries |
| W8 | Planner stubbed to return invalid twice | Request fails with a readable message; both attempts logged |
| W9 | Solver unreachable (tunnel down) | Fails within 5 s with the "solver isn't reachable" message; stub proposal used for presets |
| W10 | Explanation from facts | Output only mentions objects that moved; template fallback when the call fails |

### Headset (Node), in addition to the 8 tests in `04`
| # | Test | Pass when |
|---|---|---|
| H1 | `conversion-vectors.json` through `placements.ts` | All vectors match both ways |
| H2 | `proposal.json` → ghosts | One ghost per moved object at the converted pose; none for unmoved ones |
| H3 | Apply `proposal.json` in the sample room with physics | Sofa, chair and table arrive within 2 cm / 2°; nothing passes through walls; storage never moves |

## Whole chain

Run with the real Worker (`wrangler dev` or deployed), the real solver behind the tunnel, and
a **stubbed planner** returning `plan.json` (so the test is deterministic and free):

| # | Scenario | Pass when |
|---|---|---|
| E1 | "Reading corner" preset on the sample room | Proposal arrives in under 5 s; chair near the window; `/fit` shows 0 red; log shows plan → solve → fit |
| E2 | Accept E1 | Version becomes current; `version.current` emitted; headset objects match the Version within 2 cm |
| E3 | Undo | Previous Version restored; preference stored; the same request again logs "Remembered: …" |
| E4 | Accept after someone moved an object | `409`, "room changed", re-run succeeds on the new Version |
| E5 | Mirrored door fixture | Data log entry about the door; proposal still has 0 red issues |
| E6 | Solver laptop's `cloudflared` stopped | Clear failure within 5 s; health shows "Solver offline"; preset falls back to the stub |

Then once with the **real planner** (OpenAI through AI Gateway) for each preset and two typed
requests. Check: valid plan on the first try, sensible rules, total time under 15 s, and the
calls visible in the AI Gateway log.

## Quest rehearsal (the demo script in `05`, twice)

1. Reset memory and room. Health shows "Solver online".
2. Chair drops onto its detected spot.
3. Sofa pulled from the wrist and dropped in front of the door: red ribbon.
4. *Clear the door*: status lines, ghosts, proposal ribbons; Accept; smooth glide, no jams.
5. Typed hard request on the laptop: tradeoff shown on the wrist and in the log.
6. Undo, ask again: "Remembered" in the log; that object stays put.
7. Pull the laptop's network for 10 s mid-request: the agent reports the solver offline and nothing freezes.
8. Frame rate smooth throughout.

Record timings from the rehearsal for the submission (request time, solve time, test counts).
