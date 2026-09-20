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

test('Rapier: a dragged object follows the pointer directly and stops at the wall', async () => {
  const built = buildRoomFromScan(fixture);
  const physics = await createPhysics(new THREE.Scene());
  physics.setRoom(built);
  const size = new THREE.Vector3(0.4, 0.4, 0.4);
  const node = new THREE.Group();
  physics.addObject('box', node, size, new Float32Array(), { x: 0, z: 1.2 }, 0); // z = 1.2: a clear lane to the east wall
  for (let i = 0; i < 60; i++) physics.step(1 / 60); // land

  physics.drag('box', 0.5, 1.2, 0);
  physics.step(1 / 60);
  near(node.position.x, 0.5, 'reaches the target in one frame, no chase', 1e-3);

  physics.drag('box', 10, 1.2, 0);
  for (let i = 0; i < 60; i++) physics.step(1 / 60);
  // East wall: center x = 2, 0.12 thick, so its inner face is x = 1.94.
  const rightEdge = node.position.x + size.x / 2;
  near(rightEdge, 1.94, 'stops at the inner wall face', 0.015);
  near(node.position.z, 1.2, 'no sideways drift', 1e-3);
  near(node.position.y, 0, 'still on the floor', 0.01);

  physics.release('box');
  const before = node.position.x;
  for (let i = 0; i < 120; i++) physics.step(1 / 60);
  near(node.position.x, before, 'stays put once released', 0.01);
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

// --- the appearance layer: one rectified photo per surface -----------------------------

// three's TextureLoader asks document.createElementNS for an <img>. These tests run in plain
// node, so the photo never arrives; what is asserted is the texture object built around it.
(globalThis as { document?: unknown }).document ??= {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
};

// Judging Room H, the demo room: 2.76 x 4.72 x 2.96 m, six surfaces photographed.
const roomH = JSON.parse(readFileSync(new URL('../../../fixtures/room-h.json', import.meta.url), 'utf-8'));

test('a photographed room is its measured box, with the photo on the face that looks inward', () => {
  const built = buildRoomFromScan(roomH);
  near(built.size.width, 2.76, 'width');
  near(built.size.depth, 4.72, 'depth');

  const walls = roomMeshes(built).filter((m) => m.userData.collider === 'wall');
  assert.equal(walls.length, 4);
  for (const wall of walls) {
    const faces = wall.material as THREE.MeshBasicMaterial[];
    assert.ok(Array.isArray(faces), 'a photographed wall carries one material per face');
    const textured = faces.map((m, i) => (m.map ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(textured.length, 1, 'exactly one face carries the photo');
    // The room is centered on the origin, so the inward normal is the one pointing at it.
    const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(wall.quaternion);
    const inward = textured[0] === 4 ? outward : outward.negate();
    assert.ok(inward.dot(worldPosition(wall).clone().negate()) > 0, 'the photo faces the room, not the corridor');
    assert.equal(faces[textured[0]].map!.colorSpace, THREE.SRGBColorSpace);
  }
});

test('the ceiling is drawn at the wall height, facing down, turned as the capture says', () => {
  const built = buildRoomFromScan(roomH);
  // The turn is baked into the geometry, not the object, so find it by height: the only mesh
  // at the top of the walls. Its normal points down, which the render check in the report shows.
  const ceiling = roomMeshes(built).find((m) => Math.abs(worldPosition(m).y - 2.96) < 1e-6);
  assert.ok(ceiling, 'a ceiling mesh sits at the wall height');
  near(ceiling.geometry.attributes.normal.getY(0), -1, 'it faces the floor');
  const map = (ceiling.material as THREE.MeshBasicMaterial).map!;
  near(map.rotation, Math.PI, 'the ceiling photo is turned 180°, per appearance.rotationDeg');
  assert.equal(map.repeat.x, 1, 'not mirrored');
});

test('an appearance key that names no wall fails loud', () => {
  const broken = { ...roomH, appearance: { surfaces: { 'not-a-wall': { hex: '#ffffff' } } } };
  assert.throws(() => buildRoomFromScan(broken), /not-a-wall/);
});

test('a photographed wall keeps its openings painted rather than cut', () => {
  // The same opening, in a wall with a photo and in the same wall without one. A cut wall is an
  // extrusion; the invisible collider beside it stays a box either way, so count extrusions.
  const withOpening = {
    ...roomH,
    openings: [{
      id: 'f1f5a0aa-0f27-4f4b-96e1-5c1eb2a0f3c1', kind: 'opening', wallId: roomH.walls[1].id,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.38, 1.05, 4.72, 1],
      dimensions: [0.9, 2.1, 0],
    }],
  };
  const extrusions = (scan: unknown) =>
    roomMeshes(buildRoomFromScan(scan as Record<string, unknown>))
      .filter((m) => m.geometry.type === 'ExtrudeGeometry').length;

  assert.equal(extrusions(withOpening), 0, 'a photographed wall is drawn whole');
  assert.equal(extrusions({ ...withOpening, appearance: undefined }), 1, 'an unphotographed wall is still cut');
});
