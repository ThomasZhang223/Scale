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

The route is declared but not implemented — see `app/main.py`. It returns HTTP 501 until ranking
lands. See `RANKING.md` for the one rule that governs the implementation.
