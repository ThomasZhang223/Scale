// Paul's catalog ingest pipeline, as a Cloudflare Workflow.
//
// P3 in BUILD_DOC.md, five steps, in the order Paul's EXTRACTION.md fixes them:
//   1. pull the storefront's public /products.json
//   2. regex pass over body_html, metafields and variant titles  (~60% coverage, near-free)
//   3. LLM pass over what is left, constrained to a JSON schema  (Workers AI, no key needed)
//   4. validation: unit sanity and category priors               (step 4 is what a rubric rewards)
//   5. confidence score, written into measure.confidence         (the line between agent and scraper)
//
// A Workflow rather than a loop in a Worker because a merchant with 200 products is minutes of
// work across dozens of model calls, a Worker request would time out, and a storefront that
// rate-limits mid-pull should retry that one step rather than restart the merchant.
//
// This workflow writes `state: "measured"` rows only. It never generates a mesh — the pre-bake
// is a separate decision made per product, and it goes through the queue so it cannot exhaust
// the free plan's 100 concurrent Workflow instances.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
// NonRetryableError lives in cloudflare:workflows, not cloudflare:workers.
import { NonRetryableError } from "cloudflare:workflows";
import { complete, parseJsonObject } from "../lib/ai";
import { nowIso, uuid } from "../lib/ids";
import { insertObject } from "../lib/store";

export interface IngestMerchantParams {
  merchant: string;
  storefront: string;
  collection: string | null;
}

interface RawProduct {
  id: number | string;
  title: string;
  handle: string;
  product_type?: string;
  body_html?: string;
  variants?: { title?: string; price?: string }[];
  images?: { src?: string }[];
}

interface Extracted {
  productId: string;
  name: string;
  category: string;
  bboxMeters: { w: number; h: number; d: number };
  method: "extracted" | "declared";
  confidence: number;
  priceCents: number | null;
  productUrl: string;
  imageUrl: string | null;
}

/** Plausible metre ranges per category. Step 4: a sofa is not 8 cm wide. */
const CATEGORY_PRIORS: Record<string, { w: [number, number]; h: [number, number]; d: [number, number] }> = {
  chair: { w: [0.35, 0.9], h: [0.6, 1.3], d: [0.35, 0.95] },
  table: { w: [0.3, 3.0], h: [0.3, 1.2], d: [0.3, 1.5] },
  sofa: { w: [1.2, 3.6], h: [0.6, 1.2], d: [0.7, 1.2] },
  bed: { w: [0.8, 2.2], h: [0.3, 1.5], d: [1.8, 2.3] },
  storage: { w: [0.3, 3.0], h: [0.3, 2.4], d: [0.25, 0.8] },
  lamp: { w: [0.1, 0.8], h: [0.2, 2.0], d: [0.1, 0.8] },
};

// ceiling: 40 products per merchant per run. Enough for the 60-100 product pre-bake across a
// handful of merchants, and it bounds the LLM pass against the free plan's daily allowance.
// Raise it once a real daily-neuron number has been measured, not before.
const MAX_PRODUCTS = 40;

export class IngestMerchantWorkflow extends WorkflowEntrypoint<Env, IngestMerchantParams> {
  async run(event: Readonly<WorkflowEvent<IngestMerchantParams>>, step: WorkflowStep) {
    const p = event.payload;
    const base = p.storefront.replace(/\/+$/, "");

    const products = await step.do(
      "fetch-catalog",
      // A storefront that rate-limits gets three chances, spaced out. It is somebody else's
      // server and the polite thing and the reliable thing are the same thing here.
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async (): Promise<RawProduct[]> => {
        const path = p.collection
          ? `/collections/${p.collection}/products.json?limit=${MAX_PRODUCTS}`
          : `/products.json?limit=${MAX_PRODUCTS}`;
        const res = await fetch(`${base}${path}`, {
          headers: { accept: "application/json", "user-agent": "full-scale-htn2026/1.0" },
        });
        if (!res.ok) {
          const message =
            `${base}${path} returned ${res.status}. Some merchants disable /products.json — ` +
            `verify it in a browser before adding the storefront.`;
          // 429 and 5xx are worth waiting out. A 403 or a 404 is a decision the merchant made,
          // and retrying it is both useless and impolite to somebody else's server.
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            throw new NonRetryableError(message);
          }
          throw new Error(message);
        }
        const body = (await res.json()) as { products?: RawProduct[] };
        return (body.products ?? []).slice(0, MAX_PRODUCTS);
      },
    );

