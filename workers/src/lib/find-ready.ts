/*
 * Ready-only /v1/find: the same live storefront search, restricted to products that can be
 * shown as a mesh right now.
 *
 * Why: with no Baseten provider a picked listing parks as a `queued` job, and the headset keeps
 * a translucent measuredBox forever. Roughly ninety catalogue rows already carry an SF3D mesh
 * bound to the merchant's own measured dimensions (`state='ready' AND glb_key IS NOT NULL`),
 * so a found product that IS one of those rows can be placed at once. That set is the D1 rows
 * themselves — there is no second registry of "what has a mesh".
 *
 * Two sources, both real, both named in X-Find-Source:
 *   storefront  the merchant's own search page found it AND we already meshed that product
 *   catalog     the same query run over the meshed catalogue, to fill the wrist menu
 *
 * Not in contracts.md yet — see workers/DEPLOY.md "Schema proposals".
 */

import { catalogObjectId } from "./catalog-ingest";
import { DISTORTION_LIMIT, DISTORTION_RATIOS } from "./distortion-ratios";
import { HttpError } from "./http";
import type { FindBody, FindListing, FindResult } from "./find";
import { getObjects } from "./store";
import type { ObjectV1 } from "./contracts";

// ceiling: the wrist menu shows six listing rows (`listingTiles` in apps/xr/src/main.ts), so
// six is what a top-up aims for. The headset cannot tell the Worker its tile count today;
// upgrade path is a `tiles` field on the request body once a second client wants a different one.
const TILE_TARGET = 6;

// How many catalogue candidates to ask search for. Ranking then filtering to ready rows can
// discard most of a page, so ask for more than the target.
const TOPUP_FACTOR = 4;

/**
 * The one switch. ON restricts /v1/find to products we already have a mesh for; OFF is the
 * fully live path (unfiltered results, live generation) for when the provider is healthy.
 *
 * ceiling: one boolean for the whole deployment, not per request. Upgrade path is a request
 * field once one client wants live generation while another does not. An unset or unrecognised
 * value raises rather than picking a side (standing rule 4) — flipping it is a wrangler.toml
 * edit plus `npm run deploy:mesh`, and it must be visible that it happened.
 */
export function readyOnly(env: Env): boolean {
  const raw = (env as { FIND_READY_ONLY?: string }).FIND_READY_ONLY;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new HttpError(
    500,
    "bad_config",
    `FIND_READY_ONLY must be "1" or "0", not ${JSON.stringify(raw ?? null)}.`,
    'Set FIND_READY_ONLY in workers/wrangler.toml [vars], then `cd workers && npm run deploy:mesh`.',
  );
}

/**
 * The merchant label as it reached D1. Mirrors `slug()` in services/ingest/build_prebake.py:53
 * ("Poly & Bark" -> "Poly___Bark"), which is the write side of the same string — that file is
 * Paul's, so this is a read-side copy and not a shared helper.
 *
 * ceiling: `[A-Za-z0-9]` where Python uses Unicode `isalnum()`. Every merchant in the catalogue
 * is ASCII; a non-ASCII name would slug differently here and miss the join.
 */
export function merchantSlug(label: string): string {
  const kept = [...label].map((c) => (/[A-Za-z0-9\-_]/.test(c) ? c : "_")).join("");
  return kept.replace(/^_+/, "").replace(/_+$/, "").slice(0, 60);
}

/**
 * Every catalogue id this listing could already be stored under, most authoritative first.
 * `catalogObjectId` is the one identity rule (catalog-ingest.ts) and is reused verbatim; the
 * only thing added here is that a merchant label reaches D1 in more than one spelling.
 *
 * Empty means the listing carries neither a productUrl nor merchant+productId. It is dropped
 * and counted, never matched by title (standing rule 4).
 */
export async function catalogIdCandidates(listing: FindListing): Promise<string[]> {
  const row = listing as unknown as { productUrl?: unknown; merchant?: unknown; productId?: unknown };
  const merchant = typeof row.merchant === "string" && row.merchant ? row.merchant : null;
  const raw = row.productId ?? listing.extraction?.productId ?? null;
  const productId = typeof raw === "string" || typeof raw === "number" ? String(raw) : null;

  const ids: string[] = [];
  if (typeof row.productUrl === "string" && row.productUrl) {
    ids.push(await catalogObjectId({ productUrl: row.productUrl }));
  }
  if (merchant && productId) {
    for (const label of new Set([merchant, merchantSlug(merchant)])) {
      ids.push(await catalogObjectId({ merchant: label, productId }));
    }
  }
  return [...new Set(ids)];
}

/** A D1 row that can be placed now. */
function isReady(object: ObjectV1 | undefined): object is ObjectV1 {
  return Boolean(object && object.state === "ready" && object.glbUrl);
}

/**
 * The listing the headset receives for a product we already meshed. The geometry comes from the
 * D1 row and not from the live extraction, because the GLB was bound to the D1 row's box —
 * nothing downstream rescales a mesh (standing rule 2), so the box reported has to be the one
 * the mesh actually is. Everything else (price, URL, photo) stays the live merchant's.
 */
function asReadyListing(listing: FindListing, object: ObjectV1): FindListing {
  return {
    ...listing,
    objectId: object.objectId,
    state: "ready",
    glbUrl: object.glbUrl,
    bboxMeters: object.bboxMeters,
    findSource: "storefront",
  };
}

/** A meshed catalogue row shown as a listing. ObjectV1 already carries every field rank() reads. */
function asCatalogListing(object: ObjectV1): FindListing {
  return {
    ...object,
    merchant: object.merchant ?? "",
    productUrl: object.productUrl,
    price: object.price,
    category: object.category,
    extraction: { imageUrl: null, fits: true, via: "catalog-ready", productId: null },
    findSource: "catalog",
  } as unknown as FindListing;
}

