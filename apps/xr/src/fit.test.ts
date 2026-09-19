import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FitOverlay, geometryPoints, type FitReport } from './fit.ts';
import { buildRoomFromScan } from './roomScan.ts';

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8'));
const fixture = read('../../../fixtures/room-demo.json');
const report: FitReport = read('../../../fixtures/fitreport-doorswing.json');

const near = (actual: number, expected: number, what: string, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${what}: expected ${expected}, got ${actual}`);

test('arc angles are the contract’s: counter-clockwise seen from +Y, the same sense as three.js rotation.y', () => {
  const pts = geometryPoints({ type: 'arc', center: [0, 0], radiusM: 1, startDeg: 0, endDeg: 90 });
  const last = pts[pts.length - 1];
  // Rotating the +X axis by rotation.y = 90° gives (0, 0, -1); the arc must end there too.
  const threeJs = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, Math.PI / 2, 0));
  near(last[0], threeJs.x, 'end x'); near(last[1], threeJs.z, 'end z');
  near(pts[0][0], 1, 'start x'); near(pts[0][1], 0, 'start z');
});

test('the fixture arc, read with that convention, sweeps to -Z off its hinge (outside the z = 0 wall: a fixture bug to report)', () => {
  const pts = geometryPoints(report.violations[0].geometry);
  const last = pts[pts.length - 1];
  near(last[0], 1.2, 'end x'); near(last[1], -0.9, 'end z');
});

test('rect and polyline trace their outlines', () => {
  assert.deepEqual(geometryPoints({ type: 'rect', min: [0, 0], max: [1, 2] }), [[0, 0], [1, 0], [1, 2], [0, 2], [0, 0]]);
  assert.deepEqual(geometryPoints({ type: 'polyline', points: [[0, 0], [1, 1]] }), [[0, 0], [1, 1]]);
});

test('the overlay draws each violation in the recentered scene, just above the floor', () => {
  const built = buildRoomFromScan(fixture); // offset (-2, 0, -1.75)
  const overlay = new FitOverlay();
  overlay.setRoomOffset(built.offset);
  overlay.show(report);
  assert.equal(overlay.group.children.length, 1);
  const mesh = overlay.group.children[0] as THREE.Mesh;
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox!;
  // The arc spans x 1.2..2.1 and z -0.9..0 in the capture frame → x -0.8..0.1, z -2.65..-1.75 here.
  near(box.min.x, -0.8, 'min x', 0.03); near(box.max.x, 0.1, 'max x', 0.03);
  near(box.min.z, -2.65, 'min z', 0.03); near(box.max.z, -1.75, 'max z', 0.03);
  near(box.min.y, 0.015, 'sits just above the floor');
  overlay.clear();
  assert.equal(overlay.group.children.length, 0);
});