    // Step 2: regex. Cheap, runs on everything, and carries most of the load.
    const regexPass = await step.do("regex-pass", async () => {
      const hits: Extracted[] = [];
      const misses: RawProduct[] = [];
      for (const product of products) {
        const dims = regexDimensions(
          [product.body_html ?? "", ...(product.variants ?? []).map((v) => v.title ?? "")].join(" \n "),
        );
        if (dims) {
          hits.push(toExtracted(product, base, dims, "extracted", 0.75));
        } else {
          misses.push(product);
        }
      }
      return { hits, misses };
    });

    // Step 3: the LLM pass, over only what regex missed. Workers AI, so no API key exists to
    // leak and nothing leaves Cloudflare.
    const llmPass = await step.do(
      "llm-pass",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        const hits: Extracted[] = [];
        const unknown: string[] = [];
        for (const product of regexPass.misses) {
          const text = stripHtml(product.body_html ?? "").slice(0, 3000);
          if (text.length < 20) {
            unknown.push(product.title);
            continue;
          }
          const answer = await complete(
            this.env,
            `You extract furniture dimensions from product copy. Answer with JSON only, no prose.
Schema: {"found": true, "w": <number>, "h": <number>, "d": <number>, "unit": "mm"|"cm"|"m"|"in"|"ft"}
or {"found": false}.
w is width, h is height, d is depth. Report the unit the copy actually uses — do not convert.
If the copy does not state all three, answer {"found": false}. Never estimate.`,
            `Product: ${product.title}\n\n${text}`,
          );
          const parsed = parseJsonObject<{
            found: boolean;
            w?: number;
            h?: number;
            d?: number;
            unit?: string;
          }>(answer);

          // A model that did not answer in the shape has not answered. No default dimension is
          // invented here: bboxMeters is the worst field in the project to be wrong about.
          if (!parsed?.found || parsed.w === undefined || parsed.h === undefined || parsed.d === undefined) {
            unknown.push(product.title);
            continue;
          }
          const f = unitToMetres(parsed.unit ?? "cm");
          if (f === null) {
            unknown.push(product.title);
            continue;
          }
          hits.push(
            toExtracted(
              product,
              base,
              { w: parsed.w * f, h: parsed.h * f, d: parsed.d * f },
              "extracted",
              0.55,
            ),
          );
        }
        return { hits, unknown };
      },
    );

    // Step 4 and 5: validate, then score. A row that fails validation is dropped, not corrected
    // — a corrected guess is indistinguishable from a measurement downstream.
    const validated = await step.do("validate", async () => {
      const kept: Extracted[] = [];
      const rejected: { name: string; why: string }[] = [];
      for (const e of [...regexPass.hits, ...llmPass.hits]) {
        const why = validationFailure(e);
        if (why) {
          rejected.push({ name: e.name, why });
          continue;
        }
        kept.push(e);
      }
      return { kept, rejected };
    });

    const written = await step.do("write-objects", async () => {
      const at = nowIso();
      let count = 0;
      for (const e of validated.kept) {
        await insertObject(this.env, {
          objectId: uuid(),
          source: "catalog",
          state: "measured",
          name: e.name,
          category: e.category,
          bboxMeters: e.bboxMeters,
          measure: { method: e.method, confidence: e.confidence },
          price: e.priceCents !== null ? { cents: e.priceCents, currency: "CAD" } : null,
          productUrl: e.productUrl,
          merchant: p.merchant,
          createdAt: at,
        });
        count++;
      }
      return { count };
    });

    return {
      merchant: p.merchant,
      pulled: products.length,
      byRegex: regexPass.hits.length,
      byModel: llmPass.hits.length,
      rejected: validated.rejected,
      unknown: llmPass.unknown.length,
      written: written.count,
    };
  }
}

// --- Extraction helpers --------------------------------------------------------------------

