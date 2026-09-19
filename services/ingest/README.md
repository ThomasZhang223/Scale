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

`usable` means all three axes parsed, so the product yields a real `bboxMeters`. It exits
non-zero below 15 usable merchants, so it works as a gate in a script.

Statuses worth knowing: `not_shopify` is the common way a store "disables" the endpoint — it
returns the HTML shop page with a 200, which a naive check reads as success. `thin` means the
catalogue is too small to carry its own integration cost.

It is polite by construction: `robots.txt` is fetched and honoured for `/products.json`, one
request at a time per host with a delay, a descriptive User-Agent, and public catalogue
endpoints only. Re-run it on the day — a store can turn the endpoint off at any time.

`candidates.example.json` is the input shape (placeholders, not real merchants);
`merchants.verified.json` is the generated output and is what the crawler should read.

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