/** Ranked catalogue candidates for a query, newest ranking first. Ids only: D1 stays the truth. */
export type ReadySearch = (body: {
  text: string;
  source: "catalog";
  fit?: FindBody["fit"];
  limit: number;
}) => Promise<string[]>;

export interface ReadyFindOutcome {
  result: FindResult;
  /** X-Find-Source: which path produced the rows, and what was thrown away. */
  header: string;
}

/**
 * Keep only the found products we already have a mesh for, then top the wrist menu up from the
 * meshed catalogue. Both halves answer the same query text; neither invents a row.
 */
export async function restrictFindToReady(
  env: Env,
  origin: string,
  body: FindBody,
  live: FindResult,
  search: ReadySearch,
): Promise<ReadyFindOutcome> {
  const candidates = await Promise.all(live.listings.map((l) => catalogIdCandidates(l)));
  const unidentified = candidates.filter((ids) => ids.length === 0).length;

  const objects = await getObjects(env, [...new Set(candidates.flat())], origin);
  const byId = new Map(objects.map((o) => [o.objectId, o]));

  const kept: FindListing[] = [];
  live.listings.forEach((listing, i) => {
    const hit = candidates[i].map((id) => byId.get(id)).find(isReady);
    if (hit) kept.push(asReadyListing(listing, hit));
  });
  const dropped = live.listings.length - kept.length - unidentified;

  const target = Math.min(TILE_TARGET, Math.max(1, body.limit ?? TILE_TARGET));
  let topped: FindListing[] = [];
  if (kept.length < target) {
    const seen = new Set(kept.map((l) => l.objectId));
    const ranked = await search({
      text: body.query,
      source: "catalog",
      ...(body.fit ? { fit: body.fit } : {}),
      limit: target * TOPUP_FACTOR,
    });
    const rows = await getObjects(env, ranked.filter((id) => !seen.has(id)), origin);
    const order = new Map(ranked.map((id, i) => [id, i]));
    const ranked2 = rows
      .filter(isReady)
      .sort((a, b) => (order.get(a.objectId) ?? 0) - (order.get(b.objectId) ?? 0));
    // A browse names nothing, so the rows arrive newest-first and the newest 30 are all side
    // tables. Take one category at a time so "show me what there is" shows a room's worth.
    const picked = body.browse ? spreadByCategory(ranked2, target - kept.length) : ranked2.slice(0, target - kept.length);
    topped = picked.map(asCatalogListing);
  }

  // Both branches are ordered together: a storefront hit can be just as stretched as a
  // catalogue one, and neither source is a reason to show a bad mesh first.
  const listings = orderByDistortion([...kept, ...topped]);
  const stretched = listings.filter((l) => (DISTORTION_RATIOS[l.objectId] ?? 0) > DISTORTION_LIMIT).length;
  const unrated = listings.filter((l) => DISTORTION_RATIOS[l.objectId] === undefined).length;
  return {
    result: { ...live, measured: listings.length, fitting: listings.length, listings },
    header: `storefront=${kept.length},catalog=${topped.length},dropped=${dropped},`
      + `unidentified=${unidentified},stretched=${stretched},unrated=${unrated}`,
  };
}

/**
 * One per category before any category repeats, keeping each category's own order. Only used
 * for a browse: a query already says what kind of thing was wanted.
 */
function spreadByCategory(rows: ObjectV1[], limit: number): ObjectV1[] {
  const byCategory = new Map<string, ObjectV1[]>();
  for (const row of rows) {
    const key = (row.category || "unknown").toLowerCase();
    (byCategory.get(key) ?? byCategory.set(key, []).get(key)!).push(row);
  }
  const out: ObjectV1[] = [];
  const queues = [...byCategory.values()];
  while (out.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (out.length >= limit) break;
      const next = q.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/**
 * Rank down a mesh the binder would rather have shown as a dimensional proxy. Nothing is hidden:
 * three tiers, in this order — a ratio at or below the limit, then a row we have no ratio for,
 * then a ratio above it. Lower ratio first inside a tier, and the sort is stable, so rows the
 * search ranked equally keep the search's order.
 *
 * A row with no ratio sits in the middle deliberately. Sorting it with the good rows would put an
 * unmeasured mesh above a measured-good one; sorting it with the bad rows would punish a row for
 * being newer than this file.
 */
export function orderByDistortion(listings: FindListing[]): FindListing[] {
  const tier = (ratio: number | undefined) => (ratio === undefined ? 1 : ratio <= DISTORTION_LIMIT ? 0 : 2);
  return listings
    .map((listing, i) => ({ listing, i, ratio: DISTORTION_RATIOS[listing.objectId] }))
    .sort((a, b) => tier(a.ratio) - tier(b.ratio) || (a.ratio ?? 0) - (b.ratio ?? 0) || a.i - b.i)
    .map((x) => x.listing);
}

/**
 * A storefront round trip that failed, as an empty result that says so. In ready-only mode the
 * catalogue top-up still runs, so Browserbase being down costs the live rows and not the demo.
 * The failure is named in `warning` and counted as storefront=0 in X-Find-Source: it is
 * reported, not swallowed.
 */
export function failedFindResult(body: FindBody, err: unknown): FindResult {
  return {
    merchant: body.merchant,
    storefront: body.storefront,
    searchUrl: null,
    searchedFor: body.query,
    handles: 0,
    products: 0,
    measured: 0,
    fitting: 0,
    fallbackSuspected: false,
    warning: err == null ? null : `storefront search failed: ${(err as Error)?.message ?? String(err)}`,
    listings: [],
  };
}
