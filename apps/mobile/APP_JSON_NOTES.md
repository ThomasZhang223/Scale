# Why every permission and plugin is already in app.json

Owner: Thomas. Nobody else edits `app.json` — see `CLAUDE.md` "Shared files nobody may edit
casually".

Every native module and permission this app will ever need is declared here at scaffold time,
including `NSSpeechRecognitionUsageDescription` and the voice plugin, which nothing uses until
Paul's OMNI loop lands. Adding a permission later is an edit to a file three people depend on;
adding it now, once, costs nothing and prevents that merge conflict.

The three `./plugins/with-*` entries are placeholder config plugins (identity no-ops for now).
Each will grow into the prebuild step that injects its Swift native module into the generated
Xcode project: `with-room-capture` (RoomPlan), `with-ar-view` (RealityKit ARView), `with-speech`
(Speech framework, for `src/voice`).
