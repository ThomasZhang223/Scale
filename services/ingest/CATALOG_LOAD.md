# Loading the catalogue into D1 and R2

**Owner:** Paul. The path from a verified merchant list to rows the demo can search.

Extraction and loading are two commands, not one, because they need different things: the
first needs merchant storefronts, the second needs Cloudflare credentials, and those are
rarely the same machine at the same moment. Split, a catalogue pulled once can be loaded,
reloaded, and loaded into a second account without re-scraping anybody.

```
verify_merchants.py  ->  merchants.verified.json
                              |
        bulk_ingest.py  (crawl + extract, through the running container)
                              |
                         catalog.ndjson  ── or ──  prebake/manifest.json
                              |
                       load_catalog.py  (no network)
                              |
              catalog.d1.sql   +   r2-upload.sh
                              |
                    wrangler  (needs Cloudflare)
```

## The fast path: the 100 products already in this repo

`prebake/manifest.json` holds 100 curated products with real `bboxMeters`, and all 100 source
images are committed under `prebake/catalog/`. Nothing needs crawling to load these — the
expensive part already happened.

```
cd services/ingest
python3 load_catalog.py prebake/manifest.json --out .load

bash .load/r2-upload.sh
cd ../../workers && npx wrangler d1 execute full-scale-db --remote \
  --file ../services/ingest/.load/catalog.d1.sql
```

Verify:

```
npx wrangler d1 execute full-scale-db --remote \
  --command "SELECT merchant, COUNT(*) FROM objects WHERE source='catalog' GROUP BY merchant"
```

`load_catalog.py` touches no network at all. It writes two files you can read before running
them, re-run after a failure, and diff against the last load.

## The full path: every verified merchant

Needs the container up. The vendor keys for steps 2, 2.5 and 3 come from your shell via
`compose.ingest.yml` — never from `infra/.env`, which is committed.

```
export BROWSERBASE_API_KEY=...        # only for --browserbase
export OPENAI_API_KEY=...             # only for --llm / --vlm

docker compose -f docker-compose.yml -f services/ingest/compose.ingest.yml \
  --profile local up -d --build ingest
curl -s localhost:8003/health         # browserbase:true confirms the overlay loaded
```

Then, from `services/ingest/`:

```
export UPSTREAM_TOKEN=...             # same value as infra/.env
python3 bulk_ingest.py merchants.verified.json --out .bulk --browserbase --llm
python3 load_catalog.py .bulk/catalog.ndjson --out .load
```

`bulk_ingest.py` calls the container's `/crawl` and `/extract` — it holds no pipeline of its
own, which is the rule from `README.md`: **one implementation, not two.** What it adds is
resumability. Every raw pull and every extracted row is written to `.bulk/` as it lands, and a
re-run skips what is already there, so a storefront that rate-limits at merchant 14 costs you
merchant 14 and not the thirteen before it. Re-extracting with a different pass (`--llm` added
later) reuses the cached pull rather than hitting the storefront again.

`--min-hit-rate 0.2` skips merchants `verify_merchants.py` already measured as hopeless. Four
of eleven reachable stores carry no dimensions anywhere; crawling them costs time and yields
nothing.

## Re-running is safe, and that is deliberate

Object ids are derived from the product URL (`app/identity.py`), not minted per run. The
generated SQL is `INSERT ... ON CONFLICT(id) DO UPDATE`, so a second load **refreshes** rows
rather than appending a duplicate catalogue.

This was a real bug, not a hypothetical: `app/main.py` used to mint `uuid.uuid4()` per
extraction, while `IngestMerchantWorkflow`'s comment claimed "the service mints the id, so a
re-run of this step upserts rather than duplicating". With a random id that conflict clause can
never fire. A pre-demo re-ingest would have silently doubled the catalogue and filled search
with twins.

Two things the reload deliberately does **not** touch:

- **`glb_key`** — a mesh Ani has generated survives a catalogue reload. Dimensions are ours to
  refresh; the mesh is not.
- **`state`** — a row already flipped to `ready` stays `ready`.

`tests/test_load_catalog.py` asserts both against `workers/src/schema.sql` itself, so a schema
change breaks the test rather than the demo.

## Known ceilings

- **No price on the manifest path.** `build_prebake.py` does not carry the price, so all 100
  rows load with `price_cents` NULL and are invisible to `/v1/search`'s `maxPriceCents` filter.
  The value is already in the raw Shopify product (`variants[0].price`) that `build_prebake.py`
  reads — it needs a `price` key in the manifest and one line in `load_catalog.py`, not another
  crawl. The `bulk_ingest.py` path carries price correctly today.
- **One row per product, not per variant.** A sofa in three fabrics is one object with one set
  of dimensions — right for fit, wrong for price. Per-variant rows need the variant id in the
  key in `app/identity.py`.
- **`r2-upload.sh` shells out to `wrangler` once per image.** Fine at 100; at 2,000 it wants
  the S3 API and parallelism.
- **The R2 upload and the D1 insert are not atomic.** A row can exist with no image behind its
  key if the upload half fails. Both halves are idempotent, so the fix is re-running the failed
  one, and `r2-upload.sh` exits non-zero and names what to retry.
