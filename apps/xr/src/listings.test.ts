import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needFromText, needFromDetected, rank, findListings, isShoppingRequest, parseLengthMetres, type Listing } from './listings.ts';

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
