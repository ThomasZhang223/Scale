import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { fromPlacement, toPlacement, layoutToVersion, contentHash, yawDegToRotationY } from './placements.ts';
import { buildRoomFromScan } from './roomScan.ts';
import type { PlacementV1 } from './api.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/room-demo.json', import.meta.url), 'utf-8'));
const { offset } = buildRoomFromScan(fixture); // (-2, 0, -1.75)

const near = (actual: number, expected: number, what: string, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${what}: expected ${expected}, got ${actual}`);

const placement: PlacementV1 = {
  placementId: 'p1', objectId: 'o1', p: [1.5, 0, 2.0], yawDeg: 45, scale: 1, lockedToWallId: null, flags: [],
};

test('a placement lands in the recentered scene and round-trips back to the capture frame', () => {
  const layout = fromPlacement(placement, offset);
  near(layout.position[0], -0.5, 'scene x');
  near(layout.position[1], 0, 'scene y');
  near(layout.position[2], 0.25, 'scene z');
  near(layout.rotationY, Math.PI / 4, 'rotation.y');
  const back = toPlacement(layout, offset);
  assert.deepEqual(back.p, [1.5, 0, 2]);
  assert.equal(back.yawDeg, 45);
  assert.equal(back.scale, 1);
});

test('yawDeg is three.js rotation.y in degrees: 90° turns +X to -Z', () => {
  const v = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, yawDegToRotationY(90), 0));
  near(v.x, 0, 'x'); near(v.z, -1, 'z');
});

test('a version body carries every placement and a key-order-independent content hash', async () => {
  const layout = [fromPlacement(placement, offset)];
  const version = await layoutToVersion('room-1', layout, offset, null, 'first');
  assert.equal(version.schemaVersion, 1);
  assert.equal(version.roomId, 'room-1');
  assert.equal(version.placements.length, 1);
  assert.deepEqual(version.placements[0].p, [1.5, 0, 2]);
  assert.match(version.contentHash, /^[0-9a-f]{64}$/);

  const shuffled = { ...placement };
  const reordered = Object.fromEntries(Object.entries(shuffled).reverse()) as unknown as PlacementV1;
  assert.equal(await contentHash([reordered], version.materials), version.contentHash, 'same layout, same hash');
  assert.notEqual(await contentHash([{ ...placement, yawDeg: 46 }], version.materials), version.contentHash);
});
