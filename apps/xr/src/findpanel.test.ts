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
