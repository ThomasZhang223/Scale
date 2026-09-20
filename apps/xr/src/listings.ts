/*
 * Merchant listings on the headset: what is for sale that would fit here.
 *
 * Two sources, one shape. Live: POST /v1/search (contracts.md), which Thomas's Worker answers
 * from Paul's ranker or D1. Bundled: /catalog.json, built from Paul's pre-baked Shopify scrape
 * by scripts/build-catalog.mjs, used only when the live search answers nothing or fails — and
 * the UI says which one it is showing. Ranking here is arithmetic, never an LLM (standing rule
 * 3): a request becomes a Need (category + maximum metres), and rank() scores against it.
 */

import { API_BASE, STUB, type BBoxMeters, type ObjectV1 } from './api.ts';

export interface Listing extends ObjectV1 {
  bucket?: string | null; // seating | surface | storage | lighting | other
  measure?: { method: string; confidence: number };
  price?: { cents: number; currency: string } | null;
  productUrl?: string | null;
  merchant?: string | null;
  imageUrl?: string | null; // the product photo; live objects carry a thumb at /assets/objects/{id}/thumb.jpg
}

/** What is being looked for. Every length is metres; a missing bound means "any". */
export interface Need {
  text?: string;
  bucket?: Listing['bucket'];
  categoryWords?: string[]; // any of these in the listing's category or name
  maxW?: number;
  maxH?: number;
  maxD?: number;
  /** The scanned piece this would replace, when the need came from one. */
  replaces?: { identifier: string; category: string };
}

export interface Recommendation {
  listing: Listing;
  score: number; // 0..1
  reasons: string[]; // short, in the order they were weighed
}

export type ListingsSource = 'live' | 'bundled';

/** RoomPlan categories → the words a listing for the same kind of thing uses. */
const DETECTED_WORDS: Record<string, { bucket: Listing['bucket']; words: string[] }> = {
  chair: { bucket: 'seating', words: ['chair', 'stool', 'bench'] },
  sofa: { bucket: 'seating', words: ['sofa', 'sectional', 'loveseat', 'couch'] },
  table: { bucket: 'surface', words: ['table', 'desk'] },
  bed: { bucket: null, words: ['bed', 'mattress'] },
  storage: { bucket: 'storage', words: ['storage', 'dresser', 'bookcase', 'shelv', 'cabinet', 'console', 'armoire'] },
  television: { bucket: 'surface', words: ['console', 'media', 'tv'] },
  lamp: { bucket: 'lighting', words: ['lamp', 'light', 'sconce', 'chandelier', 'pendant'] },
};

const CAT_MARGIN = 1.15; // a replacement may be up to 15% larger than the piece it stands in for

/** A need that fits where a scanned piece stands: same kind, no more than ~15% larger. */
export function needFromDetected(box: { identifier: string; category: string; dimensions: [number, number, number] }): Need {
  const [w, h, d] = box.dimensions;
  const known = DETECTED_WORDS[box.category.toLowerCase()];
  return {
    bucket: known?.bucket ?? undefined,
    categoryWords: known?.words ?? [box.category.toLowerCase()],
    maxW: w * CAT_MARGIN,
    maxH: h * CAT_MARGIN * 1.5, // height is the least constrained: nothing stands above most furniture
    maxD: d * CAT_MARGIN,
    replaces: { identifier: box.identifier, category: box.category },
  };
}

const LENGTH = /(\d+(?:\.\d+)?)\s*(cm|centimet\w*|m|metres?|meters?|mm|millimet\w*|in|inch\w*|"|ft|feet|foot|')/gi;

/** Metres from a spoken or typed length; conversion happens here, at the UI edge, and nowhere else. */
export function parseLengthMetres(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('cm') || u.startsWith('centi')) return value / 100;
  if (u.startsWith('mm') || u.startsWith('milli')) return value / 1000;
  if (u.startsWith('in') || u === '"') return value * 0.0254;
  if (u.startsWith('f') || u === "'") return value * 0.3048;
  return value;
}

/**
 * A need from a sentence: "find a lamp under 1.5 m", "something 80 cm wide for beside the
 * desk", "a sofa no deeper than 90 cm". Words pick the kind; the first length with "wide" /
 * "deep" / "tall" nearby (or none) sets that bound.
 */
