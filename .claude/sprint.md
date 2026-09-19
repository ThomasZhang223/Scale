# Sprint plan — 36 hours, four people in parallel

H0 is Friday 18:00. Track lock is H20, Saturday 14:00. The deadline is H36, Sunday 06:00, and we submit at H34. Adjust H0 here and
nowhere else, because every hour below is relative to it.

Four people work at the same time in every block. Nobody waits on a person; they wait on a
fixture, and the fixtures land at H1.5.

## The one serialisation

Thomas owes the fixtures and the `X-Stub: 1` layer by **H1.5**. Until then the other three do
work with zero dependencies: Justin builds the three.js scene shell, Ani provisions Baseten and
times a cold start, Paul verifies merchant endpoints. After H1.5 nobody is blocked by a person
for the rest of the weekend.

## H−4 to H0 — before the clock

- [ ] **Thomas** — Xcode, `expo-dev-client`, a LiDAR iPhone provisioned and building.
- [ ] **Justin** — Quest in developer mode, browser reaching the laptop over the travel router.
- [ ] **Ani** — Baseten account, Stable Fast 3D deployed, 20 test objects run through it.
- [ ] **Paul** — owns merchant discovery end to end: choose the vendors, verify `/products.json` reaches them, and decide which other listing sources are worth the time. OMNI API key working.
- [ ] **All** — travel router bought and tested. Every device on it.

## H0–H4 — integration spike, no features

The skeleton moves hardcoded data end to end. Nobody writes a feature in this block.

| Hour | Thomas (A, B) | Justin (D, E) | Ani (C) | Paul (F, P3) |
| --- | --- | --- | --- | --- |
| H0–H1.5 | Repo scaffold, Docker compose, **the four fixtures**, `X-Stub: 1` layer | three.js + `@react-three/xr` scene shell, headset reaches the laptop | Baseten endpoint live, cold start timed on venue network | Pull catalogs from the verified merchants, index locally |
| H1.5–H4 | RoomPlan native module returns `RoomCapture v1` | Fixture room renders in the Quest at correct scale | Fixture image → mesh, round trip timed | Regex dimension pass over the pulled catalog |
| H4 | Push of the fixture GLB works phone → server → Quest | Same, from the receiving end | Report the real end-to-end generation latency | Report the real extraction hit rate |

**H4 sync, 15 minutes, all four.** See the gates in `#kill-criteria`.

## H4–H10 — core paths

| Thomas | Justin | Ani | Paul |
| --- | --- | --- | --- |
| Real `/rooms`, `/objects`, `/uploads`, job records, SSE fan-out | Room rebuild from a real capture, GLB load, glTF transform handling, grab and move | **The scale binding.** Background removal. The job worker. | LLM pass on `body_html`, then the validation layer |
| Object scan flow on the phone, measured box under 1 s | Load a real bound GLB from Ani and verify 1:1 with a tape measure | Verify the binding with a tape measure before telling anyone it works | Facebook Marketplace ingest spike, timeboxed to 2 hours |

**Exit at H10.** A stranger scans a real object and it appears in the headset at true scale.
That is the demo spine. Everything after this is depth.

## H10–H16 — depth, all four in parallel

| Thomas | Justin | Ani | Paul |
| --- | --- | --- | --- |
| Expo app shell: room list, object library, version history UI | Fit validator: door swing arcs and clearance corridors | `quality` tier, pre-bake the catalog unattended | OMNI voice loop on the phone: vision + speech + language |
| Version write and diff, `/push` | Draw `FitReport` geometry in red in the headset | Image embeddings written on `state:"ready"` | Search ranking over Ani's embeddings |

**H16 — stop starting new work.** Get one complete path working. Rehearse it once, badly.

## H16–H20 — freeze a candidate, then lock tracks

Everyone converges on one working path and writes their track submission text. The track lock
at H20 happens with a working demo in hand, not a hoped-for one.

## H20–H28 — second pass

Build only what the selected tracks are graded on.

| Thomas | Justin | Ani | Paul |
| --- | --- | --- | --- |
| Phone version scrubber, AR bookend, submission material | **The solver.** Grid discretisation, OR-Tools or `scipy.optimize` | Inference hardening, pre-bake more catalog, latency tuning | The agent loop: scout → fit → style → budget |

If Shopify and Rox were not selected at H20, Paul drops P3 and moves to search plus voice depth.

## H28–H31 — hardening, freeze at H31

H31 is a hard line. After it: bug fixes, demo data, and rehearsal only. A feature that lands at
H33 has never been rehearsed and is likelier to break the demo than to improve it.

## H31–H33 — rehearsal on the venue network, floor full

Run the full 60 seconds five times, with a different person holding the phone each time.
Time the push. Rehearse the failure path out loud: what the presenter says when generation takes
20 seconds, and what happens when it returns a bad mesh.

## H33–H36 — buffer and submission

Submit at H34, not H36. Rotate sleep so two people are alert for judging.

## Sync points

Fifteen minutes, standing, all four. H4, H10, H16, H20, H26, H31.

Each person answers three questions and nothing else:

1. What landed since the last sync.
2. What I owe someone, and whether it is on time.
3. What I will cut if I am behind at the next sync.

## Kill criteria

A gate is decided by someone who does not own the work being judged.

| Gate | Hour | Test | If it fails | Judged by |
| --- | --- | --- | --- | --- |
| Native module | H4 | Expo returns valid `RoomCapture v1` | Drop Expo, ship pure Swift, lose the primary track | Justin |
| Skeleton | H4 | Fixture GLB travels phone → server → Quest | All four stop features and debug transport | Ani |
| Binding | H6 | A generated mesh measures true against a tape measure | Fall back to a textured box at measured dimensions | Thomas |
| Demo spine | H10 | A stranger's object reaches the headset at true scale | Cut the headset, move to the phone-only demo | Paul |
| Track lock | H20 | Fit engine exists? P3 exists? Voice runs all three modalities? | Select for what exists, and change the pitch that afternoon | All four |
| Feature freeze | H31 | Nothing merges except fixes | Revert the branch. Do not negotiate this at H32 | Thomas |

## Critical path

**On it.** Thomas's native module and `/objects` plus SSE. Ani's binding. If either slips the
demo has no spine.

**Can slip without killing the demo.** Justin's solver, Paul's whole workstream, the version
scrubber, P3, the shareable link.

**Can slip without killing the pitch.** The headset. There is no AR/VR track in 2026, so every
Quest hour is demo spend, not sponsor points. Keep the phone-only path complete at all times.
