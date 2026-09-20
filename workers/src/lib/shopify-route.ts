import manifest from '../../../services/ingest/prebake/manifest.json';
import { discoverShopify, usableEvidence, validateDiscoveryInput, type Evidence } from './shopify';

const evidence = manifest.products as Evidence[];
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Optional routes only. Reads the existing catalogue; cannot write or start generation. */
export async function shopifyRoute(req: Request, env: Env): Promise<Response> {
  if (req.method === 'GET' && new URL(req.url).pathname === '/v1/shopify/references') {
    return json(evidence.filter(usableEvidence).map(e => ({ title: e.title, productUrl: e.productUrl, imageUrl: e.imageUrl, bboxMeters: e.bboxMeters, bucket: e.bucket })));
  }
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/v1/shopify/search') return json({ error: 'Not found' }, 404);
  let input;
  try {
    // A bounded stream prevents oversized bodies even without Content-Length.
    const reader = req.body?.getReader(); if (!reader) throw new Error('Request body required');
    let text = '', bytes = 0; const decoder = new TextDecoder();
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 750_000) throw new Error('Request too large'); text += decoder.decode(value, { stream: true }); } }
    finally { await reader.cancel().catch(() => {}); }
    input = validateDiscoveryInput(JSON.parse(text + decoder.decode()));
  } catch { return json({ error: 'Provide a query (up to 300 characters) or a supported reference image.' }, 400); }
  const result = await discoverShopify(input, evidence);
  // Preview is optional and cannot delay discovery if D1 is unavailable. Exact URL AND dimensions.
  await Promise.race([
    Promise.all(result.candidates.map(async c => {
      if (!c.dimensions) return;
      try {
        const b = c.dimensions.bboxMeters;
        const row = await env.DB.prepare("SELECT id FROM objects WHERE source = 'catalog' AND state = 'ready' AND glb_key IS NOT NULL AND product_url = ? AND bbox_w = ? AND bbox_h = ? AND bbox_d = ? LIMIT 1")
          .bind(c.dimensions.sourceUrl, b.w, b.h, b.d).first<{ id: string }>();
        c.previewObjectId = row?.id ?? null;
      } catch { /* Existing catalogue stays independent of Shopify. */ }
    })),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
  return json(result);
}
