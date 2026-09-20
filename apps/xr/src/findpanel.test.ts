import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FindPanel, cardRects } from './findpanel.ts';
import type { Recommendation } from './listings.ts';

const rec = (id: string): Recommendation => ({
  score: 0.8, reasons: ['matches "lamp"'],
  listing: { schemaVersion: 1, objectId: id, source: 'catalog', state: 'measured', name: `Lamp ${id}`, category: 'lighting', glbUrl: null, bboxMeters: { w: 0.3, h: 1.2, d: 0.3 }, merchant: 'Poly & Bark', imageUrl: null },
});

test('cardRects stacks cards downward from the title with a constant pitch', () => {
  const rects = cardRects(3);
  assert.equal(rects.length, 3);
  assert.ok(rects[0].y > 0, 'first card sits below the title');
  assert.ok(rects[1].y > rects[0].y && rects[2].y > rects[1].y);
  assert.ok(rects.every((r) => r.h > 0.08 && r.h < 0.15));
});

test('hitTest finds the card under a ray and null beside the panel', () => {
  const panel = new FindPanel();
  panel.setPresenting(true);
  panel.showResults([rec('a'), rec('b')], null);
  panel.group.position.set(0, 0, 0);
  panel.group.updateMatrixWorld(true);
  const [first, second] = cardRects(2);
  const ray = (y: number) => {
    const r = new THREE.Raycaster();
    r.set(new THREE.Vector3(0, y, 1), new THREE.Vector3(0, 0, -1));
    return r;
  };
  assert.deepEqual(panel.hitTest(ray(-(first.y + first.h / 2))), { kind: 'card', objectId: 'a' });
  assert.deepEqual(panel.hitTest(ray(-(second.y + second.h / 2))), { kind: 'card', objectId: 'b' });
  assert.equal(panel.hitTest(ray(5)), null);
});

test('a searching panel has no card hits, and dismiss hides everything', () => {
  const panel = new FindPanel();
  panel.setPresenting(true);
  panel.showSearching('lamp', ['Poly & Bark']);
  panel.group.updateMatrixWorld(true);
  const r = new THREE.Raycaster();
  r.set(new THREE.Vector3(0, -0.1, 1), new THREE.Vector3(0, 0, -1));
  assert.equal(panel.hitTest(r), null);
  panel.dismiss();
  assert.equal(panel.group.visible, false);
});

// ---------- the two modes ----------

/** A phone scan as the scans branch hands it over: ready, with a mesh, no merchant, no photo. */
const scan = (id: string): Recommendation => ({
  score: 0, reasons: ['scanned on your phone'],
  listing: { schemaVersion: 1, objectId: id, source: 'scan', state: 'ready', name: 'Captured object', category: 'unknown', glbUrl: `/v1/assets/scans/${id}/mesh.glb`, bboxMeters: { w: 0.53, h: 0.85, d: 0.47 }, imageUrl: null },
});

test('a scans row asks for a mesh picture; a listing with a photo does not', () => {
  const panel = new FindPanel();
  const asked: string[] = [];
  panel.thumbFor = (objectId) => {
    asked.push(objectId);
    return null; // still rendering: the card keeps its plain plate
  };
  panel.setPresenting(true);
  panel.showResults([scan('s1'), scan('s2')], null, 'scans', 'my chair');
  assert.deepEqual(asked, ['s1', 's2'], 'every scan row wants its own mesh, since all are named the same');

  // A merchant listing carries a product photo, so the mesh render is not asked for as well.
  asked.length = 0;
  const withPhoto = rec('m1');
  withPhoto.listing.imageUrl = 'https://example.test/lamp.jpg';
  panel.showResults([withPhoto], null, 'shop', 'lamp');
  assert.deepEqual(asked, [], 'a photo is enough; no mesh is rendered for it');
});

test('picking a scans row hits the same card path a listing does', () => {
  const panel = new FindPanel();
  panel.setPresenting(true);
  panel.showResults([scan('s1')], null, 'scans', 'my chair');
  panel.group.position.set(0, 0, 0);
  panel.group.updateMatrixWorld(true);
  const [first] = cardRects(1);
  const r = new THREE.Raycaster();
  r.set(new THREE.Vector3(0, -(first.y + first.h / 2), 1), new THREE.Vector3(0, 0, -1));
  assert.deepEqual(panel.hitTest(r), { kind: 'card', objectId: 's1' });
});

test('the mode does not leak: a shop search after a scans one is a shop search again', () => {
  const panel = new FindPanel();
  panel.setPresenting(true);
  panel.showResults([scan('s1')], null, 'scans', 'my chair');
  panel.showSearching('lamp', ['Poly & Bark']);
  const asked: string[] = [];
  panel.thumbFor = (objectId) => { asked.push(objectId); return null; };
  panel.showResults([rec('m1')], null); // no kind given: shop is the default
  assert.deepEqual(asked, ['m1'], 'a shop row with no photo still falls back to its mesh');
});

