import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RoomPicker, tileRects, pickerNote, type RoomChoice } from './roompicker.ts';

const ROOMS: RoomChoice[] = [
  { id: 'ccff7dec-1fc1-493e-96e3-3ab6f6ddfb2a', label: 'Meeting room' },
  { id: 'b5318133-49d1-4484-88dc-f38cef684175', label: 'Skyline room' },
];
const HERE = ROOMS[0].id;
const THERE = ROOMS[1].id;

function opened(rooms: readonly RoomChoice[] = ROOMS, current = HERE): RoomPicker {
  const picker = new RoomPicker();
  picker.setPresenting(true);
  picker.setRooms(rooms, current);
  picker.show();
  const head = new THREE.PerspectiveCamera();
  head.position.set(0, 1.6, 0);
  head.updateMatrixWorld(true);
  for (let i = 0; i < 40; i++) picker.place(head, 1 / 60); // let the fade finish
  picker.group.position.set(0, 0, 0);
  picker.group.quaternion.identity();
  picker.group.updateMatrixWorld(true);
  return picker;
}

const rayAt = (x: number, y: number) => {
  const r = new THREE.Raycaster();
  r.set(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
  return r;
};
const atTile = (i: number) => {
  const r = tileRects(ROOMS.length)[i];
  return rayAt(0, -(r.y + r.h / 2));
};

test('the room you are in is marked and cannot be picked; the other one can', () => {
  const picker = opened();
  // Switching to where you already are is not a choice, and a tile that looks pressable and
  // does nothing reads as a broken window.
  assert.equal(picker.hitTest(atTile(0)), null, 'the current room is not pressable');
  assert.deepEqual(picker.hitTest(atTile(1)), { kind: 'room', id: THERE });
});

test('nothing is pickable while a switch runs, but it can still be closed', () => {
  const picker = opened();
  // setState rebuilds the hit planes, and three.js will not raycast a child whose world matrix
  // has never been computed. The render loop does that every frame; a test has to do it here.
  const settle = () => picker.group.updateMatrixWorld(true);

  picker.setState('switching');
  settle();
  assert.equal(picker.hitTest(atTile(1)), null, 'the room being left must not take a second choice');
  assert.deepEqual(picker.hitTest(rayAt(-0.46 / 2 + 0.034, -0.034)), { kind: 'close' }, 'the × still works');

  picker.setState('idle');
  settle();
  assert.deepEqual(picker.hitTest(atTile(1)), { kind: 'room', id: THERE }, 'and it comes back');
});

test('the note says the one thing that stops a choice, and nothing when none does', () => {
  assert.equal(pickerNote('idle', ROOMS), null);
  assert.equal(pickerNote('switching', ROOMS), 'Switching room…');
  assert.equal(pickerNote({ error: 'Room b5318133 did not load: 502' }, ROOMS), 'Room b5318133 did not load: 502');
  // The two states nobody looks at until they happen.
  assert.equal(pickerNote('idle', []), 'No rooms configured.');
  assert.equal(pickerNote('idle', [ROOMS[0]]), 'This is the only room configured.');
});

test('with no rooms configured it says so, and offers nothing to press', () => {
  const picker = opened([], HERE);
  assert.equal(picker.hitTest(atTile(0)), null);
  assert.equal(picker.hitTest(atTile(1)), null);
  assert.ok(picker.hitSurface(rayAt(0, -0.05)), 'it is still a window, still opaque to a delete');
});

test('with one room configured there is nothing to switch to and nothing pressable', () => {
  const picker = opened([ROOMS[0]], HERE);
  assert.equal(picker.hitTest(atTile(0)), null, 'the only room is the current one');
});

test('it fades in and out rather than appearing, and is not hittable while gone', () => {
  const picker = new RoomPicker();
  picker.setPresenting(true);
  picker.setRooms(ROOMS, HERE);
  const head = new THREE.PerspectiveCamera();
  head.position.set(0, 1.6, 0);
  head.updateMatrixWorld(true);

  picker.place(head, 1 / 60);
  assert.equal(picker.group.visible, false, 'closed to begin with');
  assert.equal(picker.open, false);

  picker.show();
  assert.equal(picker.open, true, 'open the moment it is asked for, before it is drawn');
  picker.place(head, 1 / 60);
  const firstStep = picker.group.scale.x;
  picker.place(head, 1 / 60);
  assert.ok(picker.group.scale.x > firstStep, 'it grows into place rather than snapping');
  for (let i = 0; i < 40; i++) picker.place(head, 1 / 60);
  assert.equal(picker.group.visible, true);
  assert.ok(Math.abs(picker.group.scale.x - 1) < 1e-6, 'and settles at its real size');

  picker.hide();
  for (let i = 0; i < 40; i++) picker.place(head, 1 / 60);
  assert.equal(picker.group.visible, false, 'gone when the fade finishes');
  picker.group.updateMatrixWorld(true);
  assert.equal(picker.hitTest(atTile(1)), null, 'and nothing on it can be pressed');
  assert.equal(picker.hitSurface(rayAt(0, -0.05)), false);
});

test('a failed switch says why and still lets you try again', () => {
  const picker = opened();
  picker.setState({ error: 'Skyline room did not load: 502' });
  picker.group.updateMatrixWorld(true);
  // An error is not a switch in flight. The room you tried for is still the room you want, so
  // the tiles stay pressable — being told why and then being unable to retry is a dead end.
  assert.deepEqual(picker.hitTest(atTile(1)), { kind: 'room', id: THERE });
  assert.equal(pickerNote({ error: 'Skyline room did not load: 502' }, ROOMS), 'Skyline room did not load: 502');
});

test('an error from a previous attempt is not shown on a fresh open', () => {
  const picker = opened();
  picker.setState({ error: 'Skyline room did not load: 502' });
  picker.hide();
  picker.show();
  // Reopening is a new attempt. A reason from one the person already walked away from reads
  // as a fresh failure, which is worse than saying nothing.
  assert.equal(pickerNote('idle', ROOMS), null);
  assert.deepEqual(picker.hitTest(atTile(1)), null, 'not yet: the fade has to run first');
  const head = new THREE.PerspectiveCamera();
  head.position.set(0, 1.6, 0);
  head.updateMatrixWorld(true);
  for (let i = 0; i < 40; i++) picker.place(head, 1 / 60);
  picker.group.position.set(0, 0, 0);
  picker.group.quaternion.identity();
  picker.group.updateMatrixWorld(true);
  assert.deepEqual(picker.hitTest(atTile(1)), { kind: 'room', id: THERE }, 'and it is usable again');
});

test('it opens in front of you every time, not where it was left', () => {
  const picker = opened();
  picker.group.position.set(9, 9, 9); // dragged away, then closed
  picker.hide();
  const head = new THREE.PerspectiveCamera();
  head.position.set(0, 1.6, 0);
  head.updateMatrixWorld(true);
  for (let i = 0; i < 40; i++) picker.place(head, 1 / 60);
  picker.show();
  picker.place(head, 1 / 60);
  // Unlike the popout, this is a decision to make now, so it comes back to the front.
  assert.ok(picker.group.position.distanceTo(new THREE.Vector3(0, 1.6, 0)) < 2);
});
