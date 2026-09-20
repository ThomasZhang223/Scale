import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELETE_ARM_MS, armDelete, objectButtonsActive, stickUse } from './controls.ts';
import { RoomSwitch, parseRooms, seatIn } from './rooms.ts';

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

test('A and B do nothing while the ray is on the interface', () => {
  // Same reason one step earlier: a panel button, a window handle or a palette tile stands in
  // front of the room, and the ray carries on through it to the object behind.
  assert.equal(objectButtonsActive({ draggingWindow: false, handedness: 'right', rayOnUi: true }), false);
  assert.equal(objectButtonsActive({ draggingWindow: false, handedness: 'right', rayOnUi: false }), true);
  assert.equal(objectButtonsActive({ draggingWindow: true, handedness: 'right', rayOnUi: true }), false);
});

test('A and B are the right controller only', () => {
  assert.equal(objectButtonsActive({ draggingWindow: false, handedness: 'left' }), false);
  assert.equal(objectButtonsActive({ draggingWindow: false, handedness: undefined }), false);
});

// Delete takes two presses on the same object. Four invisible-delete bugs in one night all had
// the same shape; guarding each hole is a list, marking the object first is the rule.

const press = (armed: Parameters<typeof armDelete>[0], id: string | null, now = 1000) =>
  armDelete(armed, { id, now });

test('two presses on the same object delete it', () => {
  const first = press(null, 'lamp', 1000);
  assert.equal(first.deleteId, null, 'the first press only arms');
  assert.equal(first.armed?.id, 'lamp');
  const second = press(first.armed, 'lamp', 1500);
  assert.equal(second.deleteId, 'lamp');
  assert.equal(second.armed, null, 'and it is not left armed afterwards');
});

test('a second press on a DIFFERENT object arms that one and deletes nothing', () => {
  const first = press(null, 'lamp', 1000);
  const second = press(first.armed, 'table', 1200);
  assert.equal(second.deleteId, null, 'nothing is deleted');
  assert.equal(second.armed?.id, 'table', 'the new object is armed, it does not inherit');
  // And the lamp is no longer one press from gone.
  assert.equal(press(second.armed, 'lamp', 1300).deleteId, null);
});

test('arming lapses, and the press after it arms again rather than deleting', () => {
  const first = press(null, 'lamp', 1000);
  const late = press(first.armed, 'lamp', 1000 + DELETE_ARM_MS + 1);
  assert.equal(late.deleteId, null, 'too late to be a confirmation');
  assert.equal(late.armed?.id, 'lamp', 'it is a fresh first press');
  assert.equal(press(late.armed, 'lamp', 1000 + DELETE_ARM_MS + 2).deleteId, 'lamp');
});

test('a press on the interface, or on nothing, disarms and deletes nothing', () => {
  const first = press(null, 'lamp', 1000);
  const onUi = press(first.armed, null, 1100);
  assert.equal(onUi.deleteId, null);
  assert.equal(onUi.armed, null, 'and the lamp is disarmed, not left waiting');
  assert.equal(press(null, null, 1200).deleteId, null, 'a press on nothing from cold does nothing');
});

test('the edge of the window counts as in time', () => {
  const first = press(null, 'lamp', 1000);
  assert.equal(press(first.armed, 'lamp', 1000 + DELETE_ARM_MS).deleteId, 'lamp');
});

// --- switching rooms without leaving VR ------------------------------------------------

test('a room list comes from config, and a bad one is empty rather than guessed', () => {
  assert.deepEqual(parseRooms('[{"id":"a","label":"Meeting room"}]'), [{ id: 'a', label: 'Meeting room' }]);
  assert.deepEqual(parseRooms(undefined), [], 'unset');
  assert.deepEqual(parseRooms('   '), [], 'blank');
  assert.deepEqual(parseRooms('not json'), [], 'unparseable');
  assert.deepEqual(parseRooms('{"id":"a"}'), [], 'not a list');
  assert.deepEqual(parseRooms('[{"label":"No id"}]'), [], 'an entry with no id');
  assert.deepEqual(parseRooms('[{"id":"a"}]'), [], 'an entry with no label');
});

test('a switch runs fade out -> load -> fade in, and covers the view in between', () => {
  const s = new RoomSwitch();
  assert.equal(s.covered, false);
  assert.equal(s.begin(), true);
  assert.equal(s.covered, true, 'covered as soon as the fade starts');
  s.covering();
  assert.equal(s.covered, true, 'still covered while the new room loads');
  s.uncovering();
  assert.equal(s.covered, false, 'uncovered once the fade back in begins');
  s.finish();
  assert.equal(s.busy, false);
});

test('a second switch while one is running is dropped, not queued', () => {
  const s = new RoomSwitch();
  assert.equal(s.begin(), true);
  assert.equal(s.begin(), false, 'while fading out');
  s.covering();
  assert.equal(s.begin(), false, 'while loading');
  s.uncovering();
  assert.equal(s.begin(), false, 'while fading back in');
  s.finish();
  assert.equal(s.begin(), true, 'and allowed again once it has finished');
});

test('a failed load uncovers the view and carries the reason', () => {
  const s = new RoomSwitch();
  s.begin();
  s.covering();
  s.fail('404 from GET /v1/rooms/nope');
  assert.equal(s.covered, false, 'the fade back in starts: never leave someone in the dark');
  assert.match(s.error ?? '', /404/);
  s.finish();
  assert.equal(s.busy, false);
  assert.equal(s.begin(), true, 'and they can try another room');
});

test('a seat is inside the room whatever shape it is', () => {
  for (const size of [{ width: 2.76, depth: 4.72 }, { width: 3.48, depth: 3.48 }]) {
    const { position, lookAt } = seatIn(size);
    assert.ok(Math.abs(position.z) < size.depth / 2, `inside the walls of ${size.width}x${size.depth}`);
    assert.ok(Math.abs(position.x) < size.width / 2, 'and not through a side wall');
    assert.ok(lookAt.z < position.z, 'facing the far wall, not the one behind you');
  }
});
