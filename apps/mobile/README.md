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

`npm install` then `npx expo prebuild` then open `ios/*.xcworkspace` in Xcode and run on device.

## Layout

See `src/*/README.md` for what goes in each subdirectory.
