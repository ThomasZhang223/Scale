# src/voice — Paul's OMNI loop

**This subtree is Paul's, not Thomas's.** Per `CLAUDE.md` "The one real collision: voice":

1. Thomas ships the Swift Speech native module (see `apps/mobile/plugins/with-speech.js` and
   the generated `ios/` project) and its config-plugin entry in `app.json`.
2. Thomas ships the `VoiceScreen` stub below, wired into the router, exporting a plain JS
   surface: `start()`, `stop()`, and a transcript callback.
3. From here on, **Paul writes JavaScript only, under `apps/mobile/src/voice/**`**. Paul never
   edits the Swift side. If he needs a change there, he asks Thomas.
