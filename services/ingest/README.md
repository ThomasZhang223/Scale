# services/ingest

**Owner:** Paul
**Scope:** Catalog and marketplace ingest (Component F, pipeline P3). Pulls furniture listings
from Shopify storefronts, extracts dimensions out of messy per-merchant data, converts everything
to metres, and posts each result to `POST /objects` as `Object v1` (`source: "catalog"`).

This service does not touch the app, the backend routes, the headset, or Baseten. It reads and
writes only through `.claude/contracts.md`.

## How to run

```
docker build -t ingest .
docker run --rm -p 8081:8080 ingest
```

Or locally:

```
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8081
```

Endpoints are declared but not implemented — see `app/main.py`. Both return HTTP 501 until the
crawl/extract pipeline lands.

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