export function needFromText(text: string): Need {
  const lower = text.toLowerCase();
  const need: Need = { text: text.trim() };
  // The thing asked for is named first; what it sits beside comes later ("a lamp … beside my desk").
  let first = Infinity;
  for (const [category, { bucket, words }] of Object.entries(DETECTED_WORDS)) {
    const at = Math.min(...[...words, category].map((w) => { const i = lower.indexOf(w); return i < 0 ? Infinity : i; }));
    if (at < first) {
      first = at;
      need.bucket = bucket ?? undefined;
      need.categoryWords = words;
    }
  }
  for (const m of lower.matchAll(LENGTH)) {
    const metres = parseLengthMetres(parseFloat(m[1]), m[2]);
    const after = lower.slice(m.index! + m[0].length, m.index! + m[0].length + 16);
    let before = lower.slice(Math.max(0, m.index! - 20), m.index!);
    if (/\d/.test(before)) before = ''; // that qualifier belongs to the previous length ("1.5 m tall for the 80 cm gap")
    const around = `${before} ${after}`;
    if (/\b(deep\w*|depth)\b/.test(around)) need.maxD = metres;
    else if (/\b(tall\w*|high\w*|height)\b/.test(around)) need.maxH = metres;
    else need.maxW = metres; // "80 cm gap", "under 1.5 m", "1 m wide"
  }
  return need;
}

/** The verified Shopify storefronts (services/ingest/merchants.verified.json), searched live. */
// ceiling: a fixed list; the upgrade is GET /v1/merchants once Paul's scout table is seeded.
export const STOREFRONTS: readonly { merchant: string; storefront: string }[] = [
  { merchant: 'Poly & Bark', storefront: 'https://polyandbark.com/' },
  { merchant: 'InStyle Home', storefront: 'https://instylehome.ca/' },
  { merchant: 'Sabai Design', storefront: 'https://sabai.design/' },
];

const IMPERATIVE = /^\s*(?:(?:please|can you|could you)\s+)?(?:find|show|get|recommend|suggest|search(?: for)?|look for|buy|shop for)\s+(?:me\s+)?(?:(?:a|an|some|the)\b)?\s*/i;
const LENGTH_PHRASE = /\b(?:under|below|less than|no more than|up to|max(?:imum)?|at most|no (?:wider|deeper|taller) than)?\s*\d+(?:\.\d+)?\s*(?:cm|centimet\w*|m|metres?|meters?|mm|millimet\w*|in|inch\w*|"|ft|feet|foot|')\s*(?:wide|deep|tall|high|long)?\b/gi;
const GAP_PHRASE = /\b(?:for|in|into)\s+the\s+gap\b/gi;

/**
 * The product words the merchant's own search should see: the sentence minus the imperative
 * ("find me a") and minus the lengths needFromText already turned into bounds. No LLM; the
 * merchant's search knows its own vocabulary better than a parser here would.
 */
export function productQuery(text: string): string {
  return text
    .replace(IMPERATIVE, '')
    .replace(LENGTH_PHRASE, ' ')
    .replace(GAP_PHRASE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.]+|[\s,.]+$/g, '')
    .trim();
}

export type FindStage = 'searching' | 'measuring' | 'done' | 'failed';
export interface StageInfo {
  merchant: string;
  stage: FindStage;
  detail: string;
  /** The storefront page being read — shown as the address bar of that store's window. */
  url?: string | null;
  /** Product photos that page yielded, as soon as the store answers: the "browsing" the headset can show. */
  photos?: string[];
}
export type OnStage = (info: StageInfo) => void;

interface FindResponse {
  merchant: string; searchUrl: string | null; handles: number; products: number; measured: number; fitting: number;
  fallbackSuspected: boolean; warning: string | null;
  listings: (Listing & { extraction?: { imageUrl?: string | null; fits?: boolean } })[];
}

// ceiling: /v1/find is one round trip, so the headset cannot see the find→extract boundary.
// The row flips to "measuring" on a timer instead. Upgrade path: stream stages from the Worker.
const MEASURING_AFTER_MS = 12_000;

