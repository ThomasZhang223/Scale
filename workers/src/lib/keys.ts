// The R2 key layout, and the single key -> URL conversion.
//
// .claude/contracts.md: "Key in the database, URL in the API." D1 stores `glb_key`. The API
// returns `glbUrl`. They are different things with different lifetimes, which is why they have
// different names, and why the conversion happens here, in one function, once.
//
// Justin never resolves a key and never builds a URL. Ani writes to a key and reports the key.

export const R2Keys = {
  roomCapture: (roomId: string) => `rooms/${roomId}/capture.json`,
  objectFrame: (objectId: string, n: number) => `objects/${objectId}/frames/${n}.jpg`,
  objectMesh: (objectId: string) => `objects/${objectId}/mesh.glb`,
  objectThumb: (objectId: string) => `objects/${objectId}/thumb.jpg`,
  catalogSource: (merchant: string, productId: string) =>
    `catalog/${merchant}/${productId}/source.jpg`,
} as const;

/** Upload kinds the client may ask for, mapped to the key layout above. */
export type UploadKind = "roomCapture" | "objectFrame" | "objectMesh" | "objectThumb" | "catalogSource";

/**
 * The one conversion. An R2 key becomes a URL the client can GET directly.
 *
 * The bucket is deliberately NOT public. r2.dev is rate-limited and documented as development
 * only, and a custom domain needs a domain on Cloudflare, which this account does not have.
 * Serving through the Worker also puts CORS under our control, which a public bucket does not
 * without a separate CORS policy — and three.js GLTFLoader fetching a GLB cross-origin fails
 * with no useful error when CORS is missing.
 *
 * `origin` comes from the incoming request, so this is correct in `wrangler dev` on a laptop
 * and on workers.dev with no configuration to keep in sync.
 */
export function assetUrl(origin: string, key: string): string {
  return `${origin}/v1/assets/${key}`;
}

/** The inverse, used by GET /v1/assets/*. Returns null when the path is not an asset path. */
export function keyFromAssetPath(pathname: string): string | null {
  const prefix = "/v1/assets/";
  if (!pathname.startsWith(prefix)) return null;
  const key = decodeURIComponent(pathname.slice(prefix.length));
  // Reject traversal and empty keys rather than letting them reach R2.
  if (key.length === 0 || key.includes("..")) return null;
  return key;
}

/** Content type for the small set of things this backend actually stores. */
export function contentTypeFor(key: string): string {
  if (key.endsWith(".glb")) return "model/gltf-binary";
  if (key.endsWith(".usdz")) return "model/vnd.usdz+zip";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
