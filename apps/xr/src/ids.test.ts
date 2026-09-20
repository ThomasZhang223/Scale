import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instanceObjectId } from './ids.ts';

test('first instance keeps the bare local id', () => {
  assert.equal(instanceObjectId('local:chair', []), 'local:chair');
});

test('a second and third chair get their own ids', () => {
  assert.equal(instanceObjectId('local:chair', ['local:chair']), 'local:chair#2');
  assert.equal(instanceObjectId('local:chair', ['local:chair', 'local:chair#2']), 'local:chair#3');
});

test('a gap left by a removed instance is reused', () => {
  assert.equal(instanceObjectId('local:chair', ['local:chair', 'local:chair#3']), 'local:chair#2');
});

test('server ids are never renamed', () => {
  assert.equal(instanceObjectId('42d37a2f', ['42d37a2f']), '42d37a2f');
});
