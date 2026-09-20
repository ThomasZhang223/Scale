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
  /** Product words from the intent parser, when it produced a cleaner set than productQuery. */
  query?: string;
  /** "show me what there is": nothing was named, so answer from the meshed catalogue. */
  browse?: boolean;
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

// [\s-]*, not \s*: ElevenLabs STT writes a spoken length as "80-centimeter", with a hyphen and
// the US spelling, so \s* dropped the bound silently on every voice request while the same
// phrase typed by hand worked. STT also writes "eighty" as "80", so no word-number parser here.
const LENGTH = /(\d+(?:\.\d+)?)[\s-]*(cm|centimet\w*|m|metres?|meters?|mm|millimet\w*|in|inch\w*|"|ft|feet|foot|')/gi;

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

/**
 * The verbs that mean "get me one of these", in ONE list, read by both the intent router and
 * productQuery.
 *
 * Keeping two lists is what broke voice: routing tested a shorter set than the parser behind it
 * could handle, so "show me some lamps" went to the layout agent while productQuery was
 * perfectly able to turn it into "lamps". A verb added here is understood by both, or by
 * neither.
 */
export const SHOP_VERBS = [
  'find', 'show', 'get', 'recommend', 'suggest', 'search for', 'search', 'look for',
  'looking for', 'buy', 'shop for', 'shop', 'purchase', 'order', 'browse',
  // "Add a couch" is a request for a thing, not an instruction to move one. 'put' and 'place'
  // are deliberately absent: those belong to the layout agent ("put the lamp in the corner").
  'add', 'bring in', 'bring', 'give me', 'give',
] as const;

/**
 * The same thing said as a statement or a question rather than an order. "I need a new side
 * table" is what a person actually says to a headset, and it has no imperative verb in it at
 * all, so routing and productQuery both need it here or neither gets it.
 */
export const SHOP_LEAD_INS = [
  "i need", "i want", "i'd like", "i would like", "i'm looking for", "i am looking for",
  "do you have", "do you sell", "is there", "are there", "how about",
] as const;

/** Longest first, so "search for" wins over "search" inside one alternation. */
const alt = (words: readonly string[]) =>
  [...words].sort((a, b) => b.length - a.length).join('|').replace(/ /g, '\\s+');
const VERBS = alt(SHOP_VERBS);
/** Everything a shopping sentence can open with. One list, read by the router and the parser. */
const HEADS = alt([...SHOP_VERBS, ...SHOP_LEAD_INS]);

// Speech starts with noise a keyboard never does: "Hey, can you…", "Ok so, find me…". The
// anchor stays — an unanchored verb match would eat "the lamp I want to get" — and the fillers
// are consumed ahead of it instead.
const FILLER = String.raw`(?:(?:hey|hi|hello|ok|okay|so|um|uh|well|alright|right)\b[\s,]*)*`;
const POLITE = String.raw`(?:(?:can|could|would|will)\s+you\s+|i(?:'d|\s+would)\s+like\s+you\s+to\s+|please\s+)*`;
/** "a new side table" and "any lamps" are both the article, not the product. */
const ARTICLE = String.raw`(?:(?:a|an|any|some|the|new)\b\s*)*`;
const IMPERATIVE = new RegExp(`^\\s*${FILLER}${POLITE}(?:${HEADS})\\s+(?:me\\s+)?${ARTICLE}`, 'i');
const LENGTH_PHRASE = /\b(?:under|below|less than|no more than|up to|max(?:imum)?|at most|no (?:wider|deeper|taller) than)?[\s-]*\d+(?:\.\d+)?[\s-]*(?:cm|centimet\w*|m|metres?|meters?|mm|millimet\w*|in|inch\w*|"|ft|feet|foot|')\s*(?:wide|deep|tall|high|long)?\b/gi;
const GAP_PHRASE = /\b(?:for|in|into)\s+the\s+gap\b/gi;
/**
 * "…that fits the 80 cm gap beside my desk" — needFromText has already turned that into maxW,
 * and the merchant's search engine does worse with it than without it. Everything from the
 * relative pronoun to the end goes, which is where such a clause always sits in speech.
 */
const FIT_CLAUSE = /\b(?:that|which)\s+(?:will\s+|would\s+)?fits?\b.*$/i;

/**
 * The product words the merchant's own search should see: the sentence minus the imperative
 * ("find me a") and minus the lengths needFromText already turned into bounds. No LLM; the
 * merchant's search knows its own vocabulary better than a parser here would.
 */
export function productQuery(text: string): string {
  return text
    .replace(IMPERATIVE, '')
    .replace(FIT_CLAUSE, ' ')
    .replace(LENGTH_PHRASE, ' ')
    .replace(GAP_PHRASE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.]+|[\s,.?!]+$/g, '')
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
  const query = need.query ?? productQuery(need.text ?? need.categoryWords?.[0] ?? '');
  if (!query && !need.browse) throw new Error('nothing to search for');
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
        body: JSON.stringify({ storefront, merchant, query, limit, ...(need.browse ? { browse: true } : {}), ...(Object.keys(fit).length ? { fit } : {}) }),
      });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try { detail = ((await res.json()) as { message?: string }).message ?? detail; } catch { /* not JSON */ }
        throw new Error(detail);
      }
      const out = (await res.json()) as FindResponse;
      const rows = out.listings.map((l) => ({ ...l, merchant: l.merchant ?? merchant, imageUrl: l.imageUrl ?? l.extraction?.imageUrl ?? null }));
      const fits = out.listings.filter((l) => l.extraction?.fits !== false).length;
      // A warning with no fallbackSuspected is the ready-only path saying the storefront round
      // trip itself failed and these rows came from the meshed catalogue instead. Saying only
      // "N measured" there would hide a dead store behind a full-looking menu.
      const detail = out.fallbackSuspected
        ? `${out.measured} measured, none match — ${out.warning ?? 'store fallback'}`
        : out.warning
          ? `${out.warning} — ${out.measured} from the catalogue`
          : `${out.handles} found, ${out.measured} measured, ${fits} fit`;
      onStage({
        merchant, stage: 'done', detail,
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
  // One objectId, one row. Each store's answer is topped up from the SAME meshed catalogue when
  // the Worker is in ready-only mode (X-Find-Source), so three stores return the same rows three
  // times. First occurrence wins; rank() re-sorts against the need afterwards either way.
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.objectId)) return false;
    seen.add(r.objectId);
    return true;
  });
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
    // A merchant category is free text — the live "lamp" result set carries "christmas",
    // "decor/home accents" and "tables" — so it cannot be the only thing that gates a row named
    // "Small Natural LED Lamps"; reading the category alone dropped five of those six rows. The
    // title counts too, but only when the bucket does not say otherwise, which is what keeps
    // "Chair-side lamp" out of a search for a chair.
    const cat = (l.category ?? '').toLowerCase();
    const title = (l.name ?? '').toLowerCase();
    const reasons: string[] = [];
    let score = 0;

    const bucketHit = need.bucket != null && l.bucket === need.bucket;
    const wrongBucket = need.bucket != null && l.bucket != null && l.bucket !== need.bucket;
    const kindHit = need.categoryWords?.some((w) => cat.includes(w) || (!wrongBucket && title.includes(w))) ?? false;
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
  // Equal score keeps the order the rows arrived in, which is the Worker's: least distorted mesh
  // first (X-Find-Source, lib/find-ready.ts). Array.prototype.sort is stable, so no tie-break is
  // needed to hold that. An alphabetical tie-break was here before and shuffled it away.
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
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

