import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needFromText, needFromDetected, rank, findListings, isShoppingRequest, parseLengthMetres, productQuery, findLive, STOREFRONTS, type Listing } from './listings.ts';

const catalog: Listing[] = JSON.parse(readFileSync(new URL('../public/catalog.json', import.meta.url), 'utf-8'));

test('the bundled catalogue is Object v1 rows in metres with merchant facts', () => {
  assert.ok(catalog.length >= 50);
  for (const l of catalog) {
    assert.equal(l.schemaVersion, 1);
    assert.equal(l.source, 'catalog');
    assert.ok(l.bboxMeters.w > 0 && l.bboxMeters.w < 5, `${l.name}: width ${l.bboxMeters.w} is not metres`);
    assert.ok(l.imageUrl && l.productUrl && l.merchant);
  }
});

test('lengths convert to metres at the edge', () => {
  assert.equal(parseLengthMetres(80, 'cm'), 0.8);
  assert.equal(parseLengthMetres(1.5, 'm'), 1.5);
  assert.ok(Math.abs(parseLengthMetres(24, 'inches') - 0.6096) < 1e-9);
});

test('a sentence becomes a need: kind plus bounds, width by default', () => {
  const n = needFromText('find a lamp under 1.5 m tall for the 80 cm gap beside my desk');
  assert.equal(n.bucket, 'lighting');
  assert.ok(n.categoryWords!.includes('lamp'));
  assert.equal(n.maxH, 1.5);
  assert.equal(n.maxW, 0.8);
  assert.equal(needFromText('a sofa no deeper than 90 cm').maxD, 0.9);
  assert.equal(needFromText('a sofa no deeper than 90 cm').maxW, undefined);
});

test('a scanned chair asks for seating no more than 15% wider or deeper', () => {
  const n = needFromDetected({ identifier: 'c1', category: 'chair', dimensions: [0.6, 0.9, 0.6] });
  assert.equal(n.bucket, 'seating');
  assert.ok(Math.abs(n.maxW! - 0.69) < 1e-9);
  assert.ok(Math.abs(n.maxD! - 0.69) < 1e-9);
  assert.equal(n.replaces?.identifier, 'c1');
});

test('ranking: the right kind that fills the gap wins; the wrong kind and the too-big are out', () => {
  const mk = (name: string, category: string, bucket: string, w: number, d: number): Listing => ({
    schemaVersion: 1, objectId: name, source: 'catalog', state: 'measured', name, category, bucket,
    glbUrl: null, bboxMeters: { w, h: 0.8, d }, measure: { method: 'extracted', confidence: 0.9 },
  });
  const rows = [
    mk('wide sofa', 'sofas', 'seating', 2.2, 0.9),
    mk('small stool', 'stool', 'seating', 0.4, 0.4),
    mk('snug chair', 'lounge chair', 'seating', 0.78, 0.7),
    mk('side table', 'side tables', 'surface', 0.5, 0.5),
    mk('Chair-side lamp', 'table lamp', 'lighting', 0.3, 0.3), // "chair" in the title is not a chair
  ];
  const recs = rank(rows, needFromText('a chair for the 80 cm gap'));
  assert.deepEqual(recs.map((r) => r.listing.name), ['snug chair', 'small stool']);
  assert.match(recs[0].reasons.join(' '), /78 cm wide, 2 cm to spare/);
  assert.ok(recs.every((r) => r.score > 0 && r.score <= 1));
});

test('the bundled scrape yields real recommendations for a scanned sofa', () => {
  const recs = rank(catalog, needFromDetected({ identifier: 's', category: 'sofa', dimensions: [2.4, 0.9, 1.0] }));
  assert.ok(recs.length > 0);
  assert.ok(recs.every((r) => r.listing.bboxMeters.w <= 2.4 * 1.15));
  assert.ok(recs.every((r) => /sofa|sectional|seating/.test(`${r.listing.category} ${r.listing.bucket}`)));
});