// ---------- it stands in the room, and you move it by hand ----------

/**
 * A head looking along -Z. It must be a Camera, not a plain Object3D: Camera.getWorldDirection
 * returns the negative Z axis and Object3D.getWorldDirection the positive one, so a plain
 * object would have the panel spawn behind the viewer and every pose test would read backwards.
 */
function head(x = 0, y = 1.6, z = 0, yaw = 0): THREE.Camera {
  const c = new THREE.PerspectiveCamera();
  c.position.set(x, y, z);
  c.rotation.y = yaw;
  c.updateMatrixWorld(true);
  return c;
}

/** A panel showing results, not yet placed. Its rows and buttons are hittable straight away. */
function showing(): FindPanel {
  const panel = new FindPanel();
  panel.setPresenting(true);
  panel.showResults([rec('a'), rec('b')], null);
  return panel;
}

/**
 * The same, placed once by a search. place() ends with visible = presenting && mesh !== null,
 * and there is no canvas in a test runner, so a placed panel is not hittable here — the pose
 * tests below use this and the hit tests use showing().
 */
function opened(): FindPanel {
  const panel = showing();
  panel.place(head());
  return panel;
}

test('a search places the panel once; moving your head afterwards does not move it', () => {
  const panel = opened();
  const placed = panel.group.position.clone();
  const facing = panel.group.quaternion.clone();
  assert.ok(placed.lengthSq() > 0, 'it was placed somewhere');

  // Look around, walk a step, look again. The panel must not follow any of it.
  panel.place(head(0, 1.6, 0, Math.PI / 5));
  panel.place(head(0.4, 1.7, -0.3, Math.PI / 5));
  panel.place(head(0.4, 1.7, -0.3, -Math.PI / 6));
  assert.deepEqual(panel.group.position.toArray(), placed.toArray(), 'it stayed in the room');
  assert.deepEqual(panel.group.quaternion.toArray(), facing.toArray(), 'and kept facing where it was put');
});

test('a second search changes the rows and leaves the panel where you put it', () => {
  const panel = opened();
  // Moved by hand, as a drag would.
  panel.group.position.set(1.1, 1.4, -0.6);
  const moved = panel.group.position.clone();
  panel.place(head());

  panel.showResults([scan('s1')], null, 'scans', 'my stuff');
  panel.place(head());
  assert.deepEqual(panel.group.position.toArray(), moved.toArray(), 'the other mode reopens where it was left');

  panel.showSearching('lamp', ['Poly & Bark']);
  panel.place(head());
  assert.deepEqual(panel.group.position.toArray(), moved.toArray());
});

test('a panel left behind comes back: too far away, or behind you', () => {
  const far = opened();
  far.group.position.set(0, 1.5, 40); // walked off and left it
  far.showResults([rec('a')], null);
  far.place(head());
  assert.ok(far.group.position.distanceTo(new THREE.Vector3(0, 1.6, 0)) < 3, 'brought back within reach');

  const behind = opened();
  behind.group.position.set(0, 1.5, 1.2); // the head looks down -Z, so +Z is behind it
  behind.showResults([rec('a')], null);
  behind.place(head());
  assert.ok(behind.group.position.z < 0, 'brought round to the front');
});

test('the title band is the drag handle; the × and the cards are not part of it', () => {
  const panel = showing();
  panel.group.position.set(0, 0, 0);
  panel.group.quaternion.identity();
  panel.group.updateMatrixWorld(true);
  const rayAt = (x: number, y: number) => {
    const r = new THREE.Raycaster();
    r.set(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
    return r;
  };
  // Across the title, right of the ×.
  assert.ok(panel.hitGrab(rayAt(0.1, -0.03)), 'the band is grabbable');
  // The × sits at the top left; a grab there would mean the panel could never be closed.
  assert.equal(panel.hitGrab(rayAt(-0.6 / 2 + 0.034, -0.034)), null, 'the close button is not a handle');
  assert.deepEqual(panel.hitTest(rayAt(-0.6 / 2 + 0.034, -0.034)), { kind: 'close' }, 'and still closes');
  // The first card is below the band and stays pickable.
  const [first] = cardRects(2);
  assert.equal(panel.hitGrab(rayAt(0, -(first.y + first.h / 2))), null, 'a row is not a handle');
  assert.deepEqual(panel.hitTest(rayAt(0, -(first.y + first.h / 2))), { kind: 'card', objectId: 'a' });
});

test('a hidden panel offers no handle: a ray through where it was grabs nothing', () => {
  const panel = showing();
  panel.group.position.set(0, 0, 0);
  panel.group.quaternion.identity();
  panel.group.updateMatrixWorld(true);
  const r = new THREE.Raycaster();
  r.set(new THREE.Vector3(0.1, -0.03, 1), new THREE.Vector3(0, 0, -1));
  assert.ok(panel.hitGrab(r));
  panel.dismiss();
  assert.equal(panel.hitGrab(r), null);
});
