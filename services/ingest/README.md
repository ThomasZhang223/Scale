# services/ingest

**Owner:** Paul
**Scope:** Catalog and marketplace ingest (Component F, pipeline P3). Pulls furniture listings
from Shopify storefronts, extracts dimensions out of messy per-merchant data, converts everything
to metres, and posts each result to `POST /objects` as `Object v1` (`source: "catalog"`).

This service does not touch the app, the backend routes, the headset, or Baseten. It reads and
writes only through `.claude/contracts.md`.

## How to run

Normally you don't run this service by hand. It is registered in the repo's
`docker-compose.yml` as `ingest` on **host port 8003** (container 8080), and `infra/up.sh`
brings it up with `fit` and `search`, tunnels it, and publishes the origin to the Worker:

```
cp infra/.env.example infra/.env     # then fill in UPSTREAM_TOKEN
infra/up.sh
```

Config comes from `infra/.env`, which compose passes into the container. `UPSTREAM_TOKEN` is
required — the service refuses to start without it, because an auth check that silently
passes when unconfigured is worse than no auth. `BROWSERBASE_API_KEY` and `OPENAI_API_KEY` /
`OPENAI_MODEL` are optional and gate the later extraction steps; see the comments in
`infra/.env.example` and `EXTRACTION.md`.

To run just this container:

```
docker compose --profile local up -d --build ingest
curl -s localhost:8003/health          # {"ok":true,"browserbase":true|false}
docker compose logs -f ingest
```

`/health` needs no token and reports whether step 2.5 is configured, so it tells you which
mode a running container is in without spending a page fetch to find out.

Or without Docker, from this directory:

```
pip install -r requirements.txt
UPSTREAM_TOKEN=devtoken uvicorn app.main:app --reload --port 8080
```

Every route except `/health` needs `X-Upstream-Token` matching `UPSTREAM_TOKEN`:

```
curl -s -X POST localhost:8003/extract \
  -H 'content-type: application/json' -H "X-Upstream-Token: $UPSTREAM_TOKEN" \
  -d '{"merchant":"floyd","storefront":"https://floydhome.com","products":[]}'
```

The tests are plain scripts, not pytest — run one, or all of them:

```
UPSTREAM_TOKEN=devtoken python3 tests/test_service.py
for t in tests/test_*.py; do UPSTREAM_TOKEN=devtoken python3 "$t"; done
```

## The service the Worker calls

`infra/README.md` runs this on the laptop at `localhost:8003` behind a quick tunnel, because
the scraper cannot follow the rest of the backend to Workers. The Worker's
`IngestMerchantWorkflow` owns orchestration — durability, per-step retries, the D1 write — and
calls here for the extraction itself, the same way it calls `services/fit` and
`services/search`. **One implementation of the pipeline, not two.**

| | Body | Returns |
| --- | --- | --- |
| `POST /crawl` | `{ storefront, collection?, pages? }` | `{ products: [raw], count }` |
| `POST /extract` | `{ merchant, storefront, products[], browserbase?, pageLimit? }` | `{ objects: [Object v1], stats }` |
| `GET /health` | — | liveness; no token needed |

Split in two so a caller can cache the raw pull and re-extract without re-fetching — which is
most of how this pipeline got debugged.

`/extract` returns rows in the `Object v1` shape from `.claude/contracts.md`, `state:"measured"`
with `glbUrl: null`, ready to insert. It never generates a mesh and never writes anywhere: the
caller owns storage. Each row carries an extra `extraction` block — `via`, `sourceField`,
`flags`, `notes`, `unverified` — because a low confidence score has to be explainable or
"unverified fit" is just a shrug.

`/crawl` and `/extract` sit behind `X-Upstream-Token`, same as `services/search`. Run them with
`UPSTREAM_TOKEN=dev uvicorn app.main:app --port 8003`.

### Steps 2 and 3: `app/ai_extract.py`

OpenAI over raw HTTP, matching `services/agent/src/pipeline/planner.ts` — same
`OPENAI_API_KEY` / `OPENAI_MODEL`, same optional `OPENAI_GATEWAY_URL` /
`OPENAI_GATEWAY_TOKEN`, same strict `json_schema`. No SDK, since this service already has
`httpx`.

`OPENAI_MODEL` should match what the rest of the project uses — `services/agent/wrangler.toml`
sets `gpt-4o-mini`, which is plenty for step 2: reading a stated number out of prose under a
strict schema is an easy extraction task. Step 3 is the harder read — small callout text on a
dimension diagram — and the lowest volume, since it runs only on what every cheaper source
failed, so `OPENAI_VLM_MODEL` can point it at something stronger without paying for that on
every step-2 call. It defaults to `OPENAI_MODEL`.

