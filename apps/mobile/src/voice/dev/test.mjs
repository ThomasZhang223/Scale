#!/usr/bin/env node
// Regression tests for the voice loop. No key, no server, no phone: node dev/test.mjs

import assert from 'node:assert/strict';
import { runTurn } from '../agent/runTurn.js';
import { findAnchors } from '../agent/anchors.js';
import { createFakeApi, createFakeCapture } from './fakeApi.js';
import { createFakeTransport, createLyingTransport } from './fakeTransport.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`\x1b[32mPASS\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`\x1b[31mFAIL\x1b[0m ${name}\n      ${e.message}`); fail++; }
}

const turn = (text, complete, extra = {}) => {
  const api = createFakeApi();
  return runTurn(text, {
    api, roomId: api.roomId, room: api.room,
    capture: createFakeCapture(), complete, strictGrounding: true, ...extra,
  });
};

const fake = createFakeTransport();

await t('measure_and_fit measures before it answers', async () => {
  const seen = [];
  const api = createFakeApi({ log: (n) => seen.push(n) });
  await runTurn('what is this', {
    api, roomId: api.roomId, room: api.room, capture: createFakeCapture(),
    complete: fake, strictGrounding: true,
  });
  assert.equal(seen[0], 'createObject', 'the depth measurement must happen first');
});

await t('a blocking fit report prevents the placement', async () => {
  const seen = [];
  const api = createFakeApi({ log: (n) => seen.push(n) });
  const out = await runTurn('put it by the door', {
    api, roomId: api.roomId, room: api.room, capture: createFakeCapture(),
    complete: fake, strictGrounding: true,
  });
  assert.ok(out.results.blocked?.length, 'should report a blocking violation');
  assert.equal(out.results.placed, false);
  assert.ok(!seen.includes('push'), 'must not push a blocked placement to the headset');
});

await t('a hallucinated number is caught', async () => {
  // Must be an utterance that actually reaches pass 2 — a clarifying question short-circuits
  // before the model ever speaks, so it cannot exercise the grounding check.
  await assert.rejects(
    () => turn('put it by the door', createLyingTransport(fake)),
    /ungrounded numbers/,
  );
});

await t('an ambiguous place asks instead of guessing', async () => {
  const out = await turn('will it fit beside my desk', fake);
  assert.equal(out.awaitingAnswer, true);
  assert.match(out.spoken, /did you mean/);
  assert.doesNotMatch(out.spoken, /\d/, 'a clarifying question must carry no numbers');
});

await t('out of scope stops after the ack', async () => {
  const out = await turn("what's the weather", fake);
  assert.equal(out.results, null);
  assert.equal(out.spoken, out.intent.ack);
});

await t('"by the door" resolves in front of it, not along the wall', async () => {
  const api = createFakeApi();
  const [best] = findAnchors(api.room, { description: 'by the door' });
  assert.equal(best.direction, 'front');
  assert.ok(best.p[2] > 0 && best.p[2] < 1.0, `expected a spot in front of the door, got z=${best.p[2]}`);
});

await t('a free span is bounded by the furniture in the way', async () => {
  const api = createFakeApi();
  const [best] = findAnchors(api.room, { description: 'by the door' });
  // Door at z=0, table front face at z=0.7 -> the usable gap is under 0.7 m.
  assert.ok(best.freeSpanMeters < 0.7, `span ${best.freeSpanMeters} should stop at the table`);
});

await t('every anchor is a real span, never a guess', async () => {
  const api = createFakeApi();
  for (const a of findAnchors(api.room, { description: 'beside my desk' })) {
    assert.ok(Number.isFinite(a.freeSpanMeters) && a.freeSpanMeters >= 0.2, 'span must be real');
    assert.equal(a.p.length, 3);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
