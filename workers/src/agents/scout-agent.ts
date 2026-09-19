// One ScoutAgent per search session. This is the merchant retrieval agent: it decides which
// merchants are worth pulling, starts the ingest pipeline for the ones it has not seen, waits
// for the catalog to land, and then answers the user's actual question over it.
//
// What makes it an agent rather than a scraper is the `merchants` table below. It remembers
// which storefronts it has already ingested and how many products each one yielded, so the
// second question in a session skips work the first one did — and so a storefront that
// answered nothing useful is not tried again.
//
// Paul owns the ranking inside POST /v1/search and the extraction rules inside the ingest
// workflow. This class owns neither. It owns the decision of what to fetch and when.

import { Agent } from "agents";
import { runToolLoop, type ToolDef } from "../lib/ai";
import { nowIso, uuid } from "../lib/ids";
import type { ObjectV1 } from "../lib/contracts";

export interface ScoutAgentState {
  lastQuery: string | null;
  merchantsKnown: number;
  productsIngested: number;
}

interface MerchantRow {
  name: string;
  storefront: string;
  ingested_at: string | null;
  product_count: number;
  note: string | null;
}

const SYSTEM_PROMPT = `You find real furniture that fits a real, measured space.

Every object you can return carries measured dimensions in metres. That is the point: a result
that looks right but does not fit is the exact failure this product exists to prevent. Always
pass the caller's dimension limits to search_objects — never filter by eye afterwards.

Work in this order:
1. list_merchants to see which storefronts are already ingested, and which are not.
2. search_objects over what is already indexed. If that answers the question, stop.
3. Only if the results are thin, ingest_merchant on a storefront that has not been pulled yet,
   then search again. Ingesting is slow; do it at most twice per question.
4. read_listing only for a specific product page that is not on an ingested storefront.

Never invent a dimension or a price. If a product's size is unknown, say it is unverified.
All lengths are metres. All money is integer cents.`;

const TOOLS: ToolDef[] = [
  {
    name: "list_merchants",
    description: "List the storefronts this session knows about and whether each is ingested.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_objects",
    description:
      "Search the indexed catalog and the user's own scanned possessions by style and by " +
      "measured fit. The fit filter is a hard numeric filter, not a preference.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Style, material and category description" },
        maxW: { type: "number", description: "Maximum width in METRES" },
        maxH: { type: "number", description: "Maximum height in METRES" },
        maxD: { type: "number", description: "Maximum depth in METRES" },
        maxPriceCents: { type: "number", description: "Maximum price in integer cents" },
        source: {
          type: "string",
          enum: ["scan", "catalog"],
          description: "Restrict to the user's own possessions, or to merchant catalog",
        },
        limit: { type: "number", description: "How many results, default 8" },
      },
      required: ["text"],
    },
  },
  {
    name: "ingest_merchant",
    description:
      "Pull a Shopify storefront's public catalog and extract dimensions from it. Slow — " +
      "tens of seconds. Returns immediately with a run id; the results appear in later " +
      "search_objects calls.",
    parameters: {
      type: "object",
      properties: {
        storefront: {
          type: "string",
          description: "Storefront base URL, e.g. https://example-furniture.com",
        },
        name: { type: "string", description: "Short merchant name used as the R2 key prefix" },
        collection: {
          type: "string",
          description: "Optional collection handle, e.g. 'side-tables', to narrow the pull",
        },
      },
      required: ["storefront", "name"],
    },
  },
  {
    name: "read_listing",
    description:
      "Render one product page in a real browser and return it as markdown. Use for a listing " +
      "that is not on a Shopify storefront and so has no catalog endpoint.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The product page URL" } },
      required: ["url"],
    },
  },
];

export class ScoutAgent extends Agent<Env, ScoutAgentState> {
  initialState: ScoutAgentState = { lastQuery: null, merchantsKnown: 0, productsIngested: 0 };