/*
 * Intent routing. Three destinations, decided by this one pure function and nothing else: the
 * user's own scans, the merchant search, or the layout agent. No LLM decides a route
 * (standing rule 3) — an LLM turns an intent into an objective, it does not pick the handler.
 */

export type IntentKind = 'command' | 'mine' | 'shop' | 'library' | 'design';

/**
 * A spoken button press. The value is an intent, not an action id: `putback` means "undo what
 * just happened", and only main.ts knows whether that is the proposal's Put back or the layout
 * Undo. Nothing destructive is here on purpose — Reset room and Clear stay tablet-only, because
 * a misheard word must not be able to empty the room on stage.
 */
export type Command =
  | 'keep' | 'putback' | 'ask_again' | 'rearrange' | 'listings'
  | 'page:Designer' | 'page:Room' | 'page:My scans' | 'page:Furniture';

/**
 * Whole utterance only, and short. "Keep it" is a command; "keep the sofa by the window" is a
 * sentence for the layout agent, and anchoring both ends is what keeps the two apart. Every
 * pattern here is matched against the utterance with its fillers and final punctuation already
 * removed.
 */
const COMMANDS: [RegExp, Command][] = [
  [/^(?:keep(?: it| this| that)?|accept(?: it| that)?|(?:that |it )?looks good|that works|perfect|i like it)$/, 'keep'],
  [/^(?:put (?:it|that|them) back|undo(?: that| it)?|revert(?: that)?|never ?mind|cancel that|no thanks)$/, 'putback'],
  [/^(?:try again|ask again|another option|other options|something else|a different one)$/, 'ask_again'],
  [/^rearrange(?: the room| it| everything)?$/, 'rearrange'],
  [/^(?:show|open|reopen)(?: the)?(?: my)? listings$/, 'listings'],
  [/^(?:open|go to|switch to)(?: the)? designer$/, 'page:Designer'],
  [/^(?:open|go to|switch to)(?: the)? room$/, 'page:Room'],
  [/^(?:open|go to|switch to)(?: the| my)? scans$/, 'page:My scans'],
  [/^(?:open|go to|switch to)(?: the)? (?:furniture|catalogue|catalog)$/, 'page:Furniture'],
];

