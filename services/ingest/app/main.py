"""services/ingest — catalog ingest (owner: Paul). P3 in BUILD_DOC.md.

Stateless HTTP service on the laptop, reached from the Worker through a quick tunnel
(`infra/README.md`). The Worker's IngestMerchantWorkflow owns orchestration — durability,
per-step retries, the D1 write — and calls here for the extraction itself, the same way it
calls services/fit and services/search. One implementation of the pipeline, not two.

  POST /crawl    { storefront, collection?, pages? }
                 -> { products: [raw Shopify product], count }

  POST /extract  { merchant, storefront, products[], browserbase? }
                 -> { objects: [Object v1], stats }

`/extract` returns rows in the `Object v1` shape from .claude/contracts.md with
`state: "measured"` and `glbUrl: null` — ready for the Workflow to insert. It never generates a
mesh and never writes anywhere: the caller owns storage.

The five steps live in app/: dimensions.py (1), page_extract.py + browserbase.py (2.5),
validate.py (4 and 5). See ../EXTRACTION.md.
"""

from __future__ import annotations

import asyncio
import functools
import os
import time

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from .ai_extract import OpenAIConfig, extract_with_llm, extract_with_vlm
from .auth import require_upstream_token
from .browserbase import BrowserbaseFetch, CachedFetch, FetchError
from .dimensions import extract
from .fit import fit_bounds_mm, passes_fit
from .identity import object_id
from .page_extract import extract_from_page, product_url
from .product_search import (
    drop_unplaceable, handles_from_search_page, normalise_query, products_by_handle,
    relevance, search_url,
)
from .validate import validate

app = FastAPI(title="ingest")

USER_AGENT = "FullScale-HTN2026/0.1 (hackathon project; catalogue dimension research)"
PAGE_CACHE = os.environ.get("PAGE_CACHE", ".page-cache")
MAX_PAGES = 4          # 250 products each; past this a merchant is not a demo, it is a scrape
CRAWL_TIMEOUT_S = 30.0

# Steps 2 and 3 call OpenAI through a synchronous client. Awaiting them directly on the event
# loop blocks the whole process: measured, ten LLM products held /health past its 3s timeout
# twice in a row, and the default aiLimit of 40 is four times that — long enough for compose
# to hit its five-failure threshold and mark a working container unhealthy. So every blocking
# call goes to a worker thread, which also lets them overlap: they are round trips this
# process would otherwise spend asleep.
# ceiling: a fixed width with no adaptive backoff. A 429 is swallowed by _ask and costs that
# one product its recovery. Fine for a single merchant per request.
AI_CONCURRENCY = int(os.environ.get("AI_CONCURRENCY") or 8)

# Step 2.5 is the slowest call in the pipeline — Browserbase renders a real page — and it is
# synchronous too, so it had both of step 2's problems and a tighter budget: at the default
# pageLimit of 60, anything past ~4s a render blows the Worker's 240s timeout, with /health
# unanswerable the whole time.
# Deliberately much lower than AI_CONCURRENCY: Browserbase limits concurrent sessions by plan
# (low single digits on the smaller ones), so a wide pool earns 429s rather than speed. Three
# is safe on a starter plan and still 3x serial; raise it if your plan allows.
PAGE_CONCURRENCY = int(os.environ.get("PAGE_CONCURRENCY") or 3)


async def _in_threads(calls: list, limit: int) -> list:
    """Run blocking callables on worker threads, at most `limit` at once, keeping order.

    Order matters: the caller zips the results back against the products that produced them.
    """
    if not calls:
        return []
    sem = asyncio.Semaphore(max(limit, 1))

    async def run(fn):
        async with sem:
            return await asyncio.to_thread(fn)

    return await asyncio.gather(*(run(fn) for fn in calls))


def _err(status: int, code: str, detail: str):
    return JSONResponse(status_code=status, content={"error": code, "detail": detail})


