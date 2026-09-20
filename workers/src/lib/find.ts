// POST /v1/find: the headset's "find me a lamp" against one Shopify storefront, live.
//
// Two upstream calls into services/ingest, both token-gated there, which is why the headset
// cannot make them itself: /find renders the merchant's own search page through Browserbase and
// returns raw Shopify products; /extract measures them into Object v1 rows. Nothing is written
// to D1 here — a listing becomes an object only when someone picks it (POST /v1/listings/generate).
//
// Not in contracts.md yet — see workers/DEPLOY.md "Schema proposals".

import { HttpError } from "./http";

export interface FindBody {
  storefront: string;
  merchant: string;
  query: string;
  fit?: { maxW?: number; maxH?: number; maxD?: number };
  limit?: number;
}

export interface FindListing {
  objectId: string;
  name: string;
  category: string | null;
  bboxMeters: { w: number; h: number; d: number };
  merchant: string;
  productUrl: string | null;
  price: { cents: number; currency: string } | null;
  measure: { method: string; confidence: number };
  extraction: { imageUrl: string | null; fits: boolean; via: string; productId: string | null };
  [k: string]: unknown;
}

export interface FindResult {
  merchant: string;
  storefront: string;
  searchUrl: string | null;
  searchedFor: string | null;
  handles: number;
  products: number;
  measured: number;
  fitting: number;
  fallbackSuspected: boolean;
  warning: string | null;
  listings: FindListing[];
}

export type UpstreamCall = <T>(path: string, body: unknown, timeoutMs?: number) => Promise<T>;

interface IngestFind {
  query: string; searchedFor: string; searchUrl?: string; count: number;
  handles: string[]; products: unknown[]; fallbackSuspected?: boolean; warning?: string | null;
}
interface IngestExtract { merchant: string; count: number; stats: Record<string, number>; objects: FindListing[] }

const FIND_TIMEOUT_MS = 45_000;    // one Browserbase render plus a catalogue join
const EXTRACT_TIMEOUT_MS = 60_000; // up to pageLimit rendered product pages
const PAGE_LIMIT = 12;             // ceiling: rendered pages per store; raise once stages stream

export function assertFindBody(body: unknown): FindBody {
  const b = (body ?? {}) as Record<string, unknown>;
  for (const key of ["storefront", "merchant", "query"] as const) {
    if (typeof b[key] !== "string" || !(b[key] as string).trim()) {
      throw new HttpError(400, "missing_field", `${key} is required.`); // standing rule 4
    }
  }
  return b as unknown as FindBody;
}

export async function runFind(call: UpstreamCall, body: FindBody): Promise<FindResult> {
  const limit = Math.min(50, Math.max(1, body.limit ?? 12));
  const found = await call<IngestFind>("/find", { storefront: body.storefront, query: body.query, limit }, FIND_TIMEOUT_MS);
  const base: Omit<FindResult, "measured" | "fitting" | "listings"> = {
    merchant: body.merchant,
    storefront: body.storefront,
    searchUrl: found.searchUrl ?? null,
    searchedFor: found.searchedFor ?? null,
    handles: found.handles?.length ?? 0,
    products: found.products?.length ?? 0,
    fallbackSuspected: Boolean(found.fallbackSuspected),
    warning: found.warning ?? null,
  };
  if (!found.products?.length) return { ...base, measured: 0, fitting: 0, listings: [] };

  const extracted = await call<IngestExtract>("/extract", {
    products: found.products,
    merchant: body.merchant,
    storefront: body.storefront,
    browserbase: true,
    pageLimit: PAGE_LIMIT,
    fit: body.fit,
  }, EXTRACT_TIMEOUT_MS);
  return {
    ...base,
    measured: extracted.objects.length,
    fitting: extracted.stats?.fitting ?? extracted.objects.length,
    listings: extracted.objects,
  };
}
