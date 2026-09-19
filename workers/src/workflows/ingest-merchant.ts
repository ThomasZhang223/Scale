// Paul's catalog ingest pipeline, orchestrated as a Cloudflare Workflow.
//
// P3 in BUILD_DOC.md. The five steps of EXTRACTION.md live in services/ingest, on the laptop
// behind a quick tunnel (infra/README.md lists it at :8003 as "crawl + extract"); this
// Workflow owns the things Workers are actually better at — durability, per-step retries and
// the D1 write — and calls that service for the extraction itself, exactly as /v1/fit and
// /v1/search call theirs.
//
// It used to reimplement the pipeline here in TypeScript: its own regex, its own LLM pass, its
// own category priors. Two implementations of one thing drift, and this one had never been run
// against a real catalogue, while the Python has measured hit rates on eleven merchants,
// regression tests against real markup, and the Browserbase page pass that recovers the four
// stores whose /products.json carries no dimensions at all. So the duplicate is gone and the
// Python is the single source of truth.
//
// A Workflow rather than a loop in a Worker because a merchant with 200 products is minutes of
// work, a Worker request would time out, and a storefront that rate-limits mid-pull should
// retry that one step rather than restart the merchant.
//
// This workflow writes `state: "measured"` rows only. It never generates a mesh — the pre-bake
// is a separate decision made per product, and it goes through the queue so it cannot exhaust
// the free plan's 100 concurrent Workflow instances.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
// NonRetryableError lives in cloudflare:workflows, not cloudflare:workers.
import { NonRetryableError } from "cloudflare:workflows";
import { callUpstream } from "../lib/config";
import { nowIso } from "../lib/ids";
import { insertObject } from "../lib/store";

export interface IngestMerchantParams {
  merchant: string;
  storefront: string;
  collection: string | null;
}

/** Object v1 as services/ingest returns it (.claude/contracts.md), plus its extraction notes. */
interface ExtractedObject {
  objectId: string;
  source: "catalog";
  state: "measured";
  name: string;
  category: string | null;
  bboxMeters: { w: number; h: number; d: number };
  measure: { method: string; confidence: number };
  price: { cents: number | null; currency: string } | null;
  productUrl: string | null;
  merchant: string | null;
  createdAt: string;
  extraction?: {
    via: "api" | "llm" | "page" | "vlm";
    unverified: boolean;
    flags: string[];
  };
}

interface ExtractResponse {
  count: number;
  objects: ExtractedObject[];
  stats: Record<string, number | string>;
}

const MAX_PRODUCTS = 250;

export class IngestMerchantWorkflow extends WorkflowEntrypoint<Env, IngestMerchantParams> {
  async run(event: Readonly<WorkflowEvent<IngestMerchantParams>>, step: WorkflowStep) {
    const p = event.payload;
    const storefront = p.storefront.replace(/\/+$/, "");

    // A storefront that rate-limits gets three chances, spaced out. It is somebody else's
    // server, and here the polite thing and the reliable thing are the same thing.
    const crawled = await step.do(
      "crawl",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async (): Promise<{ products: unknown[] }> => {
        try {
          const res = await callUpstream<{ products: unknown[] }>(
            this.env,
            "ingest",
            "/crawl",
            { storefront, collection: p.collection, pages: 1 },
            60_000,
          );
          return { products: (res.products ?? []).slice(0, MAX_PRODUCTS) };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          // A merchant that has disabled /products.json, or is not Shopify, is a decision
          // somebody made. Retrying it is useless and impolite. The service says which.
          if (/not_shopify|missing_storefront|422/.test(message)) {
            throw new NonRetryableError(`${storefront}: ${message}`);
          }
          throw cause;
        }
      },
    );

    // Steps 1 through 5 in one call: regex, LLM, rendered page, spec image, validation,
    // confidence. The service decides which passes are configured and reports what it used.
    const extracted = await step.do(
      "extract",
      { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async (): Promise<ExtractResponse> =>
        callUpstream<ExtractResponse>(
          this.env,
          "ingest",
          "/extract",
          {
            merchant: p.merchant,
            storefront,
            products: crawled.products,
            browserbase: true,
            llm: true,
            vlm: false, // the most expensive pass; turn it on per merchant, not by default
          },
          240_000,
        ),
    );

    const written = await step.do("write-objects", async () => {
      const at = nowIso();
      let count = 0;
      for (const o of extracted.objects) {
        await insertObject(this.env, {
          // The service mints the id, so a re-run of this step upserts rather than duplicating.
          objectId: o.objectId,
          source: "catalog",
          state: "measured",
          name: o.name,
          category: o.category ?? "unknown",
          bboxMeters: o.bboxMeters,
          measure: o.measure,
          price: o.price && o.price.cents !== null
            ? { cents: o.price.cents, currency: o.price.currency }
            : null,
          productUrl: o.productUrl,
          merchant: o.merchant ?? p.merchant,
          createdAt: o.createdAt || at,
        });
        count++;
      }
      return { count };
    });

    return {
      merchant: p.merchant,
      pulled: crawled.products.length,
      extracted: extracted.count,
      written: written.count,
      // Which surface each dimension came from, and how many carry low enough confidence to
      // show as "unverified fit" rather than a number.
      stats: extracted.stats,
      unverified: extracted.objects.filter((o: ExtractedObject) => o.extraction?.unverified).length,
    };
  }
}
