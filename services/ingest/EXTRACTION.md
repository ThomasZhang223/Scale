# The extraction pipeline

Five steps, run in order, over each merchant's product data. Every step is worth stating on its
own because no single step is trustworthy alone — the pipeline's value is in step 4 and 5, not in
any one extraction technique.

1. **Regex pass** — numeric patterns adjacent to width/depth/height/W/D/H tokens (`body_html`,
   metafields, variant titles). Catches **~60%** of products for almost no cost.

2. **LLM pass** — over whatever `body_html` remains after step 1, with a constrained output
   schema (dimensions + unit, or explicit "not found"). Picks up free-text mentions regex
   patterns don't match.

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
