import { fitsNeed, type Need } from './listings.ts';
import type { ShopifyCandidate } from '../../../workers/src/lib/shopify.ts';

export type Assessment = { status: 'FITS' | "DOESN’T FIT" | 'SIZE UNVERIFIED' | 'SET SPACE'; reasons: string[] };
const cm = (m: number) => m > 0 && m < .001 ? '<0.1 cm' : `${Number((m * 100).toFixed(1))} cm`;
/** Existing XR fit predicate, unchanged. This certifies only the entered gap, not doorways,
 * walkways, arbitrary rotations, or a particular position inside the scanned room. */
export function assessShopify(c: ShopifyCandidate, need: Need): Assessment {
  if (!c.dimensions) return { status: 'SIZE UNVERIFIED', reasons: ['No verified dimensions for this exact merchant variant.'] };
  const bounds = [['w', 'maxW', 'width', 'too wide'], ['h', 'maxH', 'height', 'too tall'], ['d', 'maxD', 'depth', 'too deep']] as const;
  const set = bounds.filter(([, key]) => need[key] != null);
  if (!set.length || set.some(([, key]) => !Number.isFinite(need[key]) || need[key]! <= 0 || need[key]! > 20)) return { status: 'SET SPACE', reasons: ['Enter the available space to check fit.'] };
  const box = c.dimensions.bboxMeters;
  if (![box.w, box.h, box.d].every(n => Number.isFinite(n) && n > 0)) return { status: 'SIZE UNVERIFIED', reasons: ['Invalid dimension evidence.'] };
  const fits = fitsNeed(box, need);
  return {
    status: fits ? 'FITS' : 'DOESN’T FIT',
    reasons: set.filter(([axis, key]) => fits || box[axis] > need[key]!).map(([axis, key, label, fail]) => fits ? `${cm(need[key]! - box[axis])} ${label} clearance` : `${cm(box[axis] - need[key]!)} ${fail}`),
  };
}
export function commerceAction(c: ShopifyCandidate): { label: string; href: string } {
  return c.checkoutUrl && c.available === true ? { label: 'Buy on Shopify', href: c.checkoutUrl } : { label: 'View on Shopify', href: c.productUrl };
}
export function previewUrl(c: ShopifyCandidate, base: string, stub: boolean): string | null {
  if (stub || !c.dimensions || !c.previewObjectId) return null;
  const url = new URL(base); url.searchParams.set('object', c.previewObjectId); return url.href;
}
/** Pick the smallest physical miss for the comparison; do not change Shopify relevance order. */
export function closestSizeMiss(candidates: ShopifyCandidate[], need: Need): ShopifyCandidate | undefined {
  const overshoot = (c: ShopifyCandidate) => Math.max(0,
    c.dimensions!.bboxMeters.w - (need.maxW ?? Infinity),
    c.dimensions!.bboxMeters.h - (need.maxH ?? Infinity),
    c.dimensions!.bboxMeters.d - (need.maxD ?? Infinity));
  return candidates.filter(c => assessShopify(c, need).status === 'DOESN’T FIT').sort((a, b) => overshoot(a) - overshoot(b))[0];
}
/** Shopify amount is minor currency units, not always cents (e.g. JPY). */
export function formatPrice(c: ShopifyCandidate): string {
  if (!c.price) return 'Price unavailable';
  try {
    const formatter = new Intl.NumberFormat('en-CA', { style: 'currency', currency: c.price.currency, currencyDisplay: 'code' });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(c.price.amount / 10 ** digits);
  } catch { return `${c.price.amount} minor units ${c.price.currency}`; }
}
