import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRoomFromScan } from './roomScan.ts';

const sample = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/room-scan.json', import.meta.url)), 'utf-8'),
);

const EPS = 1e-4;
function approx(actual: number, expected: number, msg: string) {
  assert.ok(Math.abs(actual - expected) < EPS, `${msg}: expected ${expected}, got ${actual}`);
}

test('recenters the floor to y = 0', () => {
  const { group } = buildRoomFromScan(sample);
  // The floor mesh is the first child added.
  const floor = group.children[0]!;
  const worldY = floor.position.y + group.position.y;
  approx(worldY, 0, 'floor world y');
});

test('centers the footprint on the origin', () => {
  const { size, group } = buildRoomFromScan(sample);
  approx(size.width, 4.2, 'footprint width');
  approx(size.depth, 3.6, 'footprint depth');
  // Wall A's raw center x/z was (0.8, -0.8); after recentering it should land
  // symmetrically about the origin along with wall B (0.8, 2.8).
  const wallA = group.children[1]!;
  const wallB = group.children[2]!;
  approx(wallA.position.z + group.position.z, -1.8, 'wall A recentered z');
  approx(wallB.position.z + group.position.z, 1.8, 'wall B recentered z');
});

test('object positions and rotations are correct after recentering', () => {
  const { objects } = buildRoomFromScan(sample);
  assert.equal(objects.length, 4);

  const sofa = objects.find((o) => o.category === 'sofa')!;
  assert.ok(sofa, 'sofa present');
  approx(sofa.position[0], -1.5, 'sofa x');
  approx(sofa.position[1], 0, 'sofa y (on the floor)');
  approx(sofa.position[2], -0.4, 'sofa z');
  approx(sofa.rotation, Math.PI / 2, 'sofa yaw');
  assert.deepEqual(sofa.dimensions, [2, 0.8, 0.9]);

  const table = objects.find((o) => o.category === 'table')!;
  approx(table.position[0], 0, 'table x');
  approx(table.position[1], 0, 'table y (on the floor)');
  approx(table.position[2], 0, 'table z');
  approx(table.rotation, 0, 'table yaw');
  assert.deepEqual(table.dimensions, [1.2, 0.45, 0.7]); // trailing w dropped

  const chair = objects.find((o) => o.category === 'chair')!;
  approx(chair.position[0], 0.8, 'chair x');
  approx(chair.position[1], 0, 'chair y (on the floor)');
  approx(chair.position[2], 0.6, 'chair z');
  approx(chair.rotation, -Math.PI / 4, 'chair yaw');

  const shelf = objects.find((o) => o.category === 'shelf')!;
  approx(shelf.position[0], 1.7, 'shelf x');
  approx(shelf.position[1], 0, 'shelf y (on the floor)');
  approx(shelf.position[2], -0.8, 'shelf z');
  approx(shelf.rotation, Math.PI / 2, 'shelf yaw');
});

test('accepts a flat 16-number transform and a plain-string category', () => {
  const minimal = {
    walls: [
      { category: 'wall', dimensions: [2, 2, 0], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1] },
      { category: 'wall', dimensions: [2, 2, 0], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1] },
    ],
    objects: [
      { category: 'box', dimensions: [1, 1, 1], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.5, 0, 1] },
    ],
  };
  const { objects } = buildRoomFromScan(minimal);
  assert.equal(objects[0]!.category, 'box');
  approx(objects[0]!.position[1], 0, 'flat-form object sits on the floor');
});

test('with no walls, falls back to the lowest object as the floor', () => {
  const noWalls = {
    objects: [
      { category: { crate: {} }, dimensions: [1, 1, 1], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2.5, 0, 1] },
    ],
  };
  const { objects } = buildRoomFromScan(noWalls);
  approx(objects[0]!.position[1], 0, 'sole object sits on the fallback floor');
});
