// The app's entry point into the voice assistant.
//
// Thomas ships the Swift `Speech` native module and its config-plugin entry; this file and
// everything else under src/voice is Paul's. See ../../../CLAUDE.md under File ownership —
// Paul never edits the Swift side, he asks.
//
// The transcript surface below is the right one: Apple's on-device Speech framework does the
// speech-to-text, and agent/runTurn.js takes it from there. (An earlier design needed raw
// audio frames instead, because the Huawei OMNI track required the model itself to do the
// speech understanding. That track was dropped — see TOOLS.md — so a transcript is enough.)
//
// ceiling: not wired to the native module yet, and `complete` has no transport, so nothing
// runs in-app. The loop itself is complete and tested off-device — `node dev/test.mjs`.
// What remains is this file: native subscribe, a room in context, and deciding where the
// agent runs (TOOLS.md, "Where this runs") before an API key ships to a device.

import { runTurn } from './agent/runTurn.js';

export function start() {
  // TODO(paul): subscribe to the native Speech module and call handleTranscript on a result.
}

export function stop() {
  // TODO(paul): stop listening.
}

export function onTranscript(callback) {
  // TODO(paul): subscribe `callback` to native transcript events.
}

/**
 * One utterance in, one spoken answer out.
 * @param {string} transcript from the native Speech module
 * @param {object} ctx        { api, roomId, room, capture, complete, speak } — see runTurn
 */
export async function handleTranscript(transcript, ctx) {
  return runTurn(transcript, ctx);
}
