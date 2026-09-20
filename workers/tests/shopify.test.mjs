import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_ENDPOINT, discoverShopify, parseCandidates, productIdentity, usableEvidence, validateDiscoveryInput, verifyDimensions } from '../src/lib/shopify.ts';

// Synthetic transport fixtures only; these never appear in the product UI.
const evidence = {
  productId: '123', productUrl: 'https://shop.example/products/table', title: 'Side Table', bucket: 'surface', imageUrl: 'https://cdn.example/table.jpg',
  bboxMeters: { w: .72, h: .5, d: .4 }, measure: { method: 'extracted', confidence: .9 },
  validation: { unverified: false, flags: [] }, via: 'page', extractedFrom: 'spec_block',
};
const variant = {
  id: 'gid://shopify/ProductVariant/456', title: 'Black', url: `${evidence.productUrl}?variant=456&utm_source=shopify`,
  price: { amount: 12345, currency: 'CAD' }, availability: { available: true },
  checkout_url: 'https://shop.example/cart/456:1?tracking=keep',
  seller: { id: 'gid://shopify/Shop/12', name: 'Fixture merchant', url: 'https://shop.example' },
  options: [{ name: 'Color', label: 'Black' }],
};
const product = { id: 'gid://shopify/p/abc', title: evidence.title, variants: [variant], media: [{ type: 'image', url: evidence.imageUrl }] };
const payload = (products = [product]) => ({ jsonrpc: '2.0', id: 1, result: { structuredContent: { products } } });
const merchant = { id: 123, variants: [{ id: 456, title: 'Black' }, { id: 457, title: 'White' }], options: [{ name: 'Color', values: ['Black', 'White'] }] };
const candidate = () => parseCandidates(payload(), 'global')[0];
const response = data => Response.json(data);