  async onStart(): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS merchants (
      name TEXT PRIMARY KEY,
      storefront TEXT NOT NULL,
      ingested_at TEXT,
      product_count INTEGER NOT NULL DEFAULT 0,
      note TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      query TEXT NOT NULL,
      answer TEXT
    )`;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").filter(Boolean).pop();

    switch (action) {
      case "scout":
        return this.handleScout(request, url.origin);
      case "seed":
        return this.handleSeed(request);
      case "memory":
        return Response.json({
          state: this.state,
          merchants: this.sql<MerchantRow>`SELECT * FROM merchants ORDER BY name`,
          runs: this.sql`SELECT id, at, query FROM runs ORDER BY at DESC LIMIT 20`,
        });
      default:
        return Response.json({ error: "unknown_agent_action", action }, { status: 404 });
    }
  }

  /**
   * Seed the merchant list. Paul's verified storefronts are the input to this agent, not
   * something it can discover: contracts and terms of service decide which storefronts are
   * fair game, and that is a human decision.
   */
  private async handleSeed(request: Request): Promise<Response> {
    const body = (await request.json()) as { merchants: { name: string; storefront: string }[] };
    for (const m of body.merchants ?? []) {
      this.sql`INSERT INTO merchants (name, storefront, ingested_at, product_count, note)
        VALUES (${m.name}, ${m.storefront}, NULL, 0, NULL)
        ON CONFLICT(name) DO UPDATE SET storefront = excluded.storefront`;
    }
    const known = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM merchants`;
    this.setState({ ...this.state, merchantsKnown: known[0]?.n ?? 0 });
    return Response.json({ merchantsKnown: this.state.merchantsKnown });
  }

  private async handleScout(request: Request, origin: string): Promise<Response> {
    const body = (await request.json()) as { query: string };
    if (!body.query) return Response.json({ error: "query_required" }, { status: 400 });

    this.setState({ ...this.state, lastQuery: body.query });

    const result = await runToolLoop(this.env, {
      system: SYSTEM_PROMPT,
      user: body.query,
      tools: TOOLS,
      maxTurns: 8,
      invoke: async (name, args) => {
        switch (name) {
          case "list_merchants":
            return this.sql<MerchantRow>`SELECT name, storefront, ingested_at, product_count
              FROM merchants ORDER BY ingested_at IS NULL DESC, name`;
          case "search_objects":
            return await this.toolSearch(args, origin);
          case "ingest_merchant":
            return await this.toolIngest(args);
          case "read_listing":
            return await this.toolReadListing(args);
          default:
            throw new Error(`No tool named ${name}.`);
        }
      },
    });

    const runId = uuid();
    this.sql`INSERT INTO runs (id, at, query, answer)
      VALUES (${runId}, ${nowIso()}, ${body.query}, ${result.text.slice(0, 2000)})`;

    return Response.json({
      runId,
      answer: result.text,
      toolCalls: result.calls.map((c) => ({ name: c.name, arguments: c.arguments })),
    });
  }

  private async toolSearch(args: Record<string, unknown>, origin: string): Promise<unknown> {
    const res = await fetch(`${origin}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: args.text,
        fit: { maxW: args.maxW ?? null, maxH: args.maxH ?? null, maxD: args.maxD ?? null },
        maxPriceCents: args.maxPriceCents ?? null,
        source: args.source ?? null,
        limit: args.limit ?? 8,
      }),
    });
    if (!res.ok) throw new Error(`search returned ${res.status}`);
    const hits = (await res.json()) as { objectId: string; score: number; object: ObjectV1 }[];
    return hits.map((h) => ({
      objectId: h.objectId,
      name: h.object.name,
      category: h.object.category,
      bboxMeters: h.object.bboxMeters,
      measureConfidence: h.object.measure.confidence,
      priceCents: h.object.price?.cents ?? null,
      merchant: h.object.merchant,
      productUrl: h.object.productUrl,
      score: Number(h.score.toFixed(3)),
    }));
  }

  private async toolIngest(args: Record<string, unknown>): Promise<unknown> {
    const name = String(args.name ?? "");
    const storefront = String(args.storefront ?? "");
    if (!name || !storefront) throw new Error("ingest_merchant needs both name and storefront.");

    const already = this.sql<MerchantRow>`SELECT * FROM merchants WHERE name = ${name}`;
    if (already[0]?.ingested_at) {
      return {
        skipped: true,
        reason: `${name} was already ingested at ${already[0].ingested_at} with ${already[0].product_count} products.`,
      };
    }

    const instance = await this.env.INGEST_MERCHANT.create({
      params: {
        merchant: name,
        storefront,
        collection: (args.collection as string | undefined) ?? null,
      },
    });

    this.sql`INSERT INTO merchants (name, storefront, ingested_at, product_count, note)
      VALUES (${name}, ${storefront}, ${nowIso()}, 0, ${`workflow ${instance.id}`})
      ON CONFLICT(name) DO UPDATE SET ingested_at = excluded.ingested_at, note = excluded.note`;

    const known = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM merchants`;
    this.setState({ ...this.state, merchantsKnown: known[0]?.n ?? 0 });

    return {
      started: true,
      workflowId: instance.id,
      note: "Ingest runs in the background. Call search_objects again in a few seconds.",
    };
  }

  /**
   * Render a page in a real browser.
   *
   * Browser Run rather than a plain fetch because the listings that need this are exactly the
   * ones with no catalog endpoint, and those are client-rendered — a plain fetch returns an
   * empty shell. Markdown rather than HTML because the model reads it and HTML would spend
   * the context window on class attributes.
   */
  private async toolReadListing(args: Record<string, unknown>): Promise<unknown> {
    const url = String(args.url ?? "");
    if (!url.startsWith("https://")) throw new Error("read_listing needs an https URL.");
    const res = await this.env.BROWSER.quickAction("markdown", { url });
    if (!res.ok) throw new Error(`Browser Run returned ${res.status} for ${url}`);
    const markdown = await res.text();
    // ceiling: 12 KB is about all a product page needs and keeps one tool result from
    // crowding out the rest of the conversation. A spec table below that point is lost.
    return { url, markdown: markdown.slice(0, 12_000) };
  }
}