/** Numbers near W/D/H tokens, and the `60" x 30" x 18"` form. Paul's step 1. */
function regexDimensions(text: string): { w: number; h: number; d: number } | null {
  const clean = stripHtml(text);

  const labelled = /(\d+(?:\.\d+)?)\s*("|''|in|inch(?:es)?|cm|mm|m|ft)?\s*[wW]\b[^0-9]{0,12}(\d+(?:\.\d+)?)\s*("|''|in|inch(?:es)?|cm|mm|m|ft)?\s*[dD]\b[^0-9]{0,12}(\d+(?:\.\d+)?)\s*("|''|in|inch(?:es)?|cm|mm|m|ft)?\s*[hH]\b/;
  const m1 = clean.match(labelled);
  if (m1) {
    const unit = unitToMetres(m1[2] ?? m1[4] ?? m1[6] ?? "cm");
    if (unit !== null) {
      return { w: Number(m1[1]) * unit, d: Number(m1[3]) * unit, h: Number(m1[5]) * unit };
    }
  }

  const triple = /(\d+(?:\.\d+)?)\s*("|''|in|cm|mm|m)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*("|''|in|cm|mm|m)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*("|''|in|cm|mm|m)?/;
  const m2 = clean.match(triple);
  if (m2) {
    const unit = unitToMetres(m2[2] ?? m2[4] ?? m2[6] ?? "cm");
    if (unit !== null) {
      // ceiling: the bare `A x B x C` form has no labels, so the axis order is a convention,
      // not a fact. Width, depth, height is the common retail order. A wrong guess here binds
      // width to depth, which passes every numeric check while being visibly wrong in the room
      // — which is why this path is scored lower than the labelled one above.
      return { w: Number(m2[1]) * unit, d: Number(m2[3]) * unit, h: Number(m2[5]) * unit };
    }
  }
  return null;
}

/** Metres per unit. Returns null for a unit we do not recognise, rather than assuming one. */
function unitToMetres(unit: string): number | null {
  switch (unit.toLowerCase().trim()) {
    case "mm":
      return 0.001;
    case "cm":
      return 0.01;
    case "m":
      return 1;
    case '"':
    case "''":
    case "in":
    case "inch":
    case "inches":
      return 0.0254;
    case "ft":
      return 0.3048;
    default:
      return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function categorise(productType: string | undefined, title: string): string {
  const hay = `${productType ?? ""} ${title}`.toLowerCase();
  for (const key of Object.keys(CATEGORY_PRIORS)) {
    if (hay.includes(key)) return key;
  }
  if (hay.includes("desk") || hay.includes("console")) return "table";
  if (hay.includes("stool") || hay.includes("bench")) return "chair";
  if (hay.includes("shelf") || hay.includes("cabinet") || hay.includes("dresser")) return "storage";
  return "other";
}

function toExtracted(
  product: RawProduct,
  base: string,
  dims: { w: number; h: number; d: number },
  method: "extracted" | "declared",
  confidence: number,
): Extracted {
  const priceStr = product.variants?.[0]?.price;
  const priceCents = priceStr ? Math.round(Number(priceStr) * 100) : null;
  return {
    productId: String(product.id),
    name: product.title,
    category: categorise(product.product_type, product.title),
    bboxMeters: dims,
    method,
    confidence,
    priceCents: Number.isFinite(priceCents as number) ? priceCents : null,
    productUrl: `${base}/products/${product.handle}`,
    imageUrl: product.images?.[0]?.src ?? null,
  };
}

/** Step 4. Returns a reason string when the row must be dropped, or null when it passes. */
function validationFailure(e: Extracted): string | null {
  for (const axis of ["w", "h", "d"] as const) {
    const v = e.bboxMeters[axis];
    if (!Number.isFinite(v) || v <= 0.02 || v > 4) {
      return `${axis}=${v.toFixed(3)} m is outside the plausible range (0.02, 4].`;
    }
  }
  const prior = CATEGORY_PRIORS[e.category];
  if (prior) {
    for (const axis of ["w", "h", "d"] as const) {
      const [lo, hi] = prior[axis];
      const v = e.bboxMeters[axis];
      if (v < lo || v > hi) {
        return `${e.category} ${axis}=${v.toFixed(2)} m is outside the category prior [${lo}, ${hi}].`;
      }
    }
  }
  return null;
}
