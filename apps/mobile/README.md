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

The scaffold boots to a home screen that pings the Worker's stub layer. Prove the loop works
end to end before touching Swift.

1. **Boot the app.** `npm install && npx expo prebuild && npx expo run:ios --device`.
   You should see the home screen with an API row reading `unreachable`.
2. **Start the Worker.** In `workers/`: `npx wrangler dev`. It binds to your laptop.
3. **Point the phone at it.** The phone is not on localhost. Put both devices on the travel
   router, then create `apps/mobile/.env.local`:
   ```
   EXPO_PUBLIC_API_BASE=http://<your-laptop-LAN-ip>:8787/v1
   ```
   Reload. The API row should read `stub layer OK — 4 walls`, served from
   `fixtures/room-demo.json`.
4. **Only now write the native module.** `src/native/` for the Swift wrappers, and the
   time-box is 4 hours. See the H4 gate in `.claude/sprint.md`.

If step 3 fails, it is almost always the LAN address or the router, not the code. That is why
the health row exists.

## Layout

- `app/` — routes. expo-router is file-based, so a file here *is* a screen.
- `src/lib/` — the API client. `src/lib/api.js` is the only place that knows the base URL, and
  it validates `schemaVersion` on every response so a renamed field fails loudly.
- `src/native/` — Swift native module wrappers.
- `src/voice/` — Paul's. Do not edit.
