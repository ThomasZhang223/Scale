# apps/xr — WebXR / Quest runtime

**Owner:** Justin (components D and E)

## Scope

The headset runtime. Rebuilds the scanned room from `RoomCapture v1` JSON primitives, loads
GLBs onto placed objects, lets a user grab/move/rotate, scrubs through versions, and draws
`FitReport` violation geometry in red. See `.claude/workstreams/justin.md` for the full scope
and `.claude/contracts.md` for every schema and endpoint this consumes.

## Stack

three.js with `@react-three/fiber` and `@react-three/xr`. Vite for dev/build. Plain React for
the desktop UI chrome (version scrubber, etc).

## Key facts

- **No room mesh, by design.** `RoomCapture v1` is transport as JSON primitives, never USDZ.
  This runtime rebuilds the room itself: walls are boxes, openings are gaps, unscanned
  furniture is a per-category proxy. There is nothing to download for the room — don't go
  looking for one.
- **Buildable with no phone and no server.** All four fixtures in `fixtures/` are committed at
  H0 and every `/v1` endpoint answers them when the request carries `X-Stub: 1`. Develop
  entirely against `fixtures/room-demo.json`, `fixtures/object-macbook.json`,
  `fixtures/mesh-macbook.glb`, and `fixtures/fitreport-doorswing.json` until the real pipeline
  exists.
- **Runs in a desktop browser too.** WebXR renders the same scene without a headset attached —
  that's what the casting monitor uses to mirror the demo to the room.
- **Unity is explicitly rejected.** It costs about five hours in build-and-deploy cycles that
  WebXR does not have. WebXR hot-reloads from the laptop straight to the headset.

## Run

```
cd apps/xr
npm install
npm run dev
```

Open the printed URL in a desktop browser, or on the Quest browser pointed at the laptop over
the travel router.
