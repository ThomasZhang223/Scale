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

test('a surface photo that covers a sub-region repeats, mirrored so the copies meet', () => {
  const built = buildRoomFromScan(roomH);
  const floor = roomMeshes(built).find((m) => Math.abs(worldPosition(m).y) < 1e-6)!;
  const map = (floor.material as THREE.MeshBasicMaterial).map!;
  // fixtures/room-h.json: the floor photo covers 2 x 3 carpet tiles, not the whole floor.
  near(map.repeat.x, 2.2623, 'floor repeat u');
  near(map.repeat.y, 2.5792, 'floor repeat v');
  assert.equal(map.wrapS, THREE.MirroredRepeatWrapping);
  assert.equal(map.wrapT, THREE.MirroredRepeatWrapping);
  // 2.76 m across 2 tiles at that factor is a 0.61 m tile: the size it is bought at.
  near(2.76 / (2 * map.repeat.x), 0.61, 'the rendered tile is its real size', 1e-3);

  // Every other surface is one photo over the whole rectangle, and must not wrap at all.
  const wall = roomMeshes(built).filter((m) => m.userData.collider === 'wall')[0];
  const wallMap = (wall.material as THREE.MeshBasicMaterial[]).find((m) => m.map)!.map!;
  near(wallMap.repeat.x, 1, 'a wall does not repeat');
  assert.equal(wallMap.wrapS, THREE.ClampToEdgeWrapping);
});

test('a repeat that is not two positive numbers, or fights a quarter turn, fails loud', () => {
  const withRepeat = (floor: unknown) => ({
    ...roomH,
    appearance: { surfaces: { ...roomH.appearance.surfaces, floor } },
  });
  assert.throws(() => buildRoomFromScan(withRepeat({ repeat: [0, 2] })), /above zero/);
  assert.throws(() => buildRoomFromScan(withRepeat({ repeat: [2] })), /above zero/);
  assert.throws(() => buildRoomFromScan(withRepeat({ rotationDeg: 90, repeat: [2, 3] })), /square repeat/);
});

// --- stacking: an object resting on another object -------------------------------------

/**
 * A table 0.75 m high and a small lamp, both on the floor to start. In the real demo room,
 * which is empty: the older fixture has furniture of its own that the table lands on top of,
 * which makes "did it land on MY table" impossible to ask.
 */
async function stackScene() {
  const physics = await createPhysics(new THREE.Scene());
  physics.setRoom(buildRoomFromScan(roomH));
  const table = { size: new THREE.Vector3(1.2, 0.75, 0.6), node: new THREE.Group() };
  const lamp = { size: new THREE.Vector3(0.2, 0.4, 0.2), node: new THREE.Group() };
  physics.addObject('table', table.node, table.size, new Float32Array(), { x: 0, z: 0 }, 0);
  physics.addObject('lamp', lamp.node, lamp.size, new Float32Array(), { x: 1.0, z: 1.5 }, 0);
  for (let i = 0; i < 90; i++) physics.step(1 / 60); // both land
  return { physics, table, lamp };
}

test('stacking: a lamp let go over a table comes to rest on the table, not the floor', async () => {
  const { physics, lamp } = await stackScene();
  // Carry it over the table at 1 m and let go.
  for (let i = 0; i < 40; i++) {
    physics.drag('lamp', 0, 0, 0, 1.0);
    physics.step(1 / 60);
  }
  assert.equal(physics.supportUnder('lamp')?.supportId, 'table', 'the table is what it would land on');
  physics.release('lamp');
  for (let i = 0; i < 90; i++) physics.step(1 / 60);
  near(lamp.node.position.y, 0.75, 'resting on the table top, not the floor', 0.03);
});

