# apps/mobile — Expo app

Owner: **Thomas**. Exception: `src/voice/**` is Paul's — see `src/voice/README.md`.

## Scope

The iPhone client. Two Swift native modules wrapped for Expo:

- `RoomCaptureView` (RoomPlan) — scans the room, emits `RoomCapture v1` (see
  `.claude/contracts.md`).
- RealityKit `ARView`, with a USDZ + QuickLook fallback — places objects at true scale in AR.

Device requirement: **iPhone 12 Pro or later, iOS 16+, LiDAR**. RoomPlan and the AR placement
path both need the LiDAR sensor; there is no simulator or non-Pro fallback.

## Build path

Expo Go cannot load a custom native module. The build path is:

1. `expo-dev-client` is a dependency from the start.
2. `npx expo prebuild` generates `ios/` (gitignored — regenerate, never commit).
3. Open the generated Xcode project and build to a real device.

```bash
npm install
npx expo prebuild --clean       # regenerates ios/, which is gitignored
npx expo run:ios --device       # pick the LiDAR phone; first build takes ~5 min
```

A free Apple developer account works. The provisioning profile expires after 7 days, so
re-sign on Saturday rather than discovering it at judging.

## First session — get to a running app before writing any feature

The scaffold boots to four Liquid Glass tabs. The Headset tab (Panel B's screen) pings the
Worker's stub layer. Prove that loop works end to end before touching Swift.

1. **Boot the app.** `npm install && npx expo prebuild && npx expo run:ios --device`.
   Needs Xcode 26.4 and a LiDAR iPhone attached — see `CLAUDE.local.md`.
2. **Point the phone at the deployed Worker.** The backend is a Cloudflare Worker, not
   `wrangler dev` on your laptop — the phone needs no LAN address or travel router. Create
   `apps/mobile/.env.local`:
   ```
   EXPO_PUBLIC_API_BASE=https://full-scale-workers.thomaszhangdev.workers.dev/v1
   ```
   The Scanned and Furniture tabs read the live catalog by default. Add `EXPO_PUBLIC_STUB=1`
   to that file to point them at the Worker's stub layer (committed fixtures) instead.
   This is deliberately a **second** Worker — the `htn-2026` Worker already in Thomas's
   dashboard auto-deploys from GitHub and would fight a manual `wrangler deploy` of this one.
   Seeing two Workers and assuming one is stale is how this gets broken; both are live. Reload. The Headset tab's health row should read `stub layer OK — 4 walls`, served
   from `fixtures/room-demo.json`. Without `.env.local`, `src/lib/api.ts` throws a named error —
   "EXPO_PUBLIC_API_BASE is not set" — rather than guessing an endpoint; it has never had a
   fallback default, LAN or otherwise, precisely so a missing config can't read as a flaky
   network for twenty minutes.
3. **Only now write the native module.** `modules/room-capture` and `modules/object-measure`
   for the Swift, and the room-capture time-box is 4 hours. See the H4 gate in
   `.claude/sprint.md`.

If step 2 fails, it is almost always the base URL, not the code. That is why the health row
exists. Never point `EXPO_PUBLIC_API_BASE` at a `*.trycloudflare.com` quick-tunnel URL for
anything that uses `GET /sync/{roomId}` — quick tunnels drop Server-Sent Events with no error;
the stream just never delivers.

## Layout

- `app/` — routes. expo-router is file-based, so a file here *is* a screen. `(tabs)/` is the
  four-tab shell; `capture/` and `ar/` are the native-scan and AR-placement screens.
- `src/lib/api.ts` — the API client. The only place that knows the base URL, and it validates
  `schemaVersion` on every response so a renamed field fails loudly instead of arriving as
  `undefined`.
- `src/theme/` — design tokens and the `Glass` wrapper, which falls back to a plain surface
  when `isLiquidGlassAvailable()` is false.
- `modules/` — local Expo Modules, Swift. Autolinks with no registration step.
- `src/voice/` — Paul's. Do not edit.
