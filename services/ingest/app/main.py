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

import os
import time
import uuid

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from .auth import require_upstream_token
from .browserbase import BrowserbaseFetch, CachedFetch, FetchError
from .dimensions import extract
from .page_extract import extract_from_page, product_url
from .validate import validate

app = FastAPI(title="ingest")

USER_AGENT = "FullScale-HTN2026/0.1 (hackathon project; catalogue dimension research)"
PAGE_CACHE = os.environ.get("PAGE_CACHE", ".page-cache")
MAX_PAGES = 4          # 250 products each; past this a merchant is not a demo, it is a scrape
CRAWL_TIMEOUT_S = 30.0


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
    return {
        "schemaVersion": 1,
        "objectId": str(uuid.uuid4()),
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
        "productUrl": f"{storefront.rstrip('/')}/products/{p.get('handle')}" if p.get("handle") else None,
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
    fetcher = None
    if use_pages:
        try:
            fetcher = CachedFetch(PAGE_CACHE, upstream=BrowserbaseFetch())
        except ValueError as e:
            # Never silently skip step 2.5: a smaller result looks exactly like a merchant
            # having no dimensions, which is the wrong conclusion to hand anyone.
            return _err(503, "browserbase_unconfigured", str(e))

    objects: list[dict] = []
    stats = {"products": len(products), "from_api": 0, "from_page": 0,
             "pages_fetched": 0, "page_failures": 0, "rejected": 0, "unverified": 0}
    needs_page: list[dict] = []

    for p in products:
        hit = extract(p)
        bbox = hit.as_bbox() if hit else None
        if not bbox:
            if p.get("handle"):
                needs_page.append(p)
            continue
        v = validate(bbox, category=p.get("product_type"), title=p.get("title") or "",
                     source_field=hit.source_field)
        if not v.ok:
            stats["rejected"] += 1
            continue
        stats["from_api"] += 1
        stats["unverified"] += int(v.unverified)
        objects.append(_object_v1(merchant, storefront, p, bbox, v, hit.source_field, "api"))

    for p in needs_page[:page_limit] if fetcher else []:
        stats["pages_fetched"] += 1
        try:
            res = fetcher.fetch(product_url(storefront, p["handle"]))
        except FetchError:
            stats["page_failures"] += 1
            continue
        hit = extract_from_page(res.content)
        bbox = hit.as_bbox() if hit else None
        if not bbox:
            continue
        v = validate(bbox, category=p.get("product_type"), title=p.get("title") or "",
                     source_field=hit.source_field)
        if not v.ok:
            stats["rejected"] += 1
            continue
        stats["from_page"] += 1
        stats["unverified"] += int(v.unverified)
        objects.append(_object_v1(merchant, storefront, p, bbox, v, hit.source_field, "page"))

    return {"merchant": merchant, "count": len(objects), "stats": stats, "objects": objects}


@app.get("/health")
async def health():
    return {"ok": True, "browserbase": bool(os.environ.get("BROWSERBASE_API_KEY"))}
