# services/search

**Owner:** Paul
**Scope:** Hybrid retrieval and ranking that runs behind `POST /search` (Component F, pipeline
P4). Given a style query and a fit filter, returns catalog and scan objects that both look right
and actually fit.

## Split ownership

`POST /search` is one endpoint with three owners, stated once in `.claude/contracts.md`:

- **Thomas** owns the HTTP route itself in the Worker — the wire contract, request/response
  shape, base `/v1` surface.
- **Ani** writes the rows this service reads: embeddings and metadata into the Vectorize index
  `objects-v1`.
- **Paul** (this service) owns the ranking logic that runs behind the route — combining the style
  vector search and the fit range filter into results.

## How this runs

This is a **standalone HTTP service in Docker**. Thomas's Worker proxies `POST /search` to it
verbatim — this service is stateless and receives everything it needs in the request body, so its
internal HTTP contract is identical to the public one documented in `.claude/contracts.md`
(`{ text?, imageKey?, fit?, source?, limit }` in, `[{ objectId, score, object }]` out).

```
docker build -t search .
docker run --rm -p 8082:8080 search
```

Or locally:

```
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8082
```

## What is implemented

| File | Holds |
| --- | --- |
| `app/ranking.py` | The whole rule. Fit filter, relaxed fallback, colour distance, score blending. Pure functions, no I/O. |
| `app/index.py` | Where candidates come from. `BruteForceIndex` runs today; `VectorizeIndex` is the adapter for Ani's rows at H14. |
| `app/main.py` | The HTTP route, matching `.claude/contracts.md` exactly. |

```
pip install -r requirements.txt
python3 tests/test_ranking.py     # 22 tests, the rule and the maths
python3 tests/test_api.py         # 15 tests, the wire contract
uvicorn app.main:app --reload --port 8082
```

### How the two halves compose

`fit` filters first and decides membership; style only ranks what survives. The test that
matters is `test_a_perfect_style_match_that_does_not_fit_is_excluded` — an oak shelf that is
110 cm wide must never appear for an 80 cm gap, however well it matches the tone.

Style is blended from three signals, weights in `ranking.py`:

- **cosine** (0.70) over Ani's CLIP embeddings — the query proper
- **colour** (0.30) — CIELAB ΔE76, not RGB distance, because wood tones are all brownish and
  RGB cannot separate them
- **confidence** (0.05) — a tiebreaker only. Between two equal matches, prefer the one whose
  dimensions were measured rather than extracted. This is the product's honesty thesis, and it
  is deliberately too small to reorder genuinely different matches.

### Degrading instead of failing

No embedder configured, or a dead one, means style-blind ranking on colour and confidence
alone, with `X-Search-Degraded: <code>` on the response. The code is an ASCII token, never
prose — HTTP headers are latin-1, and one em dash in that value returns a 500 instead of
results. Relaxation announces itself the same way, with `X-Fit-Relaxed: 1` plus `relaxed: true`
on each row.

## Proposed contract additions

Two optional request fields this service already honours, neither in `.claude/contracts.md`
yet. `contracts.md` is Thomas's file, so these are proposals — both are ignored when absent, so
nothing breaks while they are undecided.

| Field | Why |
| --- | --- |
| `palette?: string[]` | "matches its wood tone" needs a target colour. Without it, colour similarity has nothing to compare and the 0.30 weight is dead. |
| `likeObjectId?: string` | The better form of the same thing: the tone belongs to an object already in the room. Supplies both the target colour and, absent an embedder, the reference vector — so "something that matches my desk" works with one field instead of the caller extracting a palette first. |

`likeObjectId` is the one worth arguing for: it is how the pitch query is actually phrased.