Pass `"llm": true` and `"vlm": true` on `/extract`. Both are additive — they run only over
products steps 1 and 2.5 failed on, capped by `aiLimit` — so an unconfigured key skips them and
`stats.llm_skipped` says why. The strict schema is also the defence against a stranger writing
"ignore previous instructions" into product copy: no field in it can express anything else.

### Steps 4 and 5: `app/validate.py`

Steps 1–3 answer "what number is on the page". Step 4 answers "should we believe it", which is
what the Rox rubric rewards. Three checks: unit sanity (a sofa is not 8 cm wide), category
priors (a dining chair is 40–50 cm), and axis plausibility (depth exceeding both width and
height usually means W and D were swapped, which reads as plausible furniture and places
completely wrong).

A number that fails validation outright is **rejected**. One that merely disagrees with its
prior is **kept and scored down**, so the UI says "unverified fit" rather than showing a
confident wrong box. That distinction is step 5.

## Shopify catalog access

Shopify storefronts expose their catalog publicly, no auth required:

- `/products.json`
- `/collections/<handle>/products.json`

Some merchants disable this. **The chosen 15–25 furniture merchants must be verified reachable
before the event starts (H-4–H0)** — this decides whether this whole pipeline exists at all.

### Verifying them: `verify_merchants.py`

Run it from `services/ingest/`. The only dependency it needs is `httpx`.

**Probe one store** — the fastest way to check a candidate, and it exits 0 on success:

```
cd services/ingest
pip install httpx
python3 verify_merchants.py --url https://some-furniture-store.com
```

**Check the whole list** — this is the H-4 gate, so it exits non-zero below 15 usable
merchants (override with `--require N`):

```
cp candidates.example.json candidates.json
$EDITOR candidates.json          # replace the placeholders with merchants you picked
python3 verify_merchants.py candidates.json --out merchants.verified.json
```

Reachability is not the question. A store can serve a flawless `/products.json` that contains no
dimensions anywhere, and it is worth nothing to us. So the verifier also runs **step 1 of
`EXTRACTION.md` (the regex pass)** over a sample of each catalogue and reports the real hit
rate. That is the number that decides a merchant, and it is the H4 "real extraction hit rate"
report from `workstreams/paul.md`.

```
merchant                          status               n  any dim   usable
--------------------------------------------------------------------------
good                              ok                  30     100%     100%
partial                           ok                  30      20%      20%
nodims                            ok                  30       0%       0%
blocked                           blocked              0        -        -
  HTTP 403 on /products.json
html                              not_shopify          0        -        -
  expected JSON, got text/html
robots                            robots_disallow      0        -        -
--------------------------------------------------------------------------
reachable: 3/6   usable (>=25% fully dimensioned): 1
```

`usable` means all three axes parsed, so the product yields a real `bboxMeters`.

**The gate counts products, not merchants.** `BUILD_DOC.md` asks for 60–100 pre-baked products
with real dimensions; merchant count was never the requirement. Two catalogues at 250 products
and 98% coverage satisfy it outright, and fifteen dimensionless ones cannot. It exits non-zero
below 100 usable products (`--require N` to change), or if any of the four demo categories —
seating, surface, storage, lighting — has none, because a small room needs one of each.

### When a hit rate looks too low to be true

A reachable catalogue at 0% is either a store that genuinely publishes no dimensions, or a
format the regex pass has not met yet. `/products.json` **does not include metafields**, which
is where a well-run store often keeps them, so a 0% store may still have the data on its
product pages.

```
python3 verify_merchants.py candidates.json --dump samples/
```

writes 8 raw products per reachable merchant to `samples/<merchant>.json` — enough to read the
real markup and decide whether to extend the patterns or drop the store.

### Statuses

| Status | Means |
| --- | --- |
| `ok` | Endpoint served a real catalogue. Check the `usable` column before trusting it. |
| `not_shopify` | The common way a store "disables" the endpoint: it returns the HTML shop page with a **200**, which a naive check reads as success. Also covers JSON with no `products` key. |
| `blocked` | HTTP 4xx/5xx on `/products.json`, or an egress policy in the way. |
| `robots_disallow` | `robots.txt` forbids it. Not negotiable — pick another merchant. |
| `dns_error` | The domain does not resolve. Almost always a typo in `candidates.json`. |
| `timeout` | Slow host, or it is throttling us. Worth one retry before writing it off. |
| `tls_error` | Expired or mismatched certificate. |
| `refused` | Nothing listening on 443. |
| `thin` | Catalogue too small to carry its own integration cost. |

`dns_error` vs `blocked` is the distinction that saves time on a hand-typed list: one is your
spelling, the other is the merchant.

It is polite by construction: `robots.txt` is fetched and honoured for `/products.json`, one
request at a time per host with a delay, a descriptive User-Agent, and public catalogue
endpoints only. Re-run it on the day — a store can turn the endpoint off at any time.

