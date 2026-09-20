import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshUrl } from './thumbUrl.ts';

const ORIGIN = 'https://full-scale-xr.example.workers.dev';
const ok = (raw: string) => meshUrl(raw, ORIGIN);
const why = (raw: string | null) => {
  const r = meshUrl(raw, ORIGIN);
  return 'error' in r ? r.error : `ACCEPTED ${r.url}`;
};

test('a mesh our own API serves is accepted, relative or absolute', () => {
  assert.deepEqual(ok('/v1/assets/objects/abc/mesh.glb'), { url: `${ORIGIN}/v1/assets/objects/abc/mesh.glb` });
  assert.deepEqual(ok(`${ORIGIN}/v1/assets/scans/abc/mesh.glb`), { url: `${ORIGIN}/v1/assets/scans/abc/mesh.glb` });
});

test('another origin is refused, however it is dressed up', () => {
  // The page is public. Each of these would make it fetch and render someone else's URL.
  for (const raw of [
    'https://evil.example.com/x.glb',
    'http://localhost:9999/x.glb',
    '//evil.example.com/v1/assets/x.glb', // protocol-relative: origin is evil, path looks right
    'https://evil.example.com/v1/assets/objects/abc/mesh.glb',
  ]) {
    assert.match(why(raw), /same-origin/, `${raw} must be refused`);
  }
});

test('the right origin but the wrong path is refused, including a way out by traversal', () => {
  for (const raw of ['/', '/index.html', '/local/active-room', '/v1/objects?source=scan', '/v1/assets/../../secret.glb']) {
    assert.match(why(raw), /must be under \/v1\/assets\//, `${raw} must be refused`);
  }
  // Spelled out, because it is the one that looks like it should slip through: the URL parser
  // normalises the traversal away before the prefix is ever compared.
  assert.equal(why('/v1/assets/../../secret.glb'), 'glb must be under /v1/assets/; got /secret.glb');
});

test('a missing or unparseable parameter is a refusal, never a hang', () => {
  assert.equal(why(null), 'no glb parameter');
  assert.equal(why(''), 'no glb parameter');
});
