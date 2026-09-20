import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectButtonsActive, stickUse } from './controls.ts';

// The thumbstick has three jobs and they must never overlap. This is the whole rule; the
// update loop branches on it rather than repeating it, so these cases are the real behaviour.

const hand = (over: Partial<Parameters<typeof stickUse>[0]> = {}) =>
  stickUse({ draggingWindow: false, handedness: 'right', holding: false, pointingAt: null, ...over });

test('a hand dragging a window pushes and pulls it, whatever else is true', () => {
  assert.equal(hand({ draggingWindow: true }), 'window');
  assert.equal(hand({ draggingWindow: true, holding: true }), 'window', 'even while holding an object');
  assert.equal(hand({ draggingWindow: true, pointingAt: 'lamp' }), 'window', 'even while pointing at one');
  assert.equal(hand({ draggingWindow: true, handedness: 'left' }), 'window', 'either hand');
});

test('the right stick turns the object held or pointed at', () => {
  assert.equal(hand({ holding: true }), 'object');
  assert.equal(hand({ pointingAt: 'lamp' }), 'object');
});

test('the left stick always glides: it never turns an object', () => {
  assert.equal(hand({ handedness: 'left', holding: true }), 'locomotion');
  assert.equal(hand({ handedness: 'left', pointingAt: 'lamp' }), 'locomotion');
});

test('pointing at nothing gives the stick back to the view', () => {
  assert.equal(hand(), 'locomotion');
  assert.equal(hand({ handedness: 'left' }), 'locomotion');
  assert.equal(hand({ handedness: undefined }), 'locomotion', 'a controller with no handedness walks');
});

// A is destructive and B changes what you are holding, so both need to be sure of their aim.

test('A and B do nothing while that hand is dragging a window', () => {
  // The ray points at the window, but it reaches straight through to whatever is behind it:
  // pressing A there would delete an object the person cannot see.
  assert.equal(objectButtonsActive({ draggingWindow: true, handedness: 'right' }), false);
  assert.equal(objectButtonsActive({ draggingWindow: false, handedness: 'right' }), true);
});

test('A and B are the right controller only', () => {
  assert.equal(objectButtonsActive({ draggingWindow: false, handedness: 'left' }), false);
  assert.equal(objectButtonsActive({ draggingWindow: false, handedness: undefined }), false);
});
