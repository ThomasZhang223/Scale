import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { objectToItem, boundsMismatch, checkSchema, type ObjectV1 } from './api.ts';

const macbook: ObjectV1 = JSON.parse(
  readFileSync(new URL('../../../fixtures/object-macbook.json', import.meta.url), 'utf-8'),
);

test('a ready Object v1 becomes a load-by-URL item at scale 1, never rescaled', () => {
  const item = objectToItem(macbook);
  assert.equal(item.url, macbook.glbUrl);
  assert.equal(item.name, 'MacBook Pro 14');
  assert.equal(item.scale, 1);
  assert.deepEqual(item.expected, { w: 0.3126, h: 0.0155, d: 0.2212 });
});

test('an object without a mesh yet is refused, naming its state', () => {
  assert.throws(() => objectToItem({ ...macbook, state: 'measured', glbUrl: null }), /is measured; no mesh yet/);
  assert.throws(() => objectToItem({ ...macbook, state: 'generating' }), /is generating/);
});

test('a wrong schemaVersion fails loud, for objects and any other document', () => {
  assert.throws(() => objectToItem({ ...macbook, schemaVersion: 2 }), /Object schemaVersion 2, expected 1 — ask Thomas/);
  assert.throws(() => checkSchema({ schemaVersion: undefined }, 'RoomCapture'), /RoomCapture schemaVersion undefined/);
  assert.doesNotThrow(() => checkSchema({ schemaVersion: 1 }, 'RoomCapture'));
});

test('the normalisation contract is checked to 1 mm', () => {
  const exact = { x: 0.3126, y: 0.0155, z: 0.2212 };
  assert.equal(boundsMismatch(exact, macbook.bboxMeters), null);
  assert.equal(boundsMismatch({ ...exact, x: 0.3134 }, macbook.bboxMeters), null, '0.8 mm is within tolerance');
  const msg = boundsMismatch({ ...exact, z: 0.2262 }, macbook.bboxMeters);
  assert.match(msg ?? '', /0\.226 .* 0\.221/s);
  assert.match(msg ?? '', /ask Ani/);
});