/** The words either side of a command: "Ok, keep it." is "keep it". */
function bareUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\s,]*(?:(?:hey|hi|hello|ok|okay|so|um|uh|well|alright|right|please|yes|yeah)\b[\s,]*)*/, '')
    .replace(/[\s.!?,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The command this utterance IS, or null when it is a sentence rather than a button press. */
export function commandOf(text: string): Command | null {
  const bare = bareUtterance(text);
  for (const [pattern, command] of COMMANDS) if (pattern.test(bare)) return command;
  return null;
}

export interface Intent {
  kind: IntentKind;
  /** Set only when kind is 'command'. */
  command: Command | null;
  /** The utterance names the most recent scan ("my latest scan", "the one I just scanned"). */
  newest: boolean;
  /** The utterance asks to SEE the scans rather than to place one ("what have I scanned"). */
  listOnly: boolean;
}

/** Unambiguous: these can only be about something the user captured. */
const MINE_STRONG = /\b(?:i (?:just )?scanned|i(?:'ve|\s+have) scanned|have i scanned|did i scan|i (?:just )?captured|i(?:'ve|\s+have) captured|my scans?|my captures?|my stuff|my things|my own|from my phone|with my phone|on my phone)\b/i;

/** "my desk" in "beside my desk" is where a thing goes, not the thing being asked for. */
const LOCATIVE_MY = /\b(?:beside|next to|nearby|near|by|against|behind|under|underneath|below|over|above|on|onto|in|into|in front of|opposite|across from|around|between|to the (?:left|right) of)\s+(?:the\s+)?(?:my|mine)\b/gi;

const MY = /\b(?:my|mine)\b/gi;
const NEWEST = /\b(?:latest|newest|last|most recent|just (?:scanned|captured)|i just)\b/i;
const LIST_ONLY = /\b(?:my scans|my captures|what have i scanned|what did i scan|everything i(?:'ve|\s+have) scanned|all my|list my|which .{0,20}(?:have i|did i) scan)\b/i;

/**
 * Names a place to shop. Without one of these, a plain "add a couch" means the built-in
 * library — those meshes are authored, already local, and need no network search.
 */
const NAMES_A_STORE = /\b(?:shopify|store|shop|shopping|buy|purchase|order|for sale|online|listings?|merchant|in stock)\b/i;

/** A strong buy-word: nothing else it could mean, so it outranks a rearranging verb. */
const SHOP_STRONG = /\b(?:find|buy|purchase|order|shop|shopping|browse|for sale|listings?|in stock|to buy)\b/i;
/** A weak one: it means shopping only when nothing is being moved. */
const SHOP_WEAK = new RegExp(`\\b(?:${HEADS}|do you stock|something that fits|what fits|anything that fits)\\b`, 'i');
/**
 * Moving what is already here. Beats a weak shop word: "I need the sofa moved" is not shopping.
 * Stems, because speech inflects them — "moved", "facing", "rearranging". "Fits" is deliberately
 * absent: "something that fits the gap" is the shopping sentence this whole feature exists for.
 */
const REARRANGE = /\b(?:mov|turn|rotat|spin|fac|put|plac|slid|push|pull|swap|shift|arrang|rearrang|tidy|clear|remov|delet|undo|redo)\w*\b|\bmake (?:it|the|this)\b/i;

/**
 * Which of the three handlers a sentence belongs to. "my" beats shopping, so "find my chair"
 * asks the scan library and not the merchants.
 *
 * ceiling: regular expressions over English, which is why every rule above is one the report can
 * quote and the table below can test. The upgrade path is an intent classifier on the Worker —
 * not an LLM choosing the handler, but one turning the utterance into a structured request.
 */
export function classifyUtterance(text: string): Intent {
  const t = text.trim();
  const plain = { command: null, newest: false, listOnly: false };
  // A command first, because it is the only test that must match the WHOLE utterance: a
  // sentence long enough to be a request can never be one, so nothing else is shadowed.
  const command = commandOf(t);
  if (command) return { kind: 'command', command, newest: false, listOnly: false };
  const newest = NEWEST.test(t);
  const listOnly = LIST_ONLY.test(t);
  if (MINE_STRONG.test(t) || ownsAnUnplacedMy(t)) return { kind: 'mine', command: null, newest, listOnly };
  // A request for a piece of furniture with no store named goes to the library first; the
  // library handler falls through to the merchants when it has no match. Same default the
  // model is told to use, so the two routers agree on this turn whichever one answered.
  if (SHOP_STRONG.test(t)) return { kind: NAMES_A_STORE.test(t) ? 'shop' : 'library', ...plain };
  if (REARRANGE.test(t)) return { kind: 'design', ...plain };
  if (SHOP_WEAK.test(t)) return { kind: NAMES_A_STORE.test(t) ? 'shop' : 'library', ...plain };
  return { kind: 'design', ...plain };
}

/** At least one "my" that names the thing asked for rather than where it goes. */
function ownsAnUnplacedMy(text: string): boolean {
  const placed = new Set<number>();
  for (const m of text.matchAll(LOCATIVE_MY)) placed.add(m.index! + m[0].toLowerCase().lastIndexOf('m'));
  for (const m of text.matchAll(MY)) if (!placed.has(m.index!)) return true;
  return false;
}

/**
 * True when the sentence asks for a PRODUCT — from the merchants or from the built-in library.
 * Both are "something to put in the room that you do not already own"; which of the two answers
 * is `classifyUtterance`'s business, not the caller's.
 */
export function isShoppingRequest(text: string): boolean {
  const kind = classifyUtterance(text).kind;
  return kind === 'shop' || kind === 'library';
}


/*
 * Picking from the built-in library.
 *
 * Two signals, in order, because they fail differently. A word that appears in a row's name or
 * category is exact and survives the model handing back a noisy query ("sofa from our
 * furniture" still contains "sofa"). A vector score handles the synonyms a word match cannot —
 * measured on the deployed index: couch -> sofa 0.9695, armchair -> chair 0.9646, settee ->
 * sofa 0.9287, while lamp's best is 0.8907 and desk's is 0.8890 with nothing of either kind in
 * the library.
 *
 * Re-measured 2026-09-20 against the grown library (33 authored rows, real names). The word
 * half now carries most of the work — "desk" matches "Metal office desk", "nightstand" matches
 * "Classic nightstand" — and the vector half is left with the true synonyms. Those score
 * 0.9141 (bookshelf -> Wooden bookcase) to 0.9695 (couch -> sofa), while things the library
 * genuinely does not have score 0.8610 to 0.8952 (swimming pool, bicycle, toaster, sandwich).
 * The bar sits in that gap.
 *
 * ceiling: a bar tuned on one library. It was 0.93 when the library was three rows and would
 * now reject "lamp" and "desk"; re-measure it the same way (POST /v1/search {text,
 * source:"primitive"}, a handful of synonyms and a handful of absurdities) whenever the library
 * changes size. The word half needs no calibration and gets better as names get better.
 */
export const SIMILAR_ENOUGH = 0.91;

const STOP = new Set(['a', 'an', 'the', 'some', 'any', 'me', 'my', 'our', 'your', 'from', 'for', 'in', 'into',
  'of', 'on', 'to', 'and', 'or', 'is', 'are', 'it', 'this', 'that', 'please', 'new', 'one', 'like', 'want',
  'need', 'add', 'put', 'bring', 'give', 'get', 'show', 'find', 'already', 'here', 'room', 'furniture']);

/** The words worth matching a row against: what was asked for, minus the scaffolding. */
export function queryWords(query: string | null | undefined): string[] {
  return (query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Rows whose own name or category carries one of those words, best overlap first. */
export function matchLibraryByWord(rows: Listing[], query: string | null | undefined): Listing[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const scored = rows
    .map((row) => {
      const hay = `${row.name ?? ''} ${row.category ?? ''}`.toLowerCase();
      return { row, hits: words.filter((w) => hay.includes(w)).length };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.filter((s) => s.hits === scored[0].hits).map((s) => s.row);
}
