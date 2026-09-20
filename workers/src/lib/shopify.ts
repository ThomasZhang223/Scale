/** Read-only Shopify Global Catalog boundary. No carts, persistence, or inferred dimensions.
 * Wire reference: https://shopify.dev/docs/agents/catalog/global-catalog (2026-08-25).
 */
export const CATALOG_ENDPOINT = 'https://catalog.shopify.com/api/ucp/mcp';
// Shopify explicitly publishes this profile for keyless testing. No account or secret needed.
export const DEMO_PROFILE = 'https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json';
export type Box = { w: number; h: number; d: number };
export interface Evidence {
  productId: string; productUrl: string; title: string; imageUrl: string; bucket: string;
  bboxMeters: Box; measure: { method: string; confidence: number };
  validation: { unverified: boolean; flags: string[] }; via: string; extractedFrom: string;
}
export interface ShopifyCandidate {
  productId: string; variantId: string; title: string; variantTitle: string;
  merchant: string; merchantId: string; productUrl: string; imageUrl: string | null;
  price: { amount: number; currency: string } | null; available: boolean | null;
  checkoutUrl: string | null; options: { name: string; label: string }[];
  discovery: 'global' | 'scale-catalog';
  dimensions: null | { bboxMeters: Box; sourceUrl: string; method: string; variantBasis: string };
  previewObjectId: string | null;
}
type RecordValue = Record<string, any>;
const record = (v: unknown): RecordValue => v && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {};
const string = (v: unknown): string => typeof v === 'string' ? v : '';
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port ? value : null;
  } catch { return null; }
}
export function productIdentity(value: unknown): string | null {
  const safe = httpsUrl(value);
  if (!safe) return null;
  const u = new URL(safe);
  if (!/^\/products\/[a-zA-Z0-9_-]+\/?$/.test(u.pathname)) return null;
  return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`;
}
function sellerHosts(seller: RecordValue): Set<string> {
  const hosts = new Set<string>();
  const url = httpsUrl(seller.url);
  if (url) hosts.add(new URL(url).hostname.replace(/^www\./, ''));
  if (/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(string(seller.domain))) hosts.add(seller.domain.replace(/^www\./, ''));
  return hosts;
}
function sellerUrl(value: unknown, hosts: Set<string>): string | null {
  const url = httpsUrl(value);
  return url && hosts.has(new URL(url).hostname.replace(/^www\./, '')) ? url : null;
}
export function parseCandidates(payload: unknown, discovery: ShopifyCandidate['discovery']): ShopifyCandidate[] {
  const rpc = record(payload), result = record(rpc.result);
  if (rpc.error || result.isError) throw new Error('Shopify unavailable');
  let content = result.structuredContent;
  if (!content && Array.isArray(result.content)) {
    const entry = result.content.find((x: any) => x?.type === 'text' && typeof x.text === 'string');
    if (entry) content = JSON.parse(entry.text);
  }
  const data = record(content);
  if (!Array.isArray(data.products)) throw new Error('Invalid Shopify response');
  const out: ShopifyCandidate[] = [];
  for (const product of data.products.slice(0, 20)) {
    const p = record(product);
    if (!string(p.id).startsWith('gid://shopify/') || !string(p.title) || !Array.isArray(p.variants)) continue;
    for (const raw of p.variants.slice(0, 8)) {
      const v = record(raw), seller = record(v.seller), hosts = sellerHosts(seller);
      const productUrl = sellerUrl(v.url ?? p.url, hosts);
      if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(string(v.id)) || !productUrl || !productIdentity(productUrl) || !string(seller.name) || !string(seller.id)) continue;
      const urlVariant = new URL(productUrl).searchParams.get('variant');
      if (urlVariant && urlVariant !== v.id.split('/').pop()) continue;
      const money = record(v.price), availability = record(v.availability);
      const media = Array.isArray(v.media) ? v.media : Array.isArray(p.media) ? p.media : [];
      out.push({
        productId: p.id, variantId: v.id, title: p.title, variantTitle: string(v.title),
        merchant: seller.name, merchantId: seller.id, productUrl,
        imageUrl: httpsUrl(media.find((m: any) => m?.type === 'image')?.url),
        price: Number.isSafeInteger(money.amount) && money.amount >= 0 && /^[A-Z]{3}$/.test(string(money.currency)) ? { amount: money.amount, currency: money.currency } : null,
        available: typeof availability.available === 'boolean' ? availability.available : null,
        checkoutUrl: availability.available === true ? sellerUrl(v.checkout_url, hosts) : null,
        options: Array.isArray(v.options) ? v.options.filter((o: any) => typeof o?.name === 'string' && typeof o?.label === 'string').map((o: any) => ({ name: o.name, label: o.label })) : [],
        discovery, dimensions: null, previewObjectId: null,
      });
    }
  }
  if (data.products.length && !out.length) throw new Error('Invalid Shopify products');
  return out;
}
export function usableEvidence(e: Evidence): boolean {
  return !!productIdentity(e.productUrl) && e.validation?.unverified === false && e.validation.flags?.length === 0
    && e.measure?.method === 'extracted' && e.measure.confidence >= 0.8
    && ['api', 'page'].includes(e.via) && ['spec_block', 'body_html'].includes(e.extractedFrom)
    && ['w', 'h', 'd'].every(k => Number.isFinite(e.bboxMeters?.[k as keyof Box]) && e.bboxMeters[k as keyof Box] > 0 && e.bboxMeters[k as keyof Box] <= 20);
}
/** The original catalog is product-level. Verify variant membership and cosmetic-only options
 * against the merchant's public product JSON, never Shopify's inferred option metadata. */
export function verifyDimensions(c: ShopifyCandidate, e: Evidence, merchantProduct: unknown): ShopifyCandidate['dimensions'] {
  if (!usableEvidence(e) || productIdentity(c.productUrl) !== productIdentity(e.productUrl)) return null;
  const p = record(merchantProduct);
  if (String(p.id) !== e.productId || !Array.isArray(p.variants) || !p.variants.length || !Array.isArray(p.options)) return null;
  const selected = p.variants.find((v: any) => String(v?.id) === c.variantId.split('/').pop());
  if (!selected) return null;
  // A single variant is unambiguous. Multiple variants may differ ONLY in colour/finish.
  // Named size/configuration options remain unverified even if discovery returned one choice.
  if (p.variants.length > 1) {
    if (!p.options.length || p.options.some((o: any) => !/^(colou?r|finish|colou?r finish|base colou?r|top colou?r)$/i.test(string(o?.name ?? o)))) return null;
    if (p.variants.some((v: any) => /\b(small|medium|large|king|queen|twin|size|\d+(?:\.\d+)?\s*(?:cm|mm|inches|inch|feet))\b|\d\s*["″]/i.test(string(v?.title)))) return null;
  }
  return { bboxMeters: e.bboxMeters, sourceUrl: e.productUrl, method: `${e.via}: ${e.extractedFrom}`, variantBasis: p.variants.length === 1 ? 'Merchant confirms a single variant' : 'Merchant variants differ only by colour/finish' };
}
export interface DiscoveryInput { query?: string; referenceId?: string; referenceUrl?: string; image?: { content_type: string; data: string }; }
export interface DiscoveryResult { status: 'ok' | 'unavailable'; candidates: ShopifyCandidate[]; note: string | null; }
export function validateDiscoveryInput(value: unknown): DiscoveryInput {
  const b = record(value);
  if (b.query != null && (typeof b.query !== 'string' || b.query.length > 300)) throw new Error('Query must be at most 300 characters');
  if (b.referenceId != null && !/^gid:\/\/shopify\/(p|Product|ProductVariant)\/[a-zA-Z0-9]+$/.test(string(b.referenceId))) throw new Error('Invalid reference');
  if (b.referenceUrl != null && !productIdentity(b.referenceUrl)) throw new Error('Invalid reference URL');
  if (b.image != null && (!['image/jpeg', 'image/png', 'image/webp'].includes(b.image.content_type) || typeof b.image.data !== 'string' || b.image.data.length > 700_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.image.data))) throw new Error('Invalid reference image');
  if (!b.query?.trim() && !b.referenceId && !b.image) throw new Error('Enter a query or choose a reference image');
  if (b.referenceId && b.image) throw new Error('Use one reference');
  return { query: b.query?.trim(), referenceId: b.referenceId, referenceUrl: b.referenceUrl, image: b.image };
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Shopify unavailable');
  const reader = response.body.getReader();
  let size = 0, text = ''; const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error('Response too large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const events = text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')).filter(Boolean);
      for (const event of events) { const parsed = JSON.parse(event); if (parsed.id === 1) return parsed; }
      throw new Error('Missing Shopify response');
    }
    return JSON.parse(text);
  } finally { await reader.cancel().catch(() => {}); }
}
export async function discoverShopify(input: DiscoveryInput, evidence: Evidence[], fetcher: typeof fetch = fetch, timeoutMs = 12_000): Promise<DiscoveryResult> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
  const work = async (): Promise<DiscoveryResult> => {
    const call = async (name: 'search_catalog' | 'lookup_catalog', catalog: unknown, source: ShopifyCandidate['discovery']) => {
      const response = await fetcher(CATALOG_ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { meta: { 'ucp-agent': { profile: DEMO_PROFILE } }, catalog } } }) });
      return parseCandidates(await boundedJson(response), source);
    };
    const reference = evidence.find(e => productIdentity(e.productUrl) === productIdentity(input.referenceUrl));
    const words = (input.query ?? reference?.title ?? '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
    const matches = (e: Evidence) => words.filter(w => e.title.toLowerCase().split(/\W+/).includes(w)).length;
    const known = evidence.filter(usableEvidence).filter(e => (!reference || e.bucket === reference.bucket) && (e === reference || matches(e) > 0))
      .sort((a, b) => (b === reference ? 100 : matches(b)) - (a === reference ? 100 : matches(a))).slice(0, 8);
    const results = await Promise.allSettled([
      call('search_catalog', { ...(input.query ? { query: input.query } : {}), ...(input.image ? { like: [{ image: input.image }] } : input.referenceId ? { like: [{ id: input.referenceId }] } : {}), pagination: { limit: 8 } }, 'global'),
      known.length ? call('lookup_catalog', { ids: known.map(e => e.productUrl) }, 'scale-catalog') : Promise.resolve([]),
    ]);
    if (results[0].status === 'rejected' && (!known.length || results[1].status === 'rejected')) return { status: 'unavailable', candidates: [], note: 'Shopify unavailable. Return to Scale to continue.' };
    const seen = new Set<string>();
    const candidates = results.flatMap(r => r.status === 'fulfilled' ? r.value : []).filter(c => { if (seen.has(c.variantId)) return false; seen.add(c.variantId); return true; }).slice(0, 40);
    const products = new Map<string, Promise<unknown>>();
    await Promise.all(candidates.map(async c => {
      const e = evidence.find(row => usableEvidence(row) && productIdentity(row.productUrl) === productIdentity(c.productUrl));
      if (!e) return;
      try {
        // Only a URL from the committed evidence manifest is fetched, never a client URL.
        const url = `${e.productUrl.replace(/\/$/, '')}.js`;
        if (!products.has(url)) products.set(url, fetcher(url, { redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } }).then(boundedJson));
        c.dimensions = verifyDimensions(c, e, await products.get(url));
      } catch { /* Evidence unavailable: SIZE UNVERIFIED, commerce still works. */ }
    }));
    return { status: 'ok', candidates, note: results.some(r => r.status === 'rejected') ? 'Some Shopify discovery is unavailable; showing the responses that succeeded.' : null };
  };
  try {
    return await Promise.race([work(), new Promise<DiscoveryResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'unavailable', candidates: [], note: 'Shopify timed out. Return to Scale to continue.' }); }, timeoutMs); })]);
  } catch { return { status: 'unavailable', candidates: [], note: 'Shopify unavailable. Return to Scale to continue.' }; }
  finally { clearTimeout(timer!); controller.abort(); }
}