@app.post("/crawl", dependencies=[Depends(require_upstream_token)])
async def crawl(request: Request):
    """Pull a storefront's public catalogue. No extraction — that is /extract's job, so a
    caller can cache the raw pull and re-extract without re-fetching."""
    body = await request.json()
    storefront = (body.get("storefront") or "").strip()
    if not storefront:
        return _err(422, "missing_storefront", "storefront is required")  # standing rule 4

    collection = body.get("collection")
    pages = min(int(body.get("pages") or 2), MAX_PAGES)
    path = f"/collections/{collection}/products.json" if collection else "/products.json"

    products: list[dict] = []
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT},
                                 timeout=CRAWL_TIMEOUT_S, follow_redirects=True) as client:
        for page in range(1, pages + 1):
            url = f"{storefront.rstrip('/')}{path}?limit=250&page={page}"
            try:
                r = await client.get(url)
                r.raise_for_status()
            except httpx.HTTPStatusError as e:
                return _err(502, "storefront_error",
                            f"{storefront} returned HTTP {e.response.status_code} for {path}")
            except httpx.HTTPError as e:
                return _err(502, "storefront_unreachable", f"{type(e).__name__}: {e}")
            if "json" not in r.headers.get("content-type", "").lower():
                # The usual way a store "disables" the endpoint: its HTML shop page with a 200.
                return _err(422, "not_shopify",
                            f"{storefront} served {r.headers.get('content-type')} — the "
                            f"catalogue endpoint is disabled")
            batch = r.json().get("products")
            if batch is None:
                return _err(422, "not_shopify", "response carries no 'products' key")
            products.extend(batch)
            if len(batch) < 250:
                break

    return {"storefront": storefront, "count": len(products), "products": products}


