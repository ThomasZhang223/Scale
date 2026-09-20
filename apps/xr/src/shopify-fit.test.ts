import assert from 'node:assert/strict';
import test from 'node:test';
import { assessShopify, closestSizeMiss, commerceAction, formatPrice, previewUrl } from './shopify-fit.ts';
import { fitsNeed } from './listings.ts';
import type { ShopifyCandidate } from '../../../workers/src/lib/shopify.ts';

const c = { dimensions: { bboxMeters: { w: .88, h: .5, d: .4 } }, price: { amount: 12345, currency: 'CAD' }, available: true, checkoutUrl: 'https://shop.example/cart/456:1', productUrl: 'https://shop.example/products/table' } as ShopifyCandidate;
test('verified failure gives exactly 8 cm too wide from existing fitsNeed', () => {
  assert.equal(fitsNeed(c.dimensions!.bboxMeters, { maxW: .8 }), false);
  assert.deepEqual(assessShopify(c, { maxW: .8 }), { status: 'DOESN’T FIT', reasons: ['8 cm too wide'] });
});
test('verified fit gives true clearance and passes the unchanged fit predicate', () => {
  const need = { maxW: 1.02, maxH: .6, maxD: .5 };
  assert.equal(fitsNeed(c.dimensions!.bboxMeters, need), true);
  assert.deepEqual(assessShopify(c, need), { status: 'FITS', reasons: ['14 cm width clearance', '10 cm height clearance', '10 cm depth clearance'] });
});
test('unknown dimensions, missing space, invalid space and invalid measurements never claim fit', () => {
  assert.equal(assessShopify({ ...c, dimensions: null }, { maxW: 3 }).status, 'SIZE UNVERIFIED');
  for (const need of [{}, { maxW: -1 }, { maxW: NaN }, { maxW: 21 }]) assert.equal(assessShopify(c, need).status, 'SET SPACE');
  assert.equal(assessShopify({ ...c, dimensions: { ...c.dimensions!, bboxMeters: { w: NaN, h: 1, d: 1 } } }, { maxW: 2 }).status, 'SIZE UNVERIFIED');
});
test('all failed limits are reported and exact boundaries fit without rounding tolerances', () => {
  assert.deepEqual(assessShopify(c, { maxW: .8, maxD: .28 }).reasons, ['8 cm too wide', '12 cm too deep']);
  assert.equal(assessShopify(c, { maxW: .88 }).status, 'FITS');
  assert.equal(assessShopify(c, { maxW: .8799 }).status, 'DOESN’T FIT');
});
test('commerce preserves returned URL and falls back to product page', () => {
  assert.deepEqual(commerceAction(c), { label: 'Buy on Shopify', href: c.checkoutUrl });
  for (const row of [{ ...c, checkoutUrl: null }, { ...c, available: false }]) assert.deepEqual(commerceAction(row), { label: 'View on Shopify', href: c.productUrl });
});
test('prices respect currency minor units', () => {
  assert.match(formatPrice(c), /123\.45/);
  assert.match(formatPrice({ ...c, price: { amount: 1000, currency: 'JPY' } }), /1,000/);
  assert.equal(formatPrice({ ...c, price: null }), 'Price unavailable');
});
test('comparison selects the smallest real miss without mutating Shopify order', () => {
  const near = { ...c, dimensions: { ...c.dimensions!, bboxMeters: { w: .81, h: .5, d: .4 } } };
  const rows = [c, near];
  assert.equal(closestSizeMiss(rows, { maxW: .8 }), near);
  assert.deepEqual(rows, [c, near]);
  assert.equal(closestSizeMiss(rows, { maxW: 2 }), undefined);
});
test('preview retains the room and exact object, and never opens a fixture or unverified mesh', () => {
  const ready = { ...c, previewObjectId: 'ready-object-id' };
  const base = 'https://scale.example/?room=actual-room';
  const url = new URL(previewUrl(ready, base, false)!);
  assert.equal(url.searchParams.get('room'), 'actual-room');
  assert.equal(url.searchParams.get('object'), ready.previewObjectId);
  assert.equal(previewUrl(ready, base, true), null);
  assert.equal(previewUrl({ ...ready, dimensions: null }, base, false), null);
  assert.equal(previewUrl({ ...ready, previewObjectId: null }, base, false), null);
});
