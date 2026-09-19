# The extraction pipeline

Five steps, run in order, over each merchant's product data. Every step is worth stating on its
own because no single step is trustworthy alone — the pipeline's value is in step 4 and 5, not in
any one extraction technique.

1. **Regex pass** — numeric patterns adjacent to width/depth/height/W/D/H tokens (`body_html`,
   metafields, variant titles). Catches **~60%** of products for almost no cost.

2. **LLM pass** — over whatever text remains after step 1, with a strict JSON schema
   (dimensions + unit, or explicit "not found"). Picks up what regex cannot shape-match:
   *"measures just under five feet across and stands waist-high"*. It may not convert and it may
   not infer from the category — "a dining chair is about 45 cm" is the invented number this
   pipeline exists to avoid — and an answer with no stated unit is refused, because a bare
   `60 x 30` could be inches or centimetres and the difference is a metre.

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

3. **VLM pass** — the spec-sheet image: a diagram with measurement arrows and callouts, which
   for some merchants is the only place the numbers exist. Runs only on what every cheaper
   source failed, tries the second through fourth images (a spec diagram is rarely the hero
   shot), and answers "not found" on a lifestyle photo rather than estimating from it.
   Last resort before "unknown."

4. **Validation** — the step that is genuine multi-source resolution, not a scrape:
   - Unit sanity: a sofa is not 8 cm wide.
   - Category priors: a dining chair is 40–50 cm.
   - Cross-check: claimed width-to-height ratio against the product photo's aspect ratio.

5. **Confidence score** — the difference between an agent and a scraper. Low confidence surfaces
   in the UI as **"unverified fit,"** never a silent guess. Feeds `measure.confidence` on
   `Object v1` (`measure.method: "extracted"`).

Every length produced by any step is converted to metres before it reaches `Object v1`
(`bboxMeters`) — never downstream.

Steps 2 and 3 call OpenAI over raw HTTP, matching `services/agent/src/pipeline/planner.ts`:
same `OPENAI_API_KEY` / `OPENAI_MODEL`, same optional Cloudflare AI Gateway, same strict
`json_schema`. No SDK. Both are **additive** — they run only over products the cheaper steps
already failed on — so an unconfigured key skips them and the response says so, unlike step 2.5
whose absence would look like a merchant having no dimensions.

Every source, model or regex, hands its answer to step 4 identically. A model is a less
trustworthy reader than a regex, not a more trustworthy one.

Page content is untrusted remote input. No step treats it as instructions, and the LLM and VLM
passes stay on a constrained output schema: a product description is somewhere a stranger can
write "ignore previous instructions".
