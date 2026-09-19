// Stub shipped by Thomas. Paul builds the OMNI loop on top of this plain JS surface —
// see README.md in this directory. Paul edits this file and everything else here;
// he never touches the Swift Speech module it wraps.
//
// ceiling: no-op start/stop and a transcript callback that is never invoked. Real
// wiring to the native Speech module lands when Paul builds the OMNI loop.

export function start() {
  // TODO(paul): begin listening via the native Speech module.
}

export function stop() {
  // TODO(paul): stop listening.
}

export function onTranscript(callback) {
  // TODO(paul): subscribe `callback` to native transcript events.
}