test('stacking: the support rule refuses a perch', async () => {
  const { physics, lamp } = await stackScene();
  // Hovering over the table's edge: the centre is past it, so nothing holds the lamp up.
  for (let i = 0; i < 40; i++) {
    physics.drag('lamp', 0.68, 0, 0, 1.0);
    physics.step(1 / 60);
  }
  assert.equal(physics.supportUnder('lamp'), null, 'a lamp whose centre is off the table is not supported');
  assert.ok(lamp.node.position.y > 0.5, 'still held in the air');
});

test('stacking: moving the table carries the lamp with it', async () => {
  const { physics, table, lamp } = await stackScene();
  for (let i = 0; i < 40; i++) {
    physics.drag('lamp', 0, 0, 0, 1.0);
    physics.step(1 / 60);
  }
  physics.release('lamp');
  for (let i = 0; i < 90; i++) physics.step(1 / 60);
  assert.deepEqual(physics.ridersOf('table'), ['lamp'], 'the lamp is riding the table');

  const startX = lamp.node.position.x;
  for (let i = 0; i < 30; i++) {
    physics.drag('table', 0.5, 0, 0); // 0.5, not further: the room is 2.76 m wide and the table is 1.2
    physics.step(1 / 60);
  }
  near(table.node.position.x, 0.5, 'the table moved', 0.02);
  near(lamp.node.position.x - startX, table.node.position.x, 'the lamp travelled the same distance', 0.05);
  near(lamp.node.position.y, 0.75, 'and stayed on top', 0.05);
});

test('stacking: removing the support drops its rider to the floor', async () => {
  const { physics, lamp } = await stackScene();
  for (let i = 0; i < 40; i++) {
    physics.drag('lamp', 0, 0, 0, 1.0);
    physics.step(1 / 60);
  }
  physics.release('lamp');
  for (let i = 0; i < 90; i++) physics.step(1 / 60);
  near(lamp.node.position.y, 0.75, 'on the table first', 0.03);

  physics.remove('table');
  for (let i = 0; i < 120; i++) physics.step(1 / 60);
  near(lamp.node.position.y, 0, 'falls to the floor once the table is gone', 0.02);
});

test('stacking: a stored height is restored, even when the support arrives late', async () => {
  // The reload case. moveTo now takes the bottom height a Placement carries, and applyVersion
  // restores lowest first — so the support is already there, collider and all, when its rider
  // lands. Here the rider is restored while its support is still missing, then the support
  // arrives: the rider must not have fallen through in the meantime.
  const physics = await createPhysics(new THREE.Scene());
  physics.setRoom(buildRoomFromScan(roomH));
  const lamp = new THREE.Group();
  physics.addObject('lamp', lamp, new THREE.Vector3(0.2, 0.4, 0.2), new Float32Array(), { x: 0, z: 0 }, 0);
  physics.moveTo('lamp', 0, 0, 0, 0.75); // its stored pose: 0.75 m up, on a table that is not here yet
  assert.equal(physics.supportUnder('lamp'), null, 'nothing under it yet — the caller warns and it falls');
  for (let i = 0; i < 120; i++) physics.step(1 / 60);
  near(lamp.position.y, 0, 'unsupported, so gravity takes it to the floor', 0.02);

  // Now in the right order: support first, then the rider at its stored height. The lamp waits
  // out of the way, or the table would land on IT and the question stops meaning anything.
  physics.moveTo('lamp', 1.0, 1.5, 0);
  const table = new THREE.Group();
  physics.addObject('table', table, new THREE.Vector3(1.2, 0.75, 0.6), new Float32Array(), { x: 0, z: 0 }, 0);
  for (let i = 0; i < 90; i++) physics.step(1 / 60);
  physics.moveTo('lamp', 0, 0, 0, 0.75);
  assert.equal(physics.supportUnder('lamp')?.supportId, 'table', 'the table holds it up');
  for (let i = 0; i < 120; i++) physics.step(1 / 60);
  near(lamp.position.y, 0.75, 'still on the table after a hundred frames of gravity', 0.03);
});
