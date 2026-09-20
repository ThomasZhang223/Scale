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

// ---------- a page too long to show at once ----------

/** A catalogue the size the built-in library is heading for. */
const many: PaletteItem[] = Array.from({ length: 30 }, (_, i) => ({
  url: `/objects/piece-${i}.glb`,
  name: `Piece ${i}`,
  page: 'Furniture',
}));

test('a long page is sliced, and only one slice is on screen', () => {
  const palette = new Palette();
  palette.setItems(many);
  const shown = hittableNames(palette);
  const steps = shown.filter((n) => n === '‹' || n === '›');
  assert.deepEqual(steps, ['›'], 'the first slice offers forward only: there is no back from the top');
  const pieces = shown.filter((n) => n.startsWith('Piece '));
  assert.ok(pieces.length < 30 && pieces.length >= 4, `one slice holds ${pieces.length} of 30`);
  assert.equal(pieces[0], 'Piece 0');
});

test('stepping forward and back walks the same page without losing a tile', () => {
  const palette = new Palette();
  palette.setItems(many);
  const slice = () => hittableNames(palette).filter((n) => n.startsWith('Piece '));
  const seen: string[] = [...slice()];
  let guard = 0;
  while (hittableNames(palette).includes('›') && guard++ < 10) {
    palette.scrollBy(1);
    seen.push(...slice());
  }
  assert.deepEqual(seen, many.map((it) => it.name), 'every tile appears exactly once, in order');
  assert.deepEqual(hittableNames(palette).filter((n) => n === '‹' || n === '›'), ['‹'], 'the last slice offers back only');
  palette.scrollBy(-1);
  assert.ok(hittableNames(palette).includes('›'), 'and forward comes back');
});

test('a widget row is never cut in half by a slice', () => {
  const palette = new Palette();
  palette.setItems(many);
  // Four cells across, so a slice must hold whole rows: its tile count is a multiple of four.
  // The final slice is exempt, because 30 tiles end in a row of two however they are sliced.
  const counts: number[] = [];
  let guard = 0;
  for (;;) {
    counts.push(hittableNames(palette).filter((n) => n.startsWith('Piece ')).length);
    if (!hittableNames(palette).includes('›') || guard++ > 10) break;
    palette.scrollBy(1);
  }
  assert.ok(counts.length > 1, 'it did slice');
  for (const n of counts.slice(0, -1)) assert.equal(n % 4, 0, `a middle slice holds ${n} tiles`);
  assert.equal(counts.reduce((a, b) => a + b, 0), many.length, 'and nothing is dropped or repeated');
});

test('a short page has no pager at all, and changing tab returns to the top', () => {
  const palette = new Palette();
  palette.setItems(paged);
  assert.deepEqual(hittableNames(palette).filter((n) => n === '‹' || n === '›'), []);

  const mixed = new Palette();
  mixed.setItems([...many, { url: '', name: 'Clear objects', action: 'clear', page: 'Room' }]);
  mixed.scrollBy(1);
  assert.ok(hittableNames(mixed).includes('‹'), 'moved down the catalogue');
  mixed.showPage('Room');
  mixed.showPage('Furniture');
  assert.deepEqual(hittableNames(mixed).filter((n) => n === '‹' || n === '›'), ['›'], 'back at the top');
});
