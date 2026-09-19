// Execute Thomas's unchanged tracked upload/asset handlers with in-memory R2/KV.
// No Wrangler deployment, X-Stub, remote request or persistent mutation.
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';

const ref = process.argv[2];
const input = JSON.parse(await new Promise(resolve => {
  let s = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => s += c); process.stdin.on('end', () => resolve(s));
}));
const context = vm.createContext({ Request, Response, Headers, URL, crypto,
  TextEncoder, TextDecoder, Uint8Array, atob, btoa, console });
const cache = new Map();
async function load(file) {
  if (cache.has(file)) return cache.get(file);
  const source = execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' });
  const module = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }),
    { context, identifier: file });
  cache.set(file, module);
  return module;
}
const module = await load('workers/src/routes/index.ts');
const agents = new vm.SyntheticModule(['getAgentByName'], function () {
  this.setExport('getAgentByName', () => { throw new Error('SSE is outside this local storage test'); });
}, { context });
await module.link(async (specifier, importer) => {
  if (specifier === 'agents') return agents;
  assert(specifier.startsWith('.'), 'Unexpected external runtime import');
  return load(path.posix.normalize(path.posix.join(path.posix.dirname(importer.identifier), specifier)) + '.ts');
});
await module.evaluate();
const kv = new Map(), bucket = new Map();
const env = {
  CONFIG: { async put(k, v) { kv.set(k, v); }, async get(k) { return kv.get(k); },
            async delete(k) { kv.delete(k); } },
  BUCKET: { async put(k, stream, options) {
    bucket.set(k, { body: new Uint8Array(await new Response(stream).arrayBuffer()),
                    httpMetadata: options.httpMetadata, httpEtag: 'local-test-etag' });
  }, async get(k) { return bucket.get(k); } }
};
const routes = module.namespace;
const origin = 'https://local-worker.invalid';
const grantResponse = await routes.postUpload(new Request(origin + '/v1/uploads', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'objectMesh', ext: 'glb', objectId: input.objectId })
}), env, origin);
assert.equal(grantResponse.status, 200);
const grant = await grantResponse.json();
assert.equal(grant.key, `objects/${input.objectId}/mesh.glb`);
const bytes = Buffer.from(input.glbBase64, 'base64');
const putRequest = () => new Request(grant.putUrl, {
  method: 'PUT', headers: { 'content-type': 'model/gltf-binary' }, body: bytes });
const putPath = new URL(grant.putUrl).pathname;
assert.equal((await routes.putUpload(putRequest(), env, putPath)).status, 200);
await assert.rejects(() => routes.putUpload(putRequest(), env, putPath)); // one-use grant
const asset = await routes.getAsset(env, '/v1/assets/' + grant.key);
assert.equal(asset.headers.get('content-type'), 'model/gltf-binary');
assert.deepEqual(Buffer.from(await asset.arrayBuffer()), bytes);
assert(!asset.headers.has('X-Stub'));
process.stdout.write(JSON.stringify({ actualWorkerHandlers: true, fakeR2AndKV: true,
  bytes: bytes.length, roundTrip: 'PASS',
  workerCommit: execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim() }));