`candidates.example.json` is the input shape (placeholders, not real merchants);
`merchants.verified.json` is the generated output and is what the crawler should read.

## The pre-bake handoff to Ani: `build_prebake.py`

`.claude/contracts.md` owes Ani "product images plus extracted dimensions for the pre-bake" at
H14, keyed `catalog/{merchant}/{productId}/source.jpg`.

```
python3 verify_merchants.py candidates.json --out merchants.verified.json
python3 build_prebake.py merchants.verified.json --limit 100 --out prebake/ --download
```

Writes `prebake/manifest.json` — one row per product with a real `bboxMeters`, an image URL, and
the R2 key the image belongs at — and with `--download`, the images themselves in that layout.

### Step 2.5: `--browserbase`

```
export BROWSERBASE_API_KEY=...
python3 build_prebake.py merchants.verified.json --limit 100 --out prebake/ \
        --download --browserbase --browserbase-limit 60
```

For every product that has an image but **no** dimensions in `/products.json`, this fetches
`{storefront}/products/{handle}` and reads them off the rendered page. That is the Floyd, Fyrn,
Bend Goods and Branch Furniture case — roughly 690 products whose dimensions sit in metafields
the endpoint does not serve.

The run reports the recovery rate, which is the number that decides whether those stores are
worth keeping:

```
  step 2.5: 38/60 pages yielded dimensions (63%), 0 fetch failures
  cache: 0 hit, 60 fetched
```

Pages are cached in `.page-cache/`, which is **gitignored**: a full run caches around 250 MB at
~450 KB a page, and it is derived data anyway — deleting it costs a re-fetch and nothing else.
Three real Floyd pages were promoted out of it into `tests/fixtures/pages/`, because they are
the only genuine merchant markup in the repo and they settled what Floyd's JSON-LD does and does
not carry. See the README there.

`--browserbase-limit` is the cost knob — one request per product, per merchant. Pages are
cached in `--page-cache`, so a second run over the same products costs nothing and only new
products are fetched. Without `BROWSERBASE_API_KEY` the run **fails** rather than silently
skipping the pass: a quietly smaller manifest looks exactly like the stores having no
dimensions.

Rescued rows carry `extractedFrom` (`json_ld`, `spec_block` or `page_text`) so you can see
which surface paid off. `measure.method` stays `"extracted"` — a page read is still extraction,
and inventing a fourth enum value would be a schema change.

**It curates rather than dumps.** The ceiling is not how many products were extracted, it is how
many get a mesh, and that is Ani's generation throughput: 60–100 (`BUILD_DOC.md`). So selection
is round-robin across the four demo categories, highest confidence first inside each. Taking the
top 100 by confidence would hand him whatever the biggest merchant sells most of, and 245 sofas
do not furnish a room.

A product needs **both** a bbox and an image to make the list: a mesh needs a picture, a
placement needs a size. Ani cannot test 2D→3D without the pixels — the manifest alone only
unblocks the scale binding, which he has already built.

Images are fetched at `--image-width 1024` by default: image-to-3D wants roughly 512–1024 px,
and 100 hero shots at full resolution is tens of megabytes of git history for files that belong
in R2. Pass `--image-width 0` for the originals.

## Dimensions are the hard part

Shopify has a `weight` field but **no standard dimensions field**. Expect the real answer to live
in one of:

- custom metafields
- free text inside `body_html`, in mixed units (in, cm, mm, ft)
- variant titles, e.g. `60" x 30"`
- a spec-sheet image with no extractable text
- nowhere at all

Don't build the pipeline around one canonical source — see `EXTRACTION.md` for the five-step
pipeline that resolves this.

**Every length is converted to metres at ingest.** The rest of the project is metres-only
(`.claude/contracts.md`, global conventions). Never store or compare centimetres, inches, or
millimetres downstream of this service.

## Facebook Marketplace / other listing sources — timeboxed spike only

This is a **hard-timeboxed 2-hour spike** (H4–H10), not a commitment:

- There is no public catalog endpoint like Shopify's `/products.json`.
- Listings are inconsistent and often carry no dimensions at all.
- It is the likeliest thing in this whole project to consume the entire weekend for nothing.

Drop it the moment it fights back. If it's attempted, it must use only publicly reachable data
and respect each site's terms of service and rate limits.

## Ownership

Paul owns merchant retrieval end to end: choosing the vendors, verifying `/products.json`
reaches them, judging which non-Shopify sources are worth the time, and the pipeline from
discovery through extraction. Nobody hands him a vendor list and nobody approves it.

Pick vendors that make the demo easy: real dimension data, clean product photos on plain
backgrounds, and a category mix that suits a small room.
