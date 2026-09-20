# B05: reuse Paul's search

`app.embedding.records` produces the exact `{"objects": [...]}` body consumed by
`services/search/app/main.py` POST `/index`. Each object keeps its supplied fields,
adds `vector` and `embeddingMeta` (dimension, fingerprint, input hash, image
reference, explicit scope). This works at `state: measured`, with no mesh.
No identity, price, confidence, merchant or measurement is invented.

Records may preserve missing metadata. Export to Paul's index refuses missing
objectId, full positive metre dimensions or measurement confidence: his current
index requires a box and otherwise guesses confidence 0.5. Supply the facts first.
Product/variant IDs are optional strings, never generated from a product name.
No extra unit conversion occurs: Paul's existing consumer converts metres to mm.

From `services/gen`, using the prepared B03 Python 3.11.9 environment:

```powershell
python -m app.embedding.records --manifest C:/data/items.json --cache-dir C:/data/models --fingerprint <ready-fingerprint> --scope demo-catalog --output C:/data/index.json
```

Output must be new. Startup only uses cached weights. Example **input shape** (the
values below are deliberately fictitious; this is not a product dataset):

```json
[{"imagePath":"chair.png","imageRef":"demo/chair.png","object":{
  "objectId":"supplied-object-id","productId":"supplied-product-id",
  "source":"catalog","name":"EXAMPLE ONLY","state":"measured","glbUrl":null,
  "bboxMeters":{"w":0.8,"h":1.0,"d":0.6},
  "measure":{"method":"declared","confidence":0.6},
  "price":{"cents":10000,"currency":"CAD"},
  "provenance":{"dataset":"example only"}
}}]
```

Output is `{"objects":[{...supplied fields...,"vector":[768 real numbers],
"embeddingMeta":{"dimension":768,"fingerprint":"...","inputHash":"...",
"modality":"image","scope":"demo-catalog","imageRef":"demo/chair.png"}}]}`.
Keep generated vectors outside Git. Use one scope/fingerprint per index; Paul's
HTTP index does not itself enforce these invariants. Replay a validated export
after restarting his in-memory service.

## Queries, without insertion

`SearchHandoff(records, fingerprint=..., scope=...).query(encoder.response(text=...))`
or `encoder.response(image=photo_bytes)` calls Paul's unchanged BruteForceIndex and
ranker modules. It neither inserts the query nor introduces another engine.
Optional `fit`, `source`, `budget={cents,currency}` are strict eligibility guards:
unknown prices cannot satisfy a budget; wrong currencies cannot pass; exact metre
checks prevent nearest-mm rounding leaks. No 10% relaxation. Paul's scores are
blended similarities/confidence, **not probabilities**. No claim of retrieval
quality follows from the synthetic tests.

Paul's HTTP `/search` currently does not accept query vectors, ignores budgets,
and can relax dimensions. For strict local demos use the library handoff. His
HTTP embedding caller can use `EMBED_URL=http://127.0.0.1:8004/embed/search` with
`EMBEDDING_LOCAL_SEARCH=1` and `EMBEDDING_SEARCH_FINGERPRINT` set to the indexed
corpus fingerprint on gen. That optional route accepts his text/imageKey
payload and returns `vector`, using the same validated encoder. It only accepts
loopback clients; bind gen to 127.0.0.1, disable proxy-header trust, and NEVER
publish this route via a tunnel/reverse proxy. `/embed` remains bearer-authenticated.
`EMBEDDING_IMAGE_MANIFEST` enables the local authorized imageKey reader. Its JSON
list has `imageKey`, `path` (relative to manifest), `sha256` and explicit `principals`
per photo. Use `trusted-local-search` for Paul's local caller and
`trusted-internal-service` for authenticated callers. Unindexed query photos can
be listed too. No caller-controlled paths/URLs are fetched; changed bytes fail.

The Cloudflare Worker now calls the canonical Bearer `/embed` route using the
separate `upstream:embedding` origin and `EMBEDDING_API_KEY`. It reads R2 frames
itself, sends inline image bytes, and pins `embedding:fingerprint` for queries and
index writes. The legacy `EMBEDDING_WORKER_COMPAT` adapter remains opt-in for old
callers but is no longer required. See [deployment notes](EMBEDDING_DEPLOY.md).

Repeatable strict query CLI (no insertion, no HTTP dependency), from services/gen:

```text
python -m app.embedding.query --records C:/data/index.json --cache-dir C:/data/models --fingerprint <ready-fingerprint> --scope demo-catalog --text "a wooden chair" --max-w 0.8 --budget-cents 20000 --currency CAD
```

Replace `--text` with `--image C:/data/query.jpg` for a photo. Output gives rankings
and local embedding/search times; scores are not probabilities. This local command
requires the sibling services/search checkout (the gen-only Docker image omits it).

Latest main includes 100 real downloaded images and extracted metadata in
`services/ingest/prebake/manifest.json`. This supersedes the earlier missing-image
status; extraction metadata is not independently measured physical accuracy.
The committed tests prove adapters, not catalog relevance.

## Current Paul image manifest

The normal main sync includes `services/ingest/build_prebake.py` and downloaded
`{products:[{productId,merchant,title,r2Key,bboxMeters,measure,...}]}` data.
No additional crawl/download was performed in this binding completion run.
Paul's HTTP `/index` and `/search` now require `X-Upstream-Token`; configure
`UPSTREAM_TOKEN` securely at service startup and send the matching header.

Ani's `catalog_manifest` importer consumes its **downloaded** output. Thomas must
supply a JSON mapping from each `catalog/merchant/productId/source.jpg` key to the
real backend `objectId`. Product IDs are merchant-scoped; the importer never
invents global IDs, variant IDs or prices. It validates local images, hashes them,
maps title to name, and preserves extraction dimensions/confidence/provenance.

```text
python -m app.embedding.catalog_manifest --prebake C:/data/prebake/manifest.json --identities C:/data/object-ids.json --output C:/data/b05-input.json
```

Use that output with `app.embedding.records --manifest ...` above. Export refuses
changed image hashes. CDN query-bearing URLs are not retained in records; the
actual supplied R2 key is the image reference. Import never downloads or generates.
