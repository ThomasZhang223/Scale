// Config plugin placeholder for the Swift Speech framework native module that backs
// src/voice (Paul's OMNI loop). Thomas owns this plugin and the Swift side; Paul never
// edits either — see src/voice/README.md.
// ceiling: identity no-op until the Swift module lands; reserves the app.json slot
// so nobody has to edit app.json again to add it.
module.exports = function withSpeech(config) {
  return config;
};
