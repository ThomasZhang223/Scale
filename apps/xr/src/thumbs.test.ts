import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Thumbnails } from './thumbs.ts';
import type { ObjectLoader } from './objects.ts';

/*
 * The publish side of the thumbnail cache. The rendering itself needs a GPU and a document and
 * is verified by eye in a browser; what is checked here is the part that can go quietly wrong:
 * who gets sent, how often, and whether anything blocks the frame loop.
 */

/** A loader that never resolves, so nothing reaches the render and the queue is observable. */
const stalled = { load: () => new Promise<never>(() => {}) } as unknown as ObjectLoader;

/** What get() queued, read back through the private field the render loop drains. */
function queued(t: Thumbnails): { key: string; publish?: boolean }[] {
  return (t as unknown as { queue: { key: string; publish?: boolean }[] }).queue;
}

test('a scan with no picture is queued to be published; nothing else is', () => {
  const t = new Thumbnails(stalled, () => {}, () => {});
  t.get('scan-1', '/a.glb', 1, true);   // a phone scan: the server has no image of it
  t.get('primitive-1', '/b.glb', 1, false); // built-in furniture: real name, real vector
  t.get('catalog-1', '/c.glb', 1, false);   // a listing: the store's own photo
  assert.deepEqual(queued(t).map((q) => [q.key, q.publish ?? false]), [
    ['scan-1', true],
    ['primitive-1', false],
    ['catalog-1', false],
  ]);
});

test('one object is asked for once, however many tiles and panels want it', () => {
  const t = new Thumbnails(stalled, () => {}, () => {});
  // The tablet tile, then the popout row, then a redraw of both.
  for (let i = 0; i < 4; i++) t.get('scan-1', '/a.glb', 1, true);
  assert.equal(queued(t).length, 1, 'queued once');
});

test('update() starts at most one render and returns immediately', () => {
  const t = new Thumbnails(stalled, () => {}, () => {});
  t.get('scan-1', '/a.glb', 1, true);
  t.get('scan-2', '/b.glb', 1, true);
  const started = Date.now();
  t.update();
  t.update(); // the first is still in flight: this one must do nothing
  assert.ok(Date.now() - started < 50, 'update() never waits for a load');
  assert.equal(queued(t).length, 1, 'only one was taken off the queue');
});

test('a mesh that will not load is given up on, not retried on every frame', async () => {
  const broken = { load: () => Promise.reject(new Error('404')) } as unknown as ObjectLoader;
  const warned: unknown[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => warned.push(a);
  try {
    const t = new Thumbnails(broken, () => {}, () => {});
    t.get('scan-1', '/gone.glb', 1, true);
    t.update();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(warned.length, 1, 'one warning, not a stream of them');
    t.get('scan-1', '/gone.glb', 1, true);
    assert.equal(queued(t).length, 0, 'and it is not queued again');
  } finally {
    console.warn = realWarn;
  }
});

test('with no publisher wired, a scan still renders and simply is not sent', () => {
  const t = new Thumbnails(stalled, () => {});
  t.get('scan-1', '/a.glb', 1, true);
  assert.equal(queued(t).length, 1, 'the tile still gets its picture');
});
