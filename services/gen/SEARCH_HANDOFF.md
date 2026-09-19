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
HTTP embedding caller can use `EMBED_URL=http://127.0.0.1:8002/embed/search` with
`EMBEDDING_LOCAL_SEARCH=1` and `EMBEDDING_SEARCH_FINGERPRINT` set to the indexed
corpus fingerprint on gen. That optional route accepts his text/imageKey
payload and returns `vector`, using the same validated encoder. It only accepts
loopback clients; bind gen to 127.0.0.1, disable proxy-header trust, and NEVER
publish this route via a tunnel/reverse proxy. `/embed` remains bearer-authenticated.
The existing authorized imageKey reader still requires a configured storage seam;
inline photo bytes and the library handoff work without it.

Current real merchant samples contain dimension text but omit images, product IDs
and prices. Paul must supply 5–10 real image files with object/variant identity,
measurement provenance/confidence, and price/currency only where known. Until
then the committed tests are adapter evidence, not catalog relevance evidence.
