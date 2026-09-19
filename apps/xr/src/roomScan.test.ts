import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRoomFromScan } from './roomScan.ts';
import { createPhysics } from './physics.ts';

// The committed RoomCapture v1 fixture: a 4 × 3.5 m room whose floor polygon runs from
// (0, 0) to (4, 3.5) in the capture frame, with one door, one window, a table and a chair.
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/room-demo.json', import.meta.url), 'utf-8'));

const near = (actual: number, expected: number, what: string, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${what}: expected ${expected}, got ${actual}`);

const worldPosition = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

function roomMeshes(built: ReturnType<typeof buildRoomFromScan>) {
  built.group.updateMatrixWorld(true);
  const out: THREE.Mesh[] = [];
  built.group.children[0].traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

test('the fixture room is recentered: floor at y = 0, footprint centered on the origin', () => {
  const built = buildRoomFromScan(fixture);
  near(built.size.width, 4, 'width');
  near(built.size.depth, 3.5, 'depth');
  const floor = worldPosition(roomMeshes(built)[0]);
  near(floor.x, 0, 'floor x');
  near(floor.y, 0, 'floor y');
  near(floor.z, 0, 'floor z');
});

test('column-major, no transpose: a wall lands where the floor polygon says', () => {
  // The third wall is 3.5 m long, turned 90°, on the polygon's x = 0 edge. Recentered,
  // that edge is x = -2 and the wall runs z = -1.75..1.75. A transposed matrix would put
  // it somewhere else entirely, while still looking like a wall.
  const built = buildRoomFromScan(fixture);
  const walls = roomMeshes(built).filter((m) => m.userData.collider === 'wall');
  assert.equal(walls.length, 4);
  const wall = walls[2];
  const ends = [1.75, -1.75].map((x) => wall.localToWorld(new THREE.Vector3(x, 0, 0)));
  for (const e of ends) near(e.x, -2, 'wall end x');
  assert.deepEqual(ends.map((e) => Math.round(e.z * 1000) / 1000).sort((a, b) => a - b), [-1.75, 1.75]);
  near((wall.geometry as THREE.BoxGeometry).parameters.depth, 0.12, 'thickness comes from the capture');
});

test('openings are routed by kind: a solid door and a translucent window', () => {
  const built = buildRoomFromScan(fixture);
  const all = roomMeshes(built);
  const at = (x: number, y: number, z: number) =>
    all.find((m) => worldPosition(m).distanceTo(new THREE.Vector3(x, y, z)) < 1e-6);
  const door = at(-0.8, 1.015, -1.75); // fixture door at (1.2, 1.015, 0), recentered
  const window = at(0.8, 1.4, 1.75); // fixture window at (2.8, 1.4, 3.5), recentered
  assert.ok(door, 'door mesh present');
  assert.ok(window, 'window mesh present');
  assert.equal((door.material as THREE.Material).transparent, false, 'doors are solid');
  assert.equal((window.material as THREE.Material).transparent, true, 'windows are translucent');
});

test('objects keep their contract ids, sit on the floor, and carry the right yaw', () => {
  const { objects } = buildRoomFromScan(fixture);
  assert.equal(objects.length, 2);
  const table = objects.find((o) => o.category === 'table')!;
  const chair = objects.find((o) => o.category === 'chair')!;
  assert.equal(table.identifier, 'd5fac74e-d837-4457-82b6-e55b44b04144');
  assert.equal(chair.identifier, '9a1406a5-a5a0-4625-95a9-1dd5765dbab2');
  near(table.position[0], 0, 'table x');
  near(table.position[1], 0, 'table y (on the floor)');
  near(table.position[2], -0.75, 'table z');
  near(table.rotationY, 0, 'table yaw');
  near(chair.position[0], -0.5, 'chair x');
  near(chair.position[1], 0, 'chair y (on the floor)');
  near(chair.position[2], 0.25, 'chair z');
  near(chair.rotationY, Math.PI / 4, 'chair yaw (+45°; -45° would mean a transposed matrix)');
});

test('a RoomCapture with another schemaVersion fails loud', () => {
  assert.throws(() => buildRoomFromScan({ ...fixture, schemaVersion: 2 }), /schemaVersion 2, expected 1 — ask Thomas/);
});

test('the raw RoomPlan sample still builds', () => {
  const sample = JSON.parse(readFileSync(new URL('../public/room-scan.json', import.meta.url), 'utf-8'));
  const built = buildRoomFromScan(sample);
  assert.equal(built.objects.length, 4);
  near(built.size.width, 4.2, 'width');
  near(built.size.depth, 3.6, 'depth');
});

test('Rapier: the detected chair is solid until a scanned object replaces it', async () => {
  const built = buildRoomFromScan(fixture);
  const physics = await createPhysics(new THREE.Scene());
  physics.setRoom(built);
  const chair = built.objects.find((o) => o.category === 'chair')!;
  const size = new THREE.Vector3(...chair.dimensions);
  const spot = { x: chair.position[0], z: chair.position[2] };
  const before = physics.findFreeSpot(size, chair.rotationY, spot);
  assert.ok(Math.hypot(before.x - spot.x, before.z - spot.z) > 0.01, 'nudged away while the detected chair is solid');
  physics.removeDetected(chair.identifier);
  const after = physics.findFreeSpot(size, chair.rotationY, spot);
  near(after.x, spot.x, 'x after the chair is freed');
  near(after.z, spot.z, 'z after the chair is freed');
});