/**
 * Live search: POST /v1/find per storefront, in parallel, through Browserbase on the server.
 * Reports each store's stage as it goes; resolves with every store's measured rows merged.
 * Throws only when every store failed, so the caller can fall back and say why.
 */
export async function findLive(need: Need, limit: number, onStage: OnStage = () => {}, fetchFn: typeof fetch = fetch): Promise<Listing[]> {
  const query = productQuery(need.text ?? need.categoryWords?.[0] ?? '');
  if (!query) throw new Error('nothing to search for');
  const fit: Record<string, number> = {};
  if (need.maxW != null) fit.maxW = need.maxW;
  if (need.maxH != null) fit.maxH = need.maxH;
  if (need.maxD != null) fit.maxD = need.maxD;

  const one = async ({ merchant, storefront }: { merchant: string; storefront: string }): Promise<Listing[]> => {
    // The page Browserbase is about to render; the server reports the real one when it answers.
    const url = `${storefront.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}`;
    onStage({ merchant, stage: 'searching', detail: 'rendering the search page…', url });
    const timer = setTimeout(() => onStage({ merchant, stage: 'measuring', detail: 'measuring products…', url }), MEASURING_AFTER_MS);
    try {
      const res = await fetchFn(`${API_BASE}/find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(STUB ? { 'X-Stub': '1' } : {}) },
        body: JSON.stringify({ storefront, merchant, query, limit, ...(Object.keys(fit).length ? { fit } : {}) }),
      });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try { detail = ((await res.json()) as { message?: string }).message ?? detail; } catch { /* not JSON */ }
        throw new Error(detail);
      }
      const out = (await res.json()) as FindResponse;
      const rows = out.listings.map((l) => ({ ...l, merchant: l.merchant ?? merchant, imageUrl: l.imageUrl ?? l.extraction?.imageUrl ?? null }));
      const fits = out.listings.filter((l) => l.extraction?.fits !== false).length;
      onStage({
        merchant, stage: 'done',
        detail: out.fallbackSuspected ? `${out.measured} measured, none match — ${out.warning ?? 'store fallback'}` : `${out.handles} found, ${out.measured} measured, ${fits} fit`,
        url: out.searchUrl ?? url,
        photos: rows.map((l) => l.imageUrl).filter((u): u is string => !!u).slice(0, 6),
      });
      return rows;
    } catch (err) {
      onStage({ merchant, stage: 'failed', detail: (err as Error).message, url });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  const settled = await Promise.allSettled(STOREFRONTS.map(one));
  const rows = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  if (settled.every((s) => s.status === 'rejected')) {
    const reasons = settled.map((s, i) => `${STOREFRONTS[i].merchant}: ${(s as PromiseRejectedResult).reason?.message ?? 'failed'}`).join('; ');
    throw new Error(`every store failed (${reasons})`);
  }
  return rows;
}

/** Fits within every bound the need sets; a bound that isn't set never fails. */
export function fitsNeed(b: BBoxMeters, need: Need): boolean {
  if (need.maxW != null && b.w > need.maxW) return false;
  if (need.maxH != null && b.h > need.maxH) return false;
  if (need.maxD != null && b.d > need.maxD) return false;
  return true;
}

const fmt = (m: number) => `${Math.round(m * 100)} cm`;

/**
 * Deterministic ranking. Kind first (the wrong kind of thing never outranks the right kind),
 * then how well it uses the space (a 78 cm chair in an 80 cm gap beats a 40 cm stool), then
 * the extractor's confidence in the measurement. Anything that does not fit is left out.
 */
export function rank(listings: Listing[], need: Need, limit = 8): Recommendation[] {
  const out: Recommendation[] = [];
  for (const l of listings) {
    if (!fitsNeed(l.bboxMeters, need)) continue;
    // The merchant's category decides the kind; the title only when there is no category
    // ("Light Teak" is a colour, not a lamp).
    const hay = (l.category && l.category !== 'furniture' ? l.category : l.name ?? '').toLowerCase();
    const reasons: string[] = [];
    let score = 0;

    const kindHit = need.categoryWords?.some((w) => hay.includes(w)) ?? false;
    const bucketHit = need.bucket != null && l.bucket === need.bucket;
    if (need.categoryWords || need.bucket) {
      if (kindHit) {
        score += 0.5;
        reasons.push(need.replaces ? `a ${need.replaces.category} like the one scanned` : `matches "${need.categoryWords![0]}"`);
      } else if (bucketHit) {
        score += 0.25;
        reasons.push(`same kind of piece (${l.bucket})`);
      } else continue; // wrong kind: not a recommendation at all
    } else {
      score += 0.3; // no kind asked for: everything that fits is a candidate
    }

    const bounds = [need.maxW, need.maxD].filter((v): v is number => v != null);
    if (bounds.length) {
      const use = Math.min(1, ((need.maxW ? l.bboxMeters.w / need.maxW : 1) + (need.maxD ? l.bboxMeters.d / need.maxD : 1)) / 2);
      score += 0.35 * use;
      if (need.maxW != null) reasons.push(`${fmt(l.bboxMeters.w)} wide, ${fmt(need.maxW - l.bboxMeters.w)} to spare`);
    } else {
      score += 0.2;
    }

    const conf = l.measure?.confidence ?? 0.5;
    score += 0.15 * conf;
    if (conf < 0.7) reasons.push('size unverified');

    out.push({ listing: l, score: Math.min(1, score), reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.listing.name.localeCompare(b.listing.name)).slice(0, limit);
}

interface SearchHit {
  objectId: string;
  score: number;
  object: Listing;
}

async function liveSearch(need: Need, limit: number): Promise<Listing[]> {
  const body: Record<string, unknown> = { source: 'catalog', limit: Math.min(50, Math.max(limit * 3, 12)) };
  if (need.text) body.text = need.text;
  else if (need.categoryWords?.length) body.text = need.categoryWords[0];
  const fit: Record<string, number> = {};
  if (need.maxW != null) fit.maxW = need.maxW;
  if (need.maxH != null) fit.maxH = need.maxH;
  if (need.maxD != null) fit.maxD = need.maxD;
  if (Object.keys(fit).length) body.fit = fit;
  const res = await fetch(`${API_BASE}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(STUB ? { 'X-Stub': '1' } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from POST ${API_BASE}/search`);
  const hits = (await res.json()) as SearchHit[];
  return hits.map((h) => ({
    ...h.object,
    // Thumbnails live at a derived key (contracts.md: R2 key layout); the Worker serves them.
    imageUrl: h.object.imageUrl ?? `${API_BASE}/assets/objects/${h.object.objectId}/thumb.jpg`,
  }));
}

let bundled: Promise<Listing[]> | null = null;
export function bundledListings(url = '/catalog.json'): Promise<Listing[]> {
  if (!bundled) {
    bundled = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} from ${url}: run \`node scripts/build-catalog.mjs\``);
      return (await res.json()) as Listing[];
    });
    bundled.catch(() => (bundled = null));
  }
  return bundled;
}

