# Thomas — Components A + B

## Scope

You own iOS capture and the Expo app shell (component A) and the backend and data layer
(component B), plus repo scaffolding, Docker containerization, and the data schemas. You wrote
`.claude/contracts.md`, so you own every contract change. Your one hard deadline is the four
fixtures plus the `X-Stub: 1` layer at H1.5 — Justin, Ani, and Paul are all blocked on a person,
not a fixture, until it lands.

**You own:**
- Expo Router + Expo UI app shell; two Swift native modules via the Expo Modules API
  (`RoomCaptureView` wrapper, RealityKit `ARView` wrapper with USDZ + QuickLook fallback)
- 3D browsing on-phone via `expo-gl` + three.js; Live Activity for generation progress;
  haptics on a fit violation
- Cloudflare Workers orchestration, R2, D1, Vectorize, the job queue, one Durable Object per
  room for SSE fan-out
- The four committed fixtures and the `X-Stub: 1` layer (H1.5, blocks three people)
- Docker containerization for anything that must run locally (solver, scraper) so Justin and
  Paul get a reproducible `docker compose up`
- The `POST /search` endpoint shape (Paul owns ranking behind it, Ani owns writing embeddings)
- Repo scaffolding, the four schemas, and all contract changes

**You do not own:**
- The WebXR/Quest runtime or the fit solver (Justin, components D/E)
- Baseten, inference, or the scale binding (Ani, component C)
- OMNI voice loop or scraping agents (Paul, components F/P3)

> **Path note.** Paul's OMNI voice loop runs inside your Expo app. At H1.5 you ship the Swift
> Speech native module, its config-plugin entry, and a `VoiceScreen` stub exporting start,
> stop, and a transcript callback. Paul then writes JavaScript only, under
> `apps/mobile/src/voice/**`. Do this with the scaffolding, not at H12 when he needs it.
> Same rule for `docker-compose.yml` and `app.json`: every service and permission goes in at
> H1.5, including placeholders for work nobody has started.

## Your interfaces

| Direction | Item | Schema / endpoint | Counterparty |
| --- | --- | --- | --- |
| Consume | Real GLB bound to `bboxMeters`, mesh normalisation satisfied | mesh normalisation contract, `objects/{objectId}/mesh.glb` | Ani (C) |
| Consume | Fit violations to draw and haptic on | `FitReport v1`, `POST /fit` | Justin (E) |
| Consume | The search query shape he actually needs | `POST /search` request body | Paul (F) |
| Consume | Style vectors populating hybrid query | Vectorize index `objects-v1` | Ani (C) |
| Produce | Room scan | `RoomCapture v1`, `POST /rooms` | Justin (D, E) |
| Produce | Measured object, `state:"measured"` in under 1s | `Object v1`, `POST /objects`, `GET /objects/{id}` | Ani (C), Justin (D), Paul (F) |
| Produce | Presigned upload target | `POST /uploads` | Ani (C) |
| Produce | Version history and diffs | `Version v1`, `POST/GET /rooms/{id}/versions`, `GET /versions/{id}` | Justin (D), Paul (F) |
| Produce | Room push notification | `POST /push/{roomId}` | Justin (D), Paul (F) |
| Produce | SSE fan-out on room change | `GET /sync/{roomId}` | Justin (D) |
| Produce | `/search` endpoint shape (you own the contract, not the ranking) | `POST /search` | Paul (F) implements ranking behind it |

## Start here

The scaffold boots. `apps/mobile/README.md` has a four-step runbook that gets you from a clean
clone to the app on your phone talking to the Worker's stub layer, before you write any Swift.
Do that first — it proves the transport, and the transport is what the H4 gate checks.

The home screen already pings `GET /v1/rooms/{id}` under `X-Stub: 1` and shows the result. If it
reads `stub layer OK — 4 walls`, the whole loop works and you can start on the native module. If
it reads `unreachable`, it is the LAN address or the router, not your code.

## Hour by hour

