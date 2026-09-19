# Ranking — the one rule that matters

**Style and fit are two halves of the query and they must never be mixed.**

- **Style** is a dense vector similarity search over CLIP ViT-L/14 768-dimension embeddings
  (Vectorize index `objects-v1`, cosine metric).
- **Fit** is an integer range filter on the `w_mm`, `h_mm`, `d_mm` metadata fields on that same
  index — never a vector term.

Expressing fit as a vector term returns results that look right and do not fit. That is exactly
the failure this whole product exists to prevent — Kreativ already does dimensional accuracy, this
pipeline's differentiator is retrieval that actually respects it.

Target query, verbatim from the pitch: *"find something that fits the 80 cm gap beside my desk
and matches its wood tone."* "Fits the 80 cm gap" is the range filter. "Matches its wood tone" is
the vector similarity (and/or `dominant_hex` proximity). They compose by intersecting: style
similarity ranks within the set that already passes the fit filter, not the other way around.

`fit` in the request body is `{ maxW, maxH, maxD }` — a numeric filter, not a vector term
(`.claude/contracts.md`).

## Fallback rule

**Never return an empty result set on stage.** If the fit filter returns nothing, relax it by 10%
and label the results as `"relaxed"`. An empty screen is worse than a slightly-off result.
