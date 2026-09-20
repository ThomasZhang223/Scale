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
