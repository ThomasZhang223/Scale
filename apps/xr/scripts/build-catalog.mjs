// Turns Paul's pre-baked Shopify scrape (services/ingest/prebake/manifest.json) into the
// bundled listings the page falls back to when POST /v1/search answers nothing. Rows are
// Object v1 plus the merchant facts the UI shows (image, product page). Metres throughout.
//
//   node scripts/build-catalog.mjs        # writes public/catalog.json
//
// ceiling: images point at the merchant's CDN because the catalog/… R2 keys are not uploaded
// yet; once they are, the Worker's /v1/assets/<r2Key> URL replaces imageUrl here.
import { readFileSync, writeFileSync } from 'node:fs';

const src = new URL('../../../services/ingest/prebake/manifest.json', import.meta.url);
const out = new URL('../public/catalog.json', import.meta.url);
const manifest = JSON.parse(readFileSync(src, 'utf-8'));

const rows = manifest.products.map((p) => {
  const { w, h, d } = p.bboxMeters;
  if (!(w > 0 && h > 0 && d > 0)) throw new Error(`${p.merchant}/${p.productId}: bboxMeters must be positive metres`);
  return {
    schemaVersion: 1,
    objectId: `catalog:${p.merchant}/${p.productId}`,
    source: 'catalog',
    state: 'measured',
    name: p.title,
    category: p.category ?? 'furniture',
    bucket: p.bucket ?? null,
    glbUrl: null,
    bboxMeters: { w, h, d },
    measure: p.measure,
    price: null, // the scrape kept dimensions, not prices
    productUrl: p.productUrl,
    merchant: p.merchant.replace(/_+/g, ' ').trim(),
    imageUrl: p.imageUrl,
    r2Key: p.r2Key,
  };
});

writeFileSync(out, JSON.stringify(rows, null, 1) + '\n');
console.log(`${rows.length} listings → public/catalog.json`);
