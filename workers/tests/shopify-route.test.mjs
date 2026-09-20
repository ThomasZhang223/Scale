import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    const stubs = {
      'cloudflare:workers': 'export class WorkflowEntrypoint {} export class DurableObject {}',
      'cloudflare:workflows': 'export class NonRetryableError extends Error {}',
      agents: 'export class Agent {} export function getAgentByName() { throw new Error("No agents on this path"); }',
    };
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) specifier += existsSync(new URL(`${specifier}.ts`, context.parentURL)) ? '.ts' : '/index.ts';
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, context);
  },
});
const { default: worker } = await import('../src/index.ts');
const { shopifyRoute } = await import('../src/lib/shopify-route.ts');
const evidence = JSON.parse(readFileSync(new URL('../../services/ingest/prebake/manifest.json', import.meta.url), 'utf8')).products.find(e => e.title === 'Terrazzo Switch Table');
const forbiddenEnv = new Proxy({}, { get() { throw new Error('Existing services must not be accessed'); } });
const ctx = { waitUntil() { throw new Error('No background work'); } };

test('existing non-Shopify stub routes remain usable with every service unavailable', async () => {
  const prior = globalThis.fetch; globalThis.fetch = async () => { throw new Error('Shopify/network offline'); };
  try {
    for (const path of ['search', 'find', 'fit', 'solve']) {
      const r = await worker.fetch(new Request(`https://scale.example/v1/${path}`, { method: 'POST', headers: { 'X-Stub': '1' }, body: '{}' }), forbiddenEnv, ctx);
      assert.equal(r.status, 200, path); const data = await r.json(); assert.ok(data);
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
    }
  } finally { globalThis.fetch = prior; }
});
test('references read only the committed manifest; invalid request does not access any service', async () => {
  const r = await shopifyRoute(new Request('https://scale.example/v1/shopify/references'), forbiddenEnv);
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok((await r.json()).length > 0);
  const bad = await shopifyRoute(new Request('https://scale.example/v1/shopify/search', { method: 'POST', body: '{}' }), forbiddenEnv);
  assert.equal(bad.status, 400);
});
test('Shopify route never fabricates demo data even with X-Stub; failure is local', async () => {
  const prior = globalThis.fetch; globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const r = await worker.fetch(new Request('https://scale.example/v1/shopify/search', { method: 'POST', headers: { 'X-Stub': '1' }, body: JSON.stringify({ query: 'side table' }) }), forbiddenEnv, ctx);
    assert.equal(r.status, 200); assert.equal((await r.json()).status, 'unavailable');
    const old = await worker.fetch(new Request('https://scale.example/v1/search', { method: 'POST', headers: { 'X-Stub': '1' } }), forbiddenEnv, ctx);
    assert.equal(old.status, 200); assert.equal((await old.json())[0].score, .93);
  } finally { globalThis.fetch = prior; }
});
test('preview uses an exact ready catalog match and SELECT only, with no writes', async () => {
  const variantId = '456';
  const prior = globalThis.fetch;
  globalThis.fetch = async url => url.endsWith('.js') ? Response.json({ id: evidence.productId, options: ['Title'], variants: [{ id: variantId }] }) : Response.json({ result: { structuredContent: { products: [{ id: 'gid://shopify/p/a', title: evidence.title, variants: [{ id: `gid://shopify/ProductVariant/${variantId}`, url: `${evidence.productUrl}?variant=${variantId}`, seller: { name: 'Bend Goods', id: 'gid://shopify/Shop/1', url: 'https://bendgoods.com' }, availability: { available: true } }] }] } } });
  const env = { DB: { prepare(sql) {
    assert.match(sql, /^SELECT id FROM objects/); assert.match(sql, /state = 'ready'/); assert.match(sql, /glb_key IS NOT NULL/);
    return { bind(...args) { assert.deepEqual(args, [evidence.productUrl, evidence.bboxMeters.w, evidence.bboxMeters.h, evidence.bboxMeters.d]); return { first: async () => ({ id: 'existing-ready-id' }) }; } };
  } } };
  try {
    const r = await shopifyRoute(new Request('https://scale.example/v1/shopify/search', { method: 'POST', body: JSON.stringify({ query: 'table' }) }), env);
    const data = await r.json(); assert.equal(data.candidates[0].previewObjectId, 'existing-ready-id');
    const withoutDb = await shopifyRoute(new Request('https://scale.example/v1/shopify/search', { method: 'POST', body: JSON.stringify({ query: 'table' }) }), forbiddenEnv);
    assert.equal((await withoutDb.json()).candidates[0].previewObjectId, null);
  } finally { globalThis.fetch = prior; }
});