@app.post("/find", dependencies=[Depends(require_upstream_token)])
async def find_products(request: Request):
    """Prompt -> candidate products from one storefront, best match first.

      POST /find  { storefront, query, limit?, merchant? }
                  -> { query, searchedFor, count, handles, products }

    The front half the pipeline was missing. Everything else here is merchant-driven — crawl a
    catalogue, extract all of it — which pre-generates assets fine but cannot answer "find me a
    red chair" live.

    Relevance is the merchant's, not ours. Their search already knows a "Cloud" is a chair and
    that "sectional" means sofa, which title matching never will, so this renders their own
    /search page through Browserbase and reads the order off it. Rendering rather than fetching
    is what makes stores with client-side search work, the same reason step 2.5 exists.

    Returns raw products, not Object v1: measuring them is /extract's job, and keeping the two
    apart means a caller can cache this and re-extract without paying for the page again —
    exactly the split /crawl and /extract already have.

    `query` is expected to already describe a PRODUCT. Pulling the product out of an utterance
    — "a bookshelf beside my desk" is a search for a bookshelf, not a desk — belongs to the
    voice agent, which splits it into find_anchor and search_objects before anything reaches
    here. This endpoint only strips leftover imperative and article noise; it does not parse
    intent, because two places doing that is how they drift apart.
    """
    body = await request.json()
    storefront = (body.get("storefront") or "").strip()
    raw_query = (body.get("query") or "").strip()
    if not storefront:
        return _err(422, "missing_storefront", "storefront is required")  # standing rule 4
    if not raw_query:
        return _err(422, "missing_query", "query is required")            # standing rule 4

    limit = min(int(body.get("limit") or 12), 50)
    query = normalise_query(raw_query)

    # Never a silent skip: without a key this endpoint cannot work at all, and returning an
    # empty list would look exactly like a merchant having nothing that matches.
    try:
        fetcher = CachedFetch(PAGE_CACHE, upstream=BrowserbaseFetch())
    except ValueError as e:
        return _err(503, "browserbase_unconfigured", str(e))

    url = search_url(storefront, query)
    try:
        res = await asyncio.to_thread(fetcher.fetch, url)
    except FetchError as e:
        return _err(502, "search_page_unreachable", f"{url}: {e}")

    handles = handles_from_search_page(res.content, limit=limit)
    if not handles:
        # A real, reportable outcome — not an error. Say which URL was read so the caller can
        # look at the same page rather than guess whether the search or the parse came up dry.
        return {"query": raw_query, "searchedFor": query, "searchUrl": url,
                "count": 0, "handles": [], "products": []}

    # The search page gives a title, a thumbnail and a link. The catalogue gives variants,
    # body_html and the full image list — which is what the extraction pipeline takes — so
    # join back to it rather than fetching every product again.
    catalogue: list[dict] = []
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT},
                                 timeout=CRAWL_TIMEOUT_S, follow_redirects=True) as client:
        for page in range(1, MAX_PAGES + 1):
            try:
                r = await client.get(
                    f"{storefront.rstrip('/')}/products.json?limit=250&page={page}")
                r.raise_for_status()
            except httpx.HTTPError as e:
                return _err(502, "storefront_unreachable", f"{type(e).__name__}: {e}")
            batch = (r.json() or {}).get("products") or []
            catalogue.extend(batch)
            if len(batch) < 250 or len({h for h in handles} - {
                    (x.get("handle") or "").lower() for x in catalogue}) == 0:
                break

    matched = products_by_handle(catalogue, handles)
    products = drop_unplaceable(matched)
    hits, ratio = relevance(query, products)

    # A store whose search finds nothing may serve its popular products instead, and that page
    # is indistinguishable from a real result set — Floyd answers "red chair" with twelve beds.
    # Returning those unflagged is the worst outcome available: a confident answer to a
    # question nobody asked. Flagged rather than emptied, because the caller knows whether it
    # would rather show something loosely related or say it found nothing.
    fallback = bool(products) and hits == 0

    return {
        "query": raw_query,
        "searchedFor": query,
        "searchUrl": url,
        "count": len(products),
        "handles": handles,
        # Handles the catalogue does not serve cannot be measured, so they are reported rather
        # than quietly dropped — a caller comparing count to handles should see why.
        "missing": [h for h in handles if h not in {
            (x.get("handle") or "").lower() for x in matched}],
        "relevance": {"matched": hits, "ratio": round(ratio, 2)},
        "fallbackSuspected": fallback,
        "warning": (
            f"no result matches any word of {query!r} — this storefront most likely has "
            f"nothing for that query and served popular products instead"
        ) if fallback else None,
        "products": products,
    }


def _object_v1(merchant: str, storefront: str, p: dict, bbox: dict, verdict, method_src: str,
               via: str) -> dict:
    """One row in the contracts.md Object v1 shape, state "measured"."""
    images = [i.get("src") for i in (p.get("images") or []) if i.get("src")]
    price_cents = None
    for v in (p.get("variants") or []):
        try:
            price_cents = int(round(float(v["price"]) * 100))
            break
        except (KeyError, TypeError, ValueError):
            continue
    handle = p.get("handle")
    product_url = f"{storefront.rstrip('/')}/products/{handle}" if handle else None
    return {
        "schemaVersion": 1,
        # Deterministic, so re-ingesting a merchant refreshes its rows instead of duplicating
        # them — IngestMerchantWorkflow's ON CONFLICT(id) DO UPDATE depends on it. See
        # app/identity.py for why the key is the product URL and not the merchant label.
        "objectId": object_id(merchant, product_url, p.get("id"), handle),
        "source": "catalog",
        "state": "measured",
        "name": p.get("title"),
        "category": (p.get("product_type") or "").strip().lower() or None,
        "glbUrl": None,
        "bboxMeters": bbox,
        "measure": {"method": "extracted", "confidence": verdict.confidence},
        "caption": None,          # Ani writes this on state:"ready"
        "palette": [],            # likewise
        "price": {"cents": price_cents, "currency": "USD"} if price_cents is not None else None,
        "productUrl": product_url,
        "merchant": merchant,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        # Beyond the contract, for the caller's benefit — a low score has to be explainable
        # or "unverified fit" is just a shrug.
        "extraction": {
            "via": via,
            "sourceField": method_src,
            "imageUrl": images[0] if images else None,
            "flags": verdict.flags,
            "notes": verdict.notes,
            "unverified": verdict.unverified,
        },
    }


