# The extraction pipeline

Five steps, run in order, over each merchant's product data. Every step is worth stating on its
own because no single step is trustworthy alone — the pipeline's value is in step 4 and 5, not in
any one extraction technique.

1. **Regex pass** — numeric patterns adjacent to width/depth/height/W/D/H tokens (`body_html`,
   metafields, variant titles). Catches **~60%** of products for almost no cost.

2. **LLM pass** — over whatever `body_html` remains after step 1, with a constrained output
   schema (dimensions + unit, or explicit "not found"). Picks up free-text mentions regex
   patterns don't match.

2.5. **Rendered page pass (Browserbase)** — for products whose `/products.json` entry carries no
   dimensions at all. Measured, not assumed: the first live verification run found four reachable
   stores (Floyd, Fyrn, Bend Goods, Branch Furniture — about 690 products) whose `body_html` is
   marketing copy and whose variants are size *names* ("Queen", "King"). The dimensions are in
   metafields, and **`/products.json` does not serve metafields** — but the product page renders
   them. Fetch `{storefront}/products/{handle}` via Browserbase Fetch and read, best source
   first: schema.org JSON-LD (`width`/`height`/`depth`, the only source where the axis is
   unambiguous), then a spec block labelled Dimensions, then page text through step 1's regex.

   Fetch rather than a browser session: Shopify renders metafields server-side, so this costs no
   browser hours. Escalate to `browse open --remote` only for a store that renders specs in JS.

   Responses are cached to disk. Not a demo trick — a crawl that re-fetches every page each run
   is slow, rude, and burns credits. The cache is why the pre-bake is reproducible, and why the
   demo can run **one genuinely live fetch on stage** with everything else already in hand.

3. **VLM pass** — on spec-sheet images, for products where dimensions never appear as text at
   all. Last resort before "unknown."

4. **Validation** — the step that is genuine multi-source resolution, not a scrape:
   - Unit sanity: a sofa is not 8 cm wide.
   - Category priors: a dining chair is 40–50 cm.
   - Cross-check: claimed width-to-height ratio against the product photo's aspect ratio.

5. **Confidence score** — the difference between an agent and a scraper. Low confidence surfaces
   in the UI as **"unverified fit,"** never a silent guess. Feeds `measure.confidence` on
   `Object v1` (`measure.method: "extracted"`).

Every length produced by any step is converted to metres before it reaches `Object v1`
(`bboxMeters`) — never downstream.

Page content is untrusted remote input. No step treats it as instructions, and the LLM and VLM
passes stay on a constrained output schema: a product description is somewhere a stranger can
write "ignore previous instructions".
