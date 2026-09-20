// Product photos for catalog rows. Object v1 carries no image field yet, so the phone finds
// the photo itself, two ways, both real sources and neither guessed:
//   1. The ingest manifest (services/ingest/prebake/manifest.json), bundled as a productUrl →
//      Shopify CDN image map. Covers the curated catalogue.
//   2. Shopify's public product JSON: `${productUrl}.json` names the product's own images.
//      Covers listings that arrived after the manifest (the live find → SF3D path).
// Results are cached in memory for the session. ceiling: when the Worker adds `imageUrl`
// to Object v1 (Thomas + Paul), this file becomes a one-line fallback.
import manifest from "./catalogImages.json";

const MANIFEST = manifest as Record<string, string>;
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function sized(url: string, width: number): string {
  // Shopify CDN honours a width query on product images; other hosts ignore it harmlessly.
  if (!/cdn\.shopify\.com/.test(url)) return url;
  return url.includes("?") ? `${url}&width=${width}` : `${url}?width=${width}`;
}

export function catalogImageSync(productUrl: string | null | undefined, width = 400): string | null {
  if (!productUrl) return null;
  const hit = MANIFEST[productUrl];
  if (hit) return sized(hit, width);
  const cached = cache.get(productUrl);
  return cached ? sized(cached, width) : null;
}

/** Resolves the product photo, asking Shopify once per URL. Null when there is none. */
export async function catalogImage(productUrl: string | null | undefined, width = 400): Promise<string | null> {
  const known = catalogImageSync(productUrl, width);
  if (known || !productUrl) return known;
  if (cache.has(productUrl)) return null;
  let p = pending.get(productUrl);
  if (!p) {
    p = (async () => {
      try {
        if (!/^https?:\/\/[^/]+\/products\/[^/?#]+/.test(productUrl)) return null;
        const res = await fetch(`${productUrl.replace(/[?#].*$/, "")}.json`);
        if (!res.ok) return null;
        const body = (await res.json()) as { product?: { images?: { src?: string }[]; image?: { src?: string } } };
        const src = body.product?.images?.[0]?.src ?? body.product?.image?.src ?? null;
        cache.set(productUrl, src);
        return src;
      } catch {
        cache.set(productUrl, null);
        return null;
      } finally {
        pending.delete(productUrl);
      }
    })();
    pending.set(productUrl, p);
  }
  const src = await p;
  return src ? sized(src, width) : null;
}

/** "Poly___Bark" → "Poly & Bark", "InStyle_Home__CA" → "InStyle Home, CA". The slug is the ingest's. */
export function merchantName(slug: string | null | undefined): string {
  if (!slug) return "Unlabelled";
  return slug.replace(/___/g, " & ").replace(/__/g, ", ").replace(/_/g, " ").trim();
}
