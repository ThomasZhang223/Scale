# Why every permission and plugin is already in app.json

Owner: Thomas. Nobody else edits `app.json` — see `CLAUDE.md` "Shared files nobody may edit
casually".

Every native module and permission this app will ever need is declared here at scaffold time,
including `NSSpeechRecognitionUsageDescription` and the voice plugin, which nothing uses until
Paul's OMNI loop lands. Adding a permission later is an edit to a file three people depend on;
adding it now, once, costs nothing and prevents that merge conflict.

`NSLocationWhenInUseUsageDescription` was added for the SDK 57 rebuild. The room-capture module
sets `ARSession.worldAlignment = .gravityAndHeading`, and without Location Services true north
never converges — `northBearingDeg` in `RoomCapture v1` would be fiction.

`expo-build-properties` sets `ios.deploymentTarget` to `16.4`, the plan's pinned minimum.

The three `./plugins/with-*` entries are placeholder config plugins (identity no-ops for now).
`with-room-capture` (RoomPlan) and `with-speech` (Speech framework, for `src/voice`) still expect
Swift modules under `modules/`. `with-ar-view` is now vestigial — the plan replaces the planned
RealityKit `ARView` module with `@magrinj/expo-quick-look`, a third-party QuickLook wrapper that
ships no config plugin of its own — but it is left in place per the SDK 57 migration instructions
("restore the three config-plugin entries"). Flag to Thomas whether to remove it.
