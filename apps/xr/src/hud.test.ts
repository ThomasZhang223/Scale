import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrap } from './hud.ts';

// 10 px per character: a 50 px line holds five characters.
const ctx = { measureText: (s: string) => ({ width: s.length * 10 }) };

test('wrap keeps every word: nothing is truncated', () => {
  const text = 'desk is 20 cm too wide for the gap';
  const lines = wrap(ctx, text, 120);
  assert.deepEqual(lines, ['desk is 20', 'cm too wide', 'for the gap']);
  assert.equal(lines.join(' '), text);
});

test('wrap breaks a word longer than the line by characters and honours newlines', () => {
  assert.deepEqual(wrap(ctx, 'abcdefghij', 50), ['abcde', 'fghij']);
  assert.deepEqual(wrap(ctx, 'one\ntwo', 100), ['one', 'two']);
  assert.deepEqual(wrap(ctx, '', 100), ['']);
});