test('findListings prefers live rows and says when it fell back to the bundle', async () => {
  const need = needFromText('a lamp');
  const live = catalog.filter((l) => l.bucket === 'lighting').slice(0, 3);
  const a = await findListings(need, 8, { live: async () => live, bundled: async () => catalog });
  assert.equal(a.source, 'live');
  assert.equal(a.note, null);
  const b = await findListings(need, 8, { live: async () => [], bundled: async () => catalog });
  assert.equal(b.source, 'bundled');
  assert.match(b.note!, /nothing indexed/);
  const c = await findListings(need, 8, { live: async () => { throw new Error('503'); }, bundled: async () => catalog });
  assert.equal(c.source, 'bundled');
  assert.match(c.note!, /failed \(503\)/);
  assert.ok(c.recommendations.length > 0);
});

test('shopping sentences route to listings; rearranging ones do not', () => {
  assert.ok(isShoppingRequest('find something that fits beside my desk'));
  assert.ok(isShoppingRequest('recommend a lamp'));
  assert.ok(!isShoppingRequest('make it cozy'));
  assert.ok(!isShoppingRequest('move the sofa to the window'));
});

test('productQuery strips the imperative and the length phrases, keeping the product words', () => {
  assert.equal(productQuery('find me a lamp under 1.5 m tall'), 'lamp');
  assert.equal(productQuery('Find a red chair for the 80 cm gap beside my desk'), 'red chair beside my desk');
  assert.equal(productQuery('recommend some floor lamps'), 'floor lamps');
  assert.equal(productQuery('lamp'), 'lamp');
  assert.equal(productQuery('show me something 1 m wide'), 'something');
  assert.equal(productQuery('find another lamp'), 'another lamp');
});

test('findLive posts one /find per storefront in parallel, reports stages, and merges listings', async () => {
  const bodies: Record<string, unknown>[] = [];
  const stages: string[] = [];
  const row = (merchant: string, i: number) => ({
    schemaVersion: 1, objectId: `${merchant}-${i}`, source: 'catalog', state: 'measured', name: `Lamp ${i}`, category: 'lighting',
    glbUrl: null, bboxMeters: { w: 0.3, h: 1.2, d: 0.3 }, merchant, productUrl: null, price: null,
    measure: { method: 'extracted', confidence: 0.9 }, extraction: { imageUrl: `https://cdn/${i}.jpg`, fits: true, via: 'api', productId: String(i) },
  });
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    if (body.merchant === 'Sabai Design') return new Response(JSON.stringify({ error: 'upstream_error', message: 'ingest answered 502' }), { status: 502 });
    return new Response(JSON.stringify({ merchant: body.merchant, storefront: body.storefront, searchUrl: 'u', searchedFor: 'lamp', handles: 2, products: 2, measured: 2, fitting: 2, fallbackSuspected: false, warning: null, listings: [row(body.merchant, 1), row(body.merchant, 2)] }));
  }) as unknown as typeof fetch;

  const rows = await findLive({ text: 'find me a lamp under 1.5 m', bucket: 'lighting', categoryWords: ['lamp'], maxH: 1.5 }, 8, (s) => stages.push(`${s.merchant}:${s.stage}`), fetchFn);
  assert.equal(bodies.length, STOREFRONTS.length);
  assert.equal(bodies[0].query, 'lamp');
  assert.deepEqual(bodies[0].fit, { maxH: 1.5 });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.imageUrl?.startsWith('https://cdn/')));
  for (const { merchant } of STOREFRONTS) assert.ok(stages.includes(`${merchant}:searching`), `${merchant} never started`);
  assert.ok(stages.includes('Poly & Bark:done'));
  assert.ok(stages.includes('Sabai Design:failed'));
});

test('findLive throws when every store failed, so findListings can fall back and say so', async () => {
  const fetchFn = (async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as unknown as typeof fetch;
  await assert.rejects(findLive({ text: 'lamp' }, 8, undefined, fetchFn), /every store failed/);
});