test('success preserves exact commerce data, joins exact dimensions, and only calls read operations', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, init]);
    if (url === CATALOG_ENDPOINT) {
      const rpc = JSON.parse(init.body);
      assert.equal(rpc.method, 'tools/call');
      assert.ok(['search_catalog', 'lookup_catalog'].includes(rpc.params.name));
      assert.ok(rpc.params.arguments.meta['ucp-agent'].profile.startsWith('https://shopify.dev/'));
      return response(payload());
    }
    assert.equal(url, `${evidence.productUrl}.js`);
    assert.equal(init.method, undefined); return response(merchant);
  };
  const r = await discoverShopify({ query: 'table' }, [evidence], fetcher);
  assert.equal(r.status, 'ok'); assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].checkoutUrl, variant.checkout_url);
  assert.deepEqual(r.candidates[0].price, variant.price);
  assert.deepEqual(r.candidates[0].dimensions.bboxMeters, evidence.bboxMeters);
  assert.equal(calls.length, 3); // search + lookup, one deduplicated product GET
  assert.equal(r.candidates[0].previewObjectId, null);
});
test('timeout is bounded even when transport ignores abort', async () => {
  const start = Date.now();
  const result = await discoverShopify({ query: 'table' }, [], () => new Promise(() => {}), 15);
  assert.equal(result.status, 'unavailable'); assert.match(result.note, /timed out/); assert.ok(Date.now() - start < 1000);
});
test('HTTP, network, JSON-RPC and malformed response errors fail softly', async () => {
  for (const fetcher of [async () => new Response('bad', { status: 503 }), async () => { throw new Error('offline'); }, async () => response({ error: { code: -1 } }), async () => response({ result: { structuredContent: { products: {} } } }), async () => new Response('{')]) {
    const r = await discoverShopify({ query: 'table' }, [], fetcher);
    assert.equal(r.status, 'unavailable'); assert.deepEqual(r.candidates, []);
  }
});
test('zero results are a successful empty search, not invented fallback products', async () => {
  const r = await discoverShopify({ query: 'table' }, [], async () => response(payload([])));
  assert.equal(r.status, 'ok'); assert.deepEqual(r.candidates, []);
});
test('unknown dimensions remain null; descriptions and inferred specs are not measurement sources', async () => {
  const p = { ...product, metadata: { tech_specs: '72 cm wide' }, description: { plain: 'W72 H50 D40 cm' } };
  const r = await discoverShopify({ query: 'table' }, [], async () => response(payload([p])));
  assert.equal(r.candidates[0].dimensions, null);
});
test('missing or unsafe checkout and unavailable variant retain the real product page', () => {
  for (const checkout_url of [undefined, 'javascript:alert(1)', 'https://evil.example/cart/456:1', 'https://user:pass@shop.example/cart/456:1']) {
    const c = parseCandidates(payload([{ ...product, variants: [{ ...variant, checkout_url }] }]), 'global')[0];
    assert.equal(c.checkoutUrl, null); assert.equal(c.productUrl, variant.url);
  }
  assert.equal(parseCandidates(payload([{ ...product, variants: [{ ...variant, availability: { available: false } }] }]), 'global')[0].checkoutUrl, null);
});
test('canonical exact product identity ignores tracking, never merchant or product changes', () => {
  assert.equal(productIdentity('https://www.shop.example/products/table?variant=456'), productIdentity(evidence.productUrl));
  for (const bad of ['http://shop.example/products/table', 'https://shop.example/cart/456', 'javascript:alert(1)']) assert.equal(productIdentity(bad), null);
  assert.equal(verifyDimensions({ ...candidate(), productUrl: 'https://another.example/products/table' }, evidence, merchant), null);
  assert.equal(verifyDimensions({ ...candidate(), productUrl: 'https://shop.example/products/another' }, evidence, merchant), null);
});
test('dimensions require safe original extraction, exact product ID and selected variant', () => {
  for (const e of [{ ...evidence, via: 'llm' }, { ...evidence, validation: { unverified: true, flags: [] } }, { ...evidence, extractedFrom: 'title' }, { ...evidence, bboxMeters: { w: 0, h: 1, d: 1 } }]) {
    assert.equal(usableEvidence(e), false); assert.equal(verifyDimensions(candidate(), e, merchant), null);
  }
  assert.equal(verifyDimensions(candidate(), evidence, { ...merchant, id: 124 }), null);
  assert.equal(verifyDimensions(candidate(), evidence, { ...merchant, variants: [{ id: 999 }] }), null);
});
test('size-changing and missing option data fail closed; only single/cosmetic variants join', () => {
  assert.ok(verifyDimensions(candidate(), evidence, merchant));
  assert.ok(verifyDimensions(candidate(), evidence, { ...merchant, variants: [{ id: 456 }], options: ['Title'] }));
  for (const options of [[], [{ name: 'Size' }], [{ name: 'Color' }, { name: 'Configuration' }]]) assert.equal(verifyDimensions(candidate(), evidence, { ...merchant, options }), null);
  assert.equal(verifyDimensions(candidate(), evidence, { ...merchant, variants: [{ id: 456, title: 'White 30 inch' }, { id: 457, title: 'White 40 inch' }] }), null);
});
test('malformed products and wrong variant URL are rejected; unsafe prices stay unknown', () => {
  for (const v of [{ ...variant, id: 'fake' }, { ...variant, url: 'https://shop.example/products/table?variant=999' }, { ...variant, url: 'https://evil.example/products/table' }]) assert.throws(() => parseCandidates(payload([{ ...product, variants: [v] }]), 'global'));
  assert.equal(parseCandidates(payload([{ ...product, variants: [{ ...variant, price: { amount: '12.50', currency: 'USD' } }] }]), 'global')[0].price, null);
});
test('partial Shopify failure preserves independently refreshed catalog products with clear note', async () => {
  const r = await discoverShopify({ query: 'table' }, [evidence], async (url, init) => {
    if (url !== CATALOG_ENDPOINT) throw new Error('merchant down');
    if (JSON.parse(init.body).params.name === 'search_catalog') throw new Error('search down');
    return response(payload());
  });
  assert.equal(r.status, 'ok'); assert.match(r.note, /Some Shopify/); assert.equal(r.candidates[0].discovery, 'scale-catalog'); assert.equal(r.candidates[0].dimensions, null);
});
test('MCP text and event-stream responses are accepted', async () => {
  const content = payload().result.structuredContent;
  assert.equal(parseCandidates({ result: { content: [{ type: 'text', text: JSON.stringify(content) }] } }, 'global').length, 1);
  const r = await discoverShopify({ query: 'table' }, [], async () => new Response(`event: message\ndata: ${JSON.stringify(payload())}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(r.candidates.length, 1);
});
test('image, image+text, and similar-product requests use official like schema', async () => {
  for (const input of [{ image: { content_type: 'image/jpeg', data: 'YWJj' } }, { query: 'table', image: { content_type: 'image/png', data: 'YWJj' } }, { referenceId: product.id }]) {
    await discoverShopify(input, [], async (_url, init) => {
      const catalog = JSON.parse(init.body).params.arguments.catalog;
      assert.deepEqual(catalog.like, input.image ? [{ image: input.image }] : [{ id: product.id }]); return response(payload([]));
    });
  }
});
test('invalid requests and oversized image input are refused', () => {
  for (const b of [{}, { query: 'x'.repeat(301) }, { query: 'table', referenceId: 'https://evil.example' }, { image: { content_type: 'text/html', data: 'YWJj' } }, { image: { content_type: 'image/png', data: 'A'.repeat(700001) } }]) assert.throws(() => validateDiscoveryInput(b));
  assert.deepEqual(validateDiscoveryInput({ query: ' table ' }).query, 'table');
});
