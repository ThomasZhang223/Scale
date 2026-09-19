# modules/room-capture

RoomPlan capture, emitting `RoomCapture v1` (`.claude/contracts.md`). See the plan
(`~/.claude/plans/you-are-the-planning-stateful-badger.md`, section 2) for the full reasoning;
this file is the short version for whoever opens this directory next.

## Why RoomCaptureSession, never RoomCaptureView

On iOS 26, in a build made with Xcode 26, `RoomCaptureView` fails to start: a RealityKit
`tonemapLUT` texture-binding assertion inside Apple's own renderer. No workaround, no Apple
response. `RoomCaptureNativeView.swift` draws its own camera feed (RealityKit `ARView`, sharing
the session, not owning one) and its own instruction overlay instead.

## Why we inject our own `ARSession`

`RoomCaptureController` runs an `ARWorldTrackingConfiguration` with
`worldAlignment = .gravityAndHeading` on its own `ARSession` *before* handing that session to
`RoomCaptureSession(arSession:)`. Without Location Services and this alignment, true north never
converges, and `northBearingDeg` — and every wall transform downstream — is fiction.

We do not try to also keep `sceneDepth` alive through this session: `RoomCaptureSession.run()`
re-runs the ARSession with its own configuration, and recovering a frame semantic through that is
an undocumented dance. The room scan and the object scan (`modules/object-measure`) are
deliberately separate `ARSession`s — one wants frames and poses, the other wants depth.

## Known gaps, on purpose

- `hingeSide` is always `"unknown"`. RoomPlan gives no hinge or swing detection —
  `Surface.Category.door(isOpen:)` is the only door-specific signal, and it is dropped
  deliberately (see `RoomCaptureSerializer.openingKind`). `swingDeg` is 90 for every door: the
  standard interior swing, not a measurement.
- `beautifyObjects` is off. It unifies per-object attributes across a group (Apple's own
  description), which would corrupt a future per-object attribute read. Diff a rebuild with and
  without it before turning it on — see plan section 12.
- The floor polygon falls back to a convex hull of wall base points when `CapturedRoom.floors`
  is empty. That is a real derivation from the same scan, not a guess.
- The frame ring buffer (pose, intrinsics, a downscaled image) is collected during every sweep.
  `RoomAppearanceSampler` is its first real consumer — see below — and it is also what the
  per-wall texture rectification step (plan section 4b, step 3) needs later.

## Appearance (step 1 only)

`RoomAppearanceSampler` samples one dominant colour per wall, per floor, and — only when a
buffered frame actually pitched up far enough to see it — per ceiling, into the optional
`appearance.surfaces` field now documented in `.claude/contracts.md`. `textureUrl` is always
`null`; per-wall rectified photos are step 3, out of scope here.

This is the least-verified piece in the module, more so than the RoomPlan calls themselves: it
projects a world point back into a buffered frame using a hand-derived inverse of
`modules/object-measure`'s `DepthUnprojector` math, and the "did a frame look at the ceiling"
pitch threshold (0.35) is an untuned guess. If a demo room's appearance colours look wrong, check
this file before the RoomPlan mapping.
