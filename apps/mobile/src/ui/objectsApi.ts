// Object v1 reads and the generate/poll loop shared by the Scanned tab, the Furniture tab and
// the object detail screen. Lives under src/ui/ rather than src/lib/ for the same ownership
// reason as useFetchState.ts (CLAUDE.md file ownership: src/lib/api.ts and sse.ts only).
import { ApiError, assertSchema, getJSON, postJSON } from "../lib/api";
import { STUB } from "./stub";
import type { ObjectV1 } from "./types";

export type JobState = {
  state: "queued" | "running" | "done" | "failed" | string;
  progressPct: number;
  objectId: string;
  error: string | null;
};

// GET /v1/objects?source=&merchant= — see workers/DEPLOY.md "Schema proposals". Newest first.
export async function listObjects(source: ObjectV1["source"], merchant?: string | null): Promise<ObjectV1[]> {
  const params = new URLSearchParams({ source, limit: "200" });
  if (merchant) params.set("merchant", merchant);
  let objects: ObjectV1[];
  try {
    objects = await getJSON<ObjectV1[]>(`/v1/objects?${params.toString()}`, { stub: STUB });
  } catch (err) {
    // ceiling: the list route ships in workers/ alongside this screen but the deployed Worker
    // may predate it. Until it is deployed, POST /v1/search with no text is the same D1 listing
    // (routes/index.ts d1Search: source filter, newest first) capped at 50 rows. Only a 404
    // takes this path — every other failure is still raised as-is.
    if (!(err instanceof ApiError) || !/HTTP 404/.test(err.message)) throw err;
    const hits = await postJSON<{ object: ObjectV1 }[]>("/v1/search", { source, limit: 50 }, { stub: STUB });
    objects = hits.map((h) => h.object).filter((o) => !merchant || o.merchant === merchant);
  }
  if (!Array.isArray(objects)) throw new Error("GET /v1/objects did not return a list — ask Thomas");
  // contracts.md, "The one line of code that makes this loud": checked per row, not per call.
  for (const o of objects) assertSchema(o, "Object v1");
  // The stub answers the same fixture for every source; filter so the Furniture tab is not
  // showing a LiDAR-scanned laptop as a Shopify listing.
  return objects.filter((o) => o.source === source);
}

export function getObject(objectId: string): Promise<ObjectV1> {
  return getJSON<ObjectV1>(`/v1/objects/${objectId}`, { stub: STUB, schemaLabel: "Object v1" });
}

export async function startGenerate(objectId: string, tier: "live" | "quality" = "live"): Promise<string> {
  const { jobId } = await postJSON<{ jobId: string }>(`/v1/objects/${objectId}/generate`, { tier }, { stub: STUB });
  if (!jobId) throw new Error("POST /generate returned no jobId");
  return jobId;
}

export function getJob(jobId: string): Promise<JobState> {
  return getJSON<JobState>(`/v1/jobs/${jobId}`, { stub: STUB });
}

// Every merchant present in a catalog page, sorted, for the Furniture tab's menu. Rows with no
// merchant (smoke-test inserts) are grouped under a visible "Unlabelled" bucket rather than
// dropped, so a judge asking "why 15 rows but 13 in the menu" has an answer on screen.
export const UNLABELLED_MERCHANT = "Unlabelled";

export function merchantsOf(objects: ObjectV1[]): string[] {
  const set = new Set<string>();
  for (const o of objects) set.add(o.merchant ?? UNLABELLED_MERCHANT);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function formatPrice(price: ObjectV1["price"]): string | null {
  if (!price) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: price.currency, maximumFractionDigits: 0 }).format(
      price.cents / 100
    );
  } catch {
    return `${(price.cents / 100).toFixed(0)} ${price.currency}`;
  }
}