| Hour | Task | Blocks whom |
| --- | --- | --- |
| H−4–H0 | Xcode set up, `expo-dev-client`, LiDAR iPhone provisioned and building | — |
| H0–H1.5 | Repo scaffold, Docker compose, **the four fixtures**, `X-Stub: 1` layer | **Justin, Ani, Paul — the one hard deadline** |
| H1.5–H4 | RoomPlan native module returns real `RoomCapture v1` | Justin (H4 gate, he judges) |
| H4 | Push of the fixture GLB works phone → server → Quest | Skeleton gate (Ani judges) |
| H4 | Sync, 15 min, all four | — |
| H4–H5 | `/uploads` presign and the job record shape | Ani (due H5) |
| H5–H6 | `/rooms` live, RoomPlan producing a real capture end to end | Justin (due H6) |
| H6–H10 | `/objects`, job records, SSE fan-out; object scan flow, measured box under 1s | Demo spine gate at H10 (Paul judges) |
| H10 | Sync, 15 min, all four | — |
| H10–H16 | Expo app shell (room list, object library, version history UI); version write/diff; `/push` | — |
| H16 | Sync — stop starting new work | — |
| H16–H20 | Freeze a candidate path, rehearse once badly, write submission text | — |
| H20 | Track lock sync, all four judge | — |
| H20–H28 | Phone version scrubber, AR bookend, submission material | — |
| H28–H31 | Hardening; H31 feature freeze is your gate to enforce | Everyone (you judge) |
| H31–H33 | Rehearse on venue network, floor full, five full runs | — |
| H33–H34 | Buffer, submit at H34 | — |

## Done when

1. Four fixtures and the `X-Stub: 1` layer are committed and every `/v1` endpoint answers its
   fixture when the request carries the header — landed by H1.5.
2. RoomPlan native module returns a valid `RoomCapture v1` from a real scan (H4 gate).
3. A judge scans a room and an object; both reach B; the measured `Object v1`
   (`state:"measured"`) renders with real `bboxMeters` under one second, before the mesh exists.
4. B rejects any `RoomCapture v1` upload where `worldAlignment` is not the literal
   `"gravityAndHeading"` with HTTP 422.
5. `GET /sync/{roomId}` delivers an `object` SSE event end to end through the per-room
   Durable Object.
6. `docker compose up` gives Justin and Paul a working local solver/scraper environment with
   no manual setup.

## Cut list, in order

1. On-phone three.js object browser — the headset already shows the scene, this is redundant.
2. The Live Activity — an in-app progress bar says the same thing.
3. The RealityKit AR module — fall back to USDZ + QuickLook, about 30 minutes of work.
4. Vectorize — fall back to a brute-force cosine scan over the objects table; fine at a few
   hundred objects, keeps Paul's retrieval alive.
5. The job queue — call Baseten inline with a longer timeout; loses parallelism, not correctness.
6. Auth — a device id header is enough for a weekend; loses per-user isolation.
7. Last resort: drop Expo entirely, ship pure Swift — loses the primary Expo track.

## Traps

- Expo Go cannot load a custom native module. You need `expo-dev-client`, `npx expo prebuild`,
  and a local Xcode build, every time a native module changes.
- Missing config plugin for `NSCameraUsageDescription` crashes the app on first camera use.
- LiDAR is required: iPhone 12 Pro or later, iOS 16 or later. Verify the test device before H0.
- A free Apple developer account gives only a 7-day provisioning profile — plan re-signing.
- Set `ARConfiguration.worldAlignment = .gravityAndHeading` on the capture session from day
  one. Skip it and true north is gone from every downstream schema; the only fix is
  re-scanning every room.
- Serialize `CapturedRoom` as JSON, never as USDZ. The USDZ → GLB conversion chain (coordinate
  conventions, unit scaling, material loss, headless Blender at 3am) is where the weekend dies.
- D1 is SQLite: no `RETURNING` on older bindings, and writes are not free — batch where you can.
- A Durable Object per room does the SSE fan-out. A Worker alone cannot hold the connection
  open for `GET /sync/{roomId}`.

## Who to ask

| Person | They owe you | Due | You owe them | Due |
| --- | --- | --- | --- | --- |
| Justin (D, E) | `FitReport v1` consumed and drawn, so the shape is proven | H12 | Fixtures and the `X-Stub: 1` layer; a real `RoomCapture v1` from a real scan | H1.5; H6 |
| Ani (C) | Embeddings written into `objects-v1`, so `/search` has rows to return | H14 | Fixtures and the `X-Stub: 1` layer; `/uploads` presign and the job record shape | H1.5; H5 |
| Paul (F, P3) | The search query shape he actually needs | H12 | Fixtures and the `X-Stub: 1` layer; `/search` live and answering, ranking stubbed | H1.5; H16 |

Every edge above comes from the dependency table in `.claude/contracts.md`, which is the
authority. If you are going to miss one, say so at the previous sync point, not at the due hour.
