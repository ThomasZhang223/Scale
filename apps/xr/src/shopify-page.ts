import { API_BASE, STUB } from './api.ts';
import { assessShopify, closestSizeMiss, commerceAction, formatPrice, previewUrl } from './shopify-fit.ts';
import type { Need } from './listings.ts';
import type { Box, DiscoveryResult, ShopifyCandidate } from '../../../workers/src/lib/shopify.ts';

type Reference = { title: string; productUrl: string; imageUrl: string; bucket: string; bboxMeters: Box };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reference = el<HTMLSelectElement>('reference'), query = el<HTMLInputElement>('query');
const mode = el<HTMLSelectElement>('mode'), status = el('status'), results = el('results');
const search = el<HTMLButtonElement>('search'), comparison = el('comparison');
const params = new URLSearchParams(location.search);
const room = params.get('room') || import.meta.env.VITE_ROOM_ID || '';
const back = new URL('/', location.origin); if (room) back.searchParams.set('room', room);
el<HTMLAnchorElement>('back').href = back.href;
query.value = (params.get('query') ?? '').slice(0, 300);
let references: Reference[] = [], candidates: ShopifyCandidate[] = [];
let busy = false;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = '') {
  const n = document.createElement(tag); n.textContent = text; n.className = className; return n;
}
function link(text: string, href: string, className = '') {
  const a = node('a', text, className); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
function need(): Need {
  const out: Need = {};
  for (const [id, key] of [['width', 'maxW'], ['height', 'maxH'], ['depth', 'maxD']] as const) {
    const raw = el<HTMLInputElement>(id).value;
    if (raw !== '') out[key] = Number(raw) / 100;
  }
  return out;
}
function render() {
  results.replaceChildren(); comparison.replaceChildren(); comparison.hidden = true;
  const space = need(), assessments = candidates.map(c => ({ c, fit: assessShopify(c, space) }));
  const pass = assessments.find(a => a.fit.status === 'FITS' && a.c.available === true);
  const miss = closestSizeMiss(candidates, space);
  const fail = assessments.find(a => a.c === miss);
  if (pass) {
    comparison.hidden = false;
    comparison.append(node('strong', fail ? `${fail.c.title}: ${fail.fit.reasons.join(', ')}.` : 'A verified option fits your space.'));
    comparison.append(node('p', `${pass.c.title} fits the entered limits. ${pass.fit.reasons.join(' · ')}.`));
    const action = commerceAction(pass.c);
    comparison.append(link(`${action.label} · ${formatPrice(pass.c)}`, action.href, 'action'));
    comparison.append(node('small', 'Shopify relevance order is preserved within each group. Scale catalog alternatives are identified separately.'));
  }
  for (const source of ['scale-catalog', 'global'] as const) {
    const rows = assessments.filter(a => a.c.discovery === source);
    if (!rows.length) continue;
    results.append(node('h2', source === 'global' ? 'Shopify similarity matches' : 'More options from Scale’s measured catalog', 'group-title'));
    results.append(node('p', source === 'global' ? 'Live Global Catalog discovery. A visual match does not imply a size match.' : 'Related Scale catalog products, refreshed through Shopify lookup with live merchant variants and prices.', 'group-note'));
    for (const { c, fit } of rows) {
      const card = node('article', '', 'product');
      if (c.imageUrl) { const img = new Image(); img.src = c.imageUrl; img.alt = c.title; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; card.append(img); }
      const body = node('div', '', 'body');
      body.append(node('span', fit.status, `badge ${fit.status === 'DOESN’T FIT' ? 'fail' : fit.status === 'FITS' ? '' : 'unknown'}`), node('h2', c.title));
      body.append(node('p', `${c.merchant} · ${c.variantTitle}`), node('p', fit.reasons.join(' · '), 'reasons'));
      body.append(node('p', formatPrice(c), 'price'), node('p', c.available === true ? 'Available' : c.available === false ? 'Currently unavailable' : 'Availability unconfirmed'));
      const details = node('details', '', 'provenance'); details.append(node('summary', 'Identity & dimension evidence'));
      details.append(node('p', `Product: ${c.productId}`), node('p', `Variant: ${c.variantId}`), node('p', `Seller: ${c.merchantId}`));
      if (c.options.length) details.append(node('p', c.options.map(o => `${o.name}: ${o.label}`).join(' · ')));
      if (c.dimensions) {
        const d = c.dimensions, b = d.bboxMeters;
        details.append(node('p', `${[b.w, b.h, b.d].map(n => Number((n * 100).toFixed(1))).join(' × ')} cm (width × height × depth)`), node('p', `Scale extraction: ${d.method}. ${d.variantBasis}.`), link('Exact dimension source', d.sourceUrl));
      } else details.append(node('p', 'No dimensions are inferred from photos, product names, or Shopify metadata.'));
      body.append(details);
      const actions = node('div', '', 'actions'), action = commerceAction(c);
      actions.append(link(action.label, action.href, 'action'));
      const preview = previewUrl(c, back.href, STUB);
      if (preview) {
        actions.append(link('Preview Scale catalog mesh in XR', preview));
        body.append(node('small', 'Preview reuses Scale’s existing model of this product; finish may differ. Placement is a separate check.'));
      }
      const similar = node('button', 'Find similar'); similar.type = 'button';
      similar.addEventListener('click', () => { void discover(c.productId); });
      actions.append(similar); body.append(actions); card.append(body); results.append(card);
    }
  }
}
async function referenceImage(): Promise<{ content_type: string; data: string }> {
  const selected = references.find(r => r.productUrl === reference.value);
  if (!selected) throw new Error('Choose a reference object for image search.');
  const response = await fetch(selected.imageUrl, { signal: AbortSignal.timeout(5000), referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('Reference image unavailable. Text search remains available.');
  const blob = await response.blob();
  if (blob.size > 8_000_000 || !blob.type.startsWith('image/')) throw new Error('Reference image is too large or unsupported. Use text search.');
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas'), ratio = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Image search unavailable');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { content_type: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] };
  } finally { bitmap.close(); }
}
async function discover(referenceId?: string) {
  if (busy || !el<HTMLFormElement>('discovery').reportValidity()) return;
  busy = true; search.disabled = true; candidates = []; render(); status.textContent = 'Finding real Shopify products and checking dimension evidence…';
  try {
    const image = !referenceId && mode.value !== 'text' ? await referenceImage() : undefined;
    const response = await fetch(`${API_BASE}/shopify/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(16_000),
      body: JSON.stringify({ query: !referenceId && mode.value === 'image' ? undefined : query.value.trim(), referenceId, referenceUrl: reference.value || undefined, image }) });
    if (!response.ok) throw new Error(response.status === 400 ? 'Enter a query or choose a reference image.' : 'Shopify unavailable. Your Scale tab is ready to use.');
    const data = await response.json() as DiscoveryResult;
    if (!Array.isArray(data.candidates)) throw new Error('Shopify response unavailable.');
    candidates = data.candidates;
    status.textContent = data.note ?? (candidates.length ? `${candidates.length} real Shopify variants. Fit is evaluated only where exact dimensions are verified.` : 'No Shopify matches. Try another query or reference.');
    render();
  } catch (err) {
    candidates = []; render();
    status.textContent = err instanceof Error && err.name === 'TimeoutError' ? 'Shopify timed out. Your Scale tab is ready to use.' : (err as Error).message;
  }
  finally { busy = false; search.disabled = false; }
}
reference.addEventListener('change', () => {
  const r = references.find(r => r.productUrl === reference.value), image = el<HTMLImageElement>('reference-image');
  image.hidden = !r;
  if (r) { image.src = r.imageUrl; image.alt = r.title; query.value = r.title; el('reference-note').textContent = `${r.title} · Scale catalog reference. Enter the actual available gap below.`; }
});
el('discovery').addEventListener('submit', e => { e.preventDefault(); void discover(); });
for (const id of ['width', 'height', 'depth']) el(id).addEventListener('input', render);
void (async () => {
  try {
    const res = await fetch(`${API_BASE}/shopify/references`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!res.ok) throw new Error();
    const rows = await res.json(); if (!Array.isArray(rows)) throw new Error(); references = rows;
    for (const r of references) { const option = node('option', r.title); option.value = r.productUrl; reference.append(option); }
    if (params.get('reference')) { reference.value = params.get('reference')!; if (reference.value) reference.dispatchEvent(new Event('change')); }
  } catch { el('reference-note').textContent = 'Reference catalog unavailable. Text discovery still works.'; }
})();
