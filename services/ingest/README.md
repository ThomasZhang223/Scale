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
before the event starts (H-4–H0)** — this decides whether this whole pipeline exists at all. See
`merchants.example.json` for the shape of the verified list; the real list is not checked in here
until it exists.

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