export interface ListingsResult {
  recommendations: Recommendation[];
  source: ListingsSource;
  note: string | null; // why the bundled catalogue is showing, when it is
}

/** Live first; the bundled scrape only when live has nothing, and the result says so. */
export async function findListings(
  need: Need,
  limit = 8,
  opts: { live?: (n: Need, l: number) => Promise<Listing[]>; bundled?: () => Promise<Listing[]>; onStage?: OnStage } = {},
): Promise<ListingsResult> {
  const live = opts.live ?? ((n: Need, l: number) => findLive(n, l, opts.onStage));
  let note: string | null = null;
  try {
    const rows = await live(need, limit);
    if (rows.length) return { recommendations: rank(rows, need, limit), source: 'live', note: null };
    note = 'Live catalogue has nothing indexed yet; showing the bundled scrape.';
  } catch (err) {
    note = `Live search failed (${(err as Error).message}); showing the bundled scrape.`;
  }
  const rows = await (opts.bundled ?? bundledListings)();
  return { recommendations: rank(rows, need, limit), source: 'bundled', note };
}

/** True when the sentence is a shopping request rather than a rearranging one. */
export function isShoppingRequest(text: string): boolean {
  return /\b(find|recommend|suggest|buy|shop|shopping|for sale|listing|listings|purchase|something that fits|what fits|replace)\b/i.test(text);
}
