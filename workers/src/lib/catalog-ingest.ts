import { contentHash } from "./ids";
import { HttpError, json, readJson } from "./http";
import { assertBBoxMeters } from "./validate";
import { enqueueMesh } from "./mesh-dispatch";
import { insertObject } from "./store";

async function stableId(value: unknown): Promise<string> {
  const h = await contentHash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface CatalogItem {
  objectId: string;
  name: string;
  description: string;
  imageUrl: string;
  category: string;
  bboxMeters: { w: number; h: number; d: number };
  measure: { method: string; confidence: number };
  merchant: string | null;
  productUrl: string | null;
  price: { cents: number; currency: string } | null;
}

export async function normalizeCatalogItem(value: unknown): Promise<CatalogItem> {
  if (!value || typeof value !== "object") throw new HttpError(422, "bad_item", "Expected a catalogue object.");
  const row = value as Record<string, any>;
  assertBBoxMeters(row.bboxMeters, "catalogue item");
  const imageUrl = row.imageUrl ?? row.extraction?.imageUrl;
  let image: URL;
  try { image = new URL(imageUrl); } catch { throw new HttpError(422, "missing_image", "Each item needs an HTTPS imageUrl."); }
  if (image.protocol !== "https:" || image.username || image.password) {
    throw new HttpError(422, "bad_image", "imageUrl must be HTTPS without credentials.");
  }
  const identity = row.productUrl || (row.merchant && row.productId ? `${row.merchant}:${row.productId}` : row.objectId);
  if (typeof identity !== "string" || !identity) throw new HttpError(422, "missing_identity", "Supply productUrl, merchant + productId, or objectId.");
  const objectId = await stableId(identity);
  const name = row.name ?? row.title;
  if (typeof name !== "string" || !name.trim()) throw new HttpError(422, "missing_name", "Supply name or title.");
  const description = row.description ?? row.body_html ?? "";
  if (typeof description !== "string" || description.length > 16000 || name.length > 1000 || imageUrl.length > 4000) {
    throw new HttpError(422, "item_too_large", "Name/image URL/description exceeds its limit.");
  }
  return { objectId, name, description, imageUrl, bboxMeters: row.bboxMeters,
    category: typeof row.category === "string" ? row.category : "unknown",
    measure: row.measure ?? { method: "extracted", confidence: 0 },
    merchant: row.merchant ?? null, productUrl: row.productUrl ?? null,
    price: row.price?.cents != null ? row.price : null };
}

export async function enqueueCatalogItem(env: Env, item: CatalogItem, apiOrigin: string) {
  // A repeated scrape cannot start another paid inference for the same input.
  const jobId = await stableId([item.objectId, item.imageUrl, item.bboxMeters]);
  const existing = await env.DB.prepare("SELECT id FROM objects WHERE id = ?").bind(item.objectId).first();
  if (!existing) await insertObject(env, { ...item, source: "catalog", state: "measured", createdAt: new Date().toISOString() });
  await enqueueMesh(env, { jobId, objectId: item.objectId, tier: "live", apiOrigin, roomId: null, catalog: item });
  return { objectId: item.objectId, jobId };
}

export async function postCatalogIngest(req: Request, env: Env, origin: string): Promise<Response> {
  if (!env.UPSTREAM_TOKEN || req.headers.get("x-upstream-token") !== env.UPSTREAM_TOKEN) {
    throw new HttpError(401, "unauthorized", "A valid X-Upstream-Token is required.");
  }
  const body = await readJson<any>(req);
  const rows = Array.isArray(body) ? body : body.products ?? body.objects ?? body.items;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw new HttpError(422, "bad_batch", "Supply 1-100 items as an array, or {products}, {objects}, or {items}.");
  }
  const items = await Promise.all(rows.map(normalizeCatalogItem));
  const jobs = [];
  for (const item of items) jobs.push(await enqueueCatalogItem(env, item, origin));
  return json({ accepted: jobs.length, jobs }, 202);
}