@app.post("/extract", dependencies=[Depends(require_upstream_token)])
async def extract_products(request: Request):
    """Steps 1, 2.5, 4 and 5 over a batch of raw products."""
    body = await request.json()
    products = body.get("products")
    if products is None:
        return _err(422, "missing_products", "products[] is required")
    merchant = (body.get("merchant") or "").strip()
    storefront = (body.get("storefront") or "").strip()
    if not merchant or not storefront:
        return _err(422, "missing_merchant", "merchant and storefront are both required")

    use_pages = bool(body.get("browserbase"))
    page_limit = int(body.get("pageLimit") or 60)
    # Steps 2 and 3 are additive passes over products the cheaper steps already failed on, so
    # an unconfigured key skips them and says so rather than failing the request.
    cfg = OpenAIConfig()
    use_llm = bool(body.get("llm")) and cfg.configured
    use_vlm = bool(body.get("vlm")) and cfg.configured
    ai_limit = int(body.get("aiLimit") or 40)

    # Optional, and only meaningful here — /find has no sizes yet, so a fit filter can only be
    # applied once something has been measured. Two callers want different things: a person
    # browsing for a red chair wants every red chair, an agent putting one in an 0.8 m gap
    # wants only the ones that go there.
    try:
        bounds = fit_bounds_mm(body.get("fit"))
    except (ValueError, TypeError) as e:
        return _err(422, "bad_fit", str(e))  # standing rule 4: never filter nothing silently
    fetcher = None
    if use_pages:
        try:
            fetcher = CachedFetch(PAGE_CACHE, upstream=BrowserbaseFetch())
        except ValueError as e:
            # Never silently skip step 2.5: a smaller result looks exactly like a merchant
            # having no dimensions, which is the wrong conclusion to hand anyone.
            return _err(503, "browserbase_unconfigured", str(e))

    objects: list[dict] = []
    stats = {"products": len(products), "from_api": 0, "from_llm": 0, "from_page": 0,
             "from_vlm": 0, "pages_fetched": 0, "page_failures": 0,
             "rejected": 0, "unverified": 0,
             # Only meaningful when a fit was asked for; with none, everything fits.
             "fitting": 0, "too_big": 0}
    if body.get("llm") and not cfg.configured:
        stats["llm_skipped"] = "OPENAI_API_KEY / OPENAI_MODEL not configured"
    needs_page: list[dict] = []

    def accept(p: dict, hit, via: str, counter: str) -> bool:
        """Step 4 and 5 for one hit, from whichever source. Identical for all of them, which
        is the point: a model's answer is not trusted more than a regex's."""
        bbox = hit.as_bbox() if hit else None
        if not bbox:
            return False
        v = validate(bbox, category=p.get("product_type"), title=p.get("title") or "",
                     source_field=hit.source_field)
        if not v.ok:
            stats["rejected"] += 1
            return False
        stats[counter] += 1
        stats["unverified"] += int(v.unverified)
        obj = _object_v1(merchant, storefront, p, bbox, v, hit.source_field, via)
        # Flagged, not dropped. The caller knows whether it is placing or browsing, and an
        # object that misses by a centimetre is worth showing with that said out loud rather
        # than vanishing with no explanation.
        fits = passes_fit(bbox, bounds)
        obj["extraction"]["fits"] = fits
        stats["fitting" if fits else "too_big"] += 1
        objects.append(obj)
        return True

    needs_ai: list[dict] = []
    for p in products:
        if accept(p, extract(p), "api", "from_api"):
            continue
        needs_ai.append(p)

    # Step 2: the same text, read rather than pattern-matched. The calls overlap on worker
    # threads; accept() stays on this one, in input order, because it mutates objects/stats.
    llm_batch = needs_ai[:ai_limit] if use_llm else []
    ai_errors: list[str] = []
    llm_hits = await _in_threads(
        [functools.partial(extract_with_llm, p, cfg, None, ai_errors) for p in llm_batch],
        AI_CONCURRENCY)
    for p, hit in zip(llm_batch, llm_hits):
        if accept(p, hit, "llm", "from_llm"):
            continue
        if p.get("handle"):
            needs_page.append(p)
    if not use_llm:
        needs_page = [p for p in needs_ai if p.get("handle")]

    # Step 2.5: another surface entirely, for products whose text simply lacks the numbers.
    # The fetches run on worker threads; the bookkeeping below stays on this one, in input
    # order, so stats and objects come out the same regardless of which page finished first.
    needs_image: list[dict] = []
    page_batch = needs_page[:page_limit] if fetcher else []

    def fetch_one(p: dict):
        """Returns the page content, or the FetchError to be counted by the caller."""
        try:
            return fetcher.fetch(product_url(storefront, p["handle"]))
        except FetchError as e:
            return e

    for p, res in zip(page_batch,
                      await _in_threads([functools.partial(fetch_one, p) for p in page_batch],
                                        PAGE_CONCURRENCY)):
        stats["pages_fetched"] += 1
        if isinstance(res, FetchError):
            stats["page_failures"] += 1
            continue
        if not accept(p, extract_from_page(res.content), "page", "from_page"):
            needs_image.append(p)

    # Step 3: the spec-sheet diagram. Last resort, and the most expensive call here, so it runs
    # only over what every cheaper source failed on.
    if use_vlm:
        vlm_batch = needs_image[:ai_limit]
        sem = asyncio.Semaphore(AI_CONCURRENCY)
        async with httpx.AsyncClient(timeout=CRAWL_TIMEOUT_S, follow_redirects=True) as img:

            async def read_one(p: dict) -> None:
                """Up to three images, stopping at the first accept() takes. Kept sequential
                inside a product on purpose: most stop at the first, and firing all three
                would spend three calls to save latency on a product that needed one. The
                overlap is across products.

                accept() is called here rather than after the gather so that a hit it refuses
                — a partial bbox, or a value validate() rejects — still falls through to the
                next image, as it did when this loop was serial. That is safe: only the
                to_thread call leaves the event loop, so every accept() still runs on one
                thread. The cost is that VLM rows land in completion order rather than input
                order, which nothing downstream depends on.
                """
                async with sem:
                    # A spec diagram is rarely the hero shot, so try the later images first.
                    for src in [i.get("src") for i in (p.get("images") or [])][1:4]:
                        if not src:
                            continue
                        try:
                            r = await img.get(src)
                            r.raise_for_status()
                        except httpx.HTTPError:
                            continue
                        hit = await asyncio.to_thread(
                            extract_with_vlm, r.content,
                            r.headers.get("content-type", ""), cfg, None, ai_errors)
                        if accept(p, hit, "vlm", "from_vlm"):
                            return

            await asyncio.gather(*(read_one(p) for p in vlm_batch))

    # A caller cannot tell "the model found nothing" from "every call was rejected" unless we
    # say so. Counted, with one example, rather than raised: these passes are additive.
    if ai_errors:
        stats["ai_call_failures"] = len(ai_errors)
        stats["ai_first_failure"] = ai_errors[0][:200]

    return {"merchant": merchant, "count": len(objects), "stats": stats, "objects": objects}


@app.get("/health")
async def health():
    return {"ok": True, "browserbase": bool(os.environ.get("BROWSERBASE_API_KEY"))}
