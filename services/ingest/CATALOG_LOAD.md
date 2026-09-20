# Loading the catalogue into D1 and R2

**Owner:** Paul. The path from a verified merchant list to rows the demo can search.

Extraction and loading are two commands, not one, because they need different things: the
first needs merchant storefronts, the second needs the Worker's `UPSTREAM_TOKEN`, and those are
rarely the same machine at the same moment. Split, a catalogue pulled once can be loaded,
reloaded, and loaded into a second account without re-scraping anybody.

**The load path is the Worker intake, and only the Worker intake:**
`catalog.ndjson` -> `workers/scripts/catalog-queue.mjs` -> `POST /v1/catalog/ingest`. The
Worker creates the `objects` row, the `jobs` row and the `mesh_outbox` row together. A direct
D1 load creates none of the last two, so its rows can never get a mesh. `load_catalog.py`
(the old direct loader) is superseded and kept only because the Dockerfile COPYs it.
**Never apply `.load/catalog.d1.sql` or `.load2/catalog.d1.sql` to any database** — they carry
`app/identity.py` ids, the Worker mints its own (`stableId`), and loading both gives every
product two rows under two ids.

```
verify_merchants.py  ->  merchants.verified.json
                              |
        bulk_ingest.py  (crawl + extract, through the running container)
                              |
                         catalog.ndjson  ── or ──  prebake/manifest.json
                              |
        workers/scripts/catalog-queue.mjs   (submit -> POST /v1/catalog/ingest)
                              |                      (images -> POST /v1/uploads)
              D1 objects + jobs + mesh_outbox   +   R2 catalog/{merchant}/{productId}/source.jpg
```

## The fast path: the 100 products already in this repo

`prebake/manifest.json` holds 100 curated products with real `bboxMeters`, and all 100 source
images are committed under `prebake/catalog/`. Nothing needs crawling to load these — the
expensive part already happened.

```
cd workers
npm run mesh:images -- --limit 100
npm run mesh:submit -- --limit 100 --enqueue-only
```

`mesh:images` uploads the committed source images to `catalog/{merchant}/{productId}/source.jpg`
through `POST /v1/uploads`. `mesh:submit` posts the manifest rows to `POST /v1/catalog/ingest`.
`--enqueue-only` parks the mesh jobs in `mesh_outbox` until the Baseten secrets exist. Neither
step needs a vendor key. The token comes from `UPSTREAM_TOKEN` or `infra/.env`.

Verify:

```
npx wrangler d1 execute full-scale-db --remote \
  --command "SELECT merchant, COUNT(*) FROM objects WHERE source='catalog' GROUP BY merchant"
```

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
cd ../../workers
npm run mesh:submit -- --file ../services/ingest/.bulk/catalog.ndjson --limit 400 --enqueue-only
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

The id of record is the Worker's `stableId`, a function of the product URL, so a second
submit resolves to the same `objectId` instead of appending a duplicate catalogue.
`app/identity.py` is the driver's own dedup key (`bulk_ingest.py`); it is also a function of the
product URL, so the two agree about *which* rows exist. They do not agree on the id string, and
the Worker renames every row on arrival.

The Worker intake inserts a row only when its id is absent. A second submit does not refresh the
dimensions of an existing row, and it never touches `glb_key` or `state`, so a mesh that
already exists survives a re-run. A fresh mesh job is not started twice for the same input:
the job id is a hash of the id, the image URL and the box.

This was a real bug, not a hypothetical: `app/main.py` used to mint `uuid.uuid4()` per
extraction. A pre-demo re-ingest would have silently doubled the catalogue and filled search
with twins.

## Known ceilings

- **No price on the manifest path.** `build_prebake.py` does not carry the price, so all 100
  rows load with `price_cents` NULL and are invisible to `/v1/search`'s `maxPriceCents` filter.
  The value is already in the raw Shopify product (`variants[0].price`) that `build_prebake.py`
  reads — it needs a `price` key in the manifest, not another crawl.
- **Price needs a currency, and nothing supplies one yet.** Shopify's `/products.json` carries
  no currency, and `/extract` no longer guesses USD: it omits `price` unless the request body
  has a `currency`. `merchants.round3.json` has none, so the `bulk_ingest.py` path also loads
  with `price_cents` NULL. Wrong is worse than absent.
- **One row per product, not per variant.** A sofa in three fabrics is one object with one set
  of dimensions — right for fit, wrong for price. Per-variant rows need the variant id in the
  key in `app/identity.py`.
- **`mesh:images` uploads one image per request.** Fine at 100; at 2,000 it wants parallelism.
- **The R2 upload and the D1 insert are not atomic.** A row can exist with no image behind its
  key if the upload half fails. Both halves are idempotent, so the fix is re-running the failed
  one, and `mesh:images` exits non-zero and names what to retry.
