import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Palette, type PaletteItem } from './palette.ts';
import { matchDetected } from './placement.ts';
import { buildRoomFromScan } from './roomScan.ts';

const items: PaletteItem[] = [
  { url: '/objects/chair.glb', name: 'chair' },
  { url: '/objects/sofa.glb', name: 'sofa' },
  { url: '/objects/xander.glb', name: 'xander' },
];

/** A ray straight into the tile through its centre, along the tile's own normal. */
function rayInto(tile: THREE.Object3D) {
  const center = tile.getWorldPosition(new THREE.Vector3());
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(tile.matrixWorld);
  return new THREE.Raycaster(center.clone().addScaledVector(normal, 0.5), normal.clone().negate());
}

test('a ray through a tile returns its item; a miss returns null', () => {
  const palette = new Palette();
  palette.setItems(items);
  const grip = new THREE.Group(); // stands in for the left controller
  grip.position.set(0.3, 1.1, -0.4);
  grip.rotation.set(0.4, 0.2, -0.1);
  palette.attachTo(grip);
  grip.updateMatrixWorld(true);

  const tiles = palette.group.children.filter((c) => c.userData.item);
  assert.equal(tiles.length, 3);
  assert.equal(palette.hitTest(rayInto(tiles[1])), items[1]);
  assert.equal(palette.hitTest(rayInto(tiles[2])), items[2]);
  const miss = new THREE.Raycaster(new THREE.Vector3(5, 5, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(palette.hitTest(miss), null);
});

test('an empty palette is hidden and never hit', () => {
  const palette = new Palette();
  palette.setItems([]);
  assert.equal(palette.group.visible, false);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
  assert.equal(palette.hitTest(ray), null);
});

test('only catalogue items that match a detected piece are auto-placed', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/room-demo.json', import.meta.url), 'utf-8'));
  const { objects: detected } = buildRoomFromScan(fixture); // a table and a chair
  const chairId = '9a1406a5-a5a0-4625-95a9-1dd5765dbab2';

  assert.equal(matchDetected('chair', detected, [])?.identifier, chairId);
  assert.equal(matchDetected('My-Chair-Scan.glb', detected, [])?.identifier, chairId, 'case-insensitive, anywhere in the name');
  assert.equal(matchDetected('sofa', detected, []), null, 'no sofa detected: waits in the palette');
  assert.equal(matchDetected('xander', detected, []), null);
  assert.equal(matchDetected('chair', detected, [chairId]), null, 'the chair spot is already taken');
});

// ---------- pages ----------

const paged: PaletteItem[] = [
  { url: '', name: 'Rearrange', action: 'rearrange', page: 'Designer' },
  { url: '', name: 'Cozy', action: 'style:cozy', page: 'Designer' },
  { url: '/objects/scan-a.glb', name: 'Captured object', page: 'Scans' },
  { url: '/objects/scan-b.glb', name: 'Captured object', page: 'Scans' },
  { url: '', name: 'Clear objects', action: 'clear', page: 'Room' },
];

/** Every tile the window can be hit on, by the name drawn on it. */
function hittableNames(palette: Palette): string[] {
  const grip = new THREE.Group();
  palette.attachTo(grip);
  grip.updateMatrixWorld(true);
  return palette.group.children
    .filter((c) => c.userData.item)
    .map((c) => (c.userData.item as PaletteItem).name);
}

test('one page is on screen at a time, with one tab per page', () => {
  const palette = new Palette();
  palette.setItems(paged);
  assert.equal(palette.activePage, 'Designer', 'the first page is shown when none is remembered');
  // Three tabs, plus the two tiles of the Designer page. Nothing from Scans or Room.
  assert.deepEqual(hittableNames(palette), ['Designer', 'Scans', 'Room', 'Rearrange', 'Cozy']);
});

test('a tab carries a page: action, and showPage swaps which tiles are drawn', () => {
  const palette = new Palette();
  palette.setItems(paged);
  const grip = new THREE.Group();
  palette.attachTo(grip);
  grip.updateMatrixWorld(true);
  const scansTab = palette.group.children.find((c) => (c.userData.item as PaletteItem | undefined)?.name === 'Scans')!;
  assert.equal(palette.hitTest(rayInto(scansTab))?.action, 'page:Scans');

  palette.showPage('Scans');
  assert.equal(palette.activePage, 'Scans');
  assert.deepEqual(hittableNames(palette), ['Designer', 'Scans', 'Room', 'Captured object', 'Captured object']);
});

test('a single page draws no tabs at all', () => {
  const palette = new Palette();
  palette.setItems(paged.filter((it) => it.page === 'Scans'));
  assert.deepEqual(hittableNames(palette), ['Captured object', 'Captured object']);
});

test('a remembered page that no longer exists falls back to the first, never to a guess', () => {
  const palette = new Palette();
  palette.setItems(paged);
  palette.showPage('Room');
  // The scans have gone away and Room went with them: the window must not be left blank.
  palette.setItems(paged.filter((it) => it.page === 'Designer'));
  assert.equal(palette.activePage, 'Designer');
});
