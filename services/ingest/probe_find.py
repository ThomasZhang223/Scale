#!/usr/bin/env python3
"""Run a prompt through one merchant's search and show what came back.

The /find tests prove the parser handles HTML I wrote. This answers what they cannot: does a
real Shopify theme's search results page actually carry product links where the parser looks,
and does the merchant's own relevance put sensible things first?

Every theme renders search differently — some server-side, some from JSON in a <script>, some
as a grid of cards linking the product twice. That variety is exactly what cannot be
fixture-tested, so run this against a real store before trusting /find in a demo.

Usage
  export BROWSERBASE_API_KEY=...
  python3 probe_find.py https://floydhome.com "red chair"
  python3 probe_find.py https://polyandbark.com "walnut dining chair" --extract
  python3 probe_find.py --file saved-search.html        # no key needed
  python3 probe_find.py <store> <query> --save-html out.html   # keep it as a fixture
"""

from __future__ import annotations

import argparse
import sys

import httpx

from app.browserbase import BrowserbaseFetch, CachedFetch, FetchError
from app.dimensions import extract
from app.product_search import (
    drop_unplaceable, handles_from_search_page, normalise_query, products_by_handle,
    relevance, search_url,
)
from verify_merchants import USER_AGENT


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("storefront", nargs="?", help="e.g. https://floydhome.com")
    ap.add_argument("query", nargs="?", help='e.g. "red chair"')
    ap.add_argument("--file", help="a saved search-results HTML file; needs no API key")
    ap.add_argument("--limit", type=int, default=12, help="handles to take (default 12)")
    ap.add_argument("--cache", default=".page-cache", help="where fetched pages are cached")
    ap.add_argument("--save-html", help="write the fetched page here, to become a fixture")
    ap.add_argument("--extract", action="store_true",
                    help="also run step 1 on each hit, to show dimensions end to end")
    args = ap.parse_args()

    if args.file:
        html = open(args.file, encoding="utf-8", errors="replace").read()
        url = args.file
        query = args.query or "(from file)"
    else:
        if not args.storefront or not args.query:
            # Standing rule 4: name the actual reason, never a generic usage dump.
            print("give a storefront and a query, or --file a saved page", file=sys.stderr)
            return 2
        query = normalise_query(args.query)
        if query != args.query:
            print(f"query: {args.query!r} -> {query!r}")
        url = search_url(args.storefront, query)
        print(f"fetching {url}")
        try:
            fetcher = CachedFetch(args.cache, upstream=BrowserbaseFetch())
        except ValueError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 1
        try:
            html = fetcher.fetch(url).content
        except FetchError as e:
            print(f"ERROR: fetch failed: {e}", file=sys.stderr)
            return 1
        print(f"  {len(html):,} bytes")

    if args.save_html:
        with open(args.save_html, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"  saved to {args.save_html}")

    handles = handles_from_search_page(html, limit=args.limit)
    print(f"\n{len(handles)} handle(s), in the merchant's own order:")
    for i, h in enumerate(handles, 1):
        print(f"  {i:2}. {h}")
    if not handles:
        print("\n  Nothing parsed. Either the search genuinely has no results, or this theme")
        print("  renders them in a way the parser misses — re-run with --save-html and look.")
        return 0

    if not args.storefront:
        return 0

    print(f"\njoining back to {args.storefront}/products.json ...")
    catalogue: list[dict] = []
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30,
                      follow_redirects=True) as client:
        for page in range(1, 5):
            r = client.get(f"{args.storefront.rstrip('/')}/products.json?limit=250&page={page}")
            r.raise_for_status()
            batch = r.json().get("products") or []
            catalogue.extend(batch)
            if len(batch) < 250:
                break
    print(f"  catalogue has {len(catalogue)} products")

    matched = products_by_handle(catalogue, handles)
    missing = [h for h in handles if h not in {(p.get("handle") or "").lower() for p in matched}]
    print(f"  matched {len(matched)}/{len(handles)}"
          + (f", missing from the catalogue: {missing}" if missing else ""))

    products = drop_unplaceable(matched)
    if len(products) != len(matched):
        dropped = [p.get("title") for p in matched if p not in products]
        print(f"  dropped {len(matched) - len(products)} unplaceable: {dropped}")

    hits, ratio = relevance(args.query or "", products)

    print()
    for i, p in enumerate(products, 1):
        imgs = [im.get("src") for im in (p.get("images") or []) if im.get("src")]
        line = f"  {i:2}. {(p.get('title') or '')[:52]:54} {len(imgs)} image(s)"
        if args.extract:
            hit = extract(p)
            bbox = hit.as_bbox() if hit else None
            line += f"  {bbox if bbox else 'no dimensions from step 1'}"
        print(line)

    if args.extract:
        measured = sum(1 for p in products if (extract(p).as_bbox() if extract(p) else None))
        print(f"\n  {measured}/{len(products)} measurable from /products.json alone.")
        print("  The rest are what steps 2, 2.5 and 3 exist for — /extract runs those.")

    print(f"\n  relevance: {hits}/{len(products)} match a word of "
          f"{(args.query or '')!r} ({ratio:.0%})")
    if products and hits == 0:
        print("  *** FALLBACK SUSPECTED ***")
        print("  Nothing here matches the query. This storefront most likely has nothing for")
        print("  it and served popular products instead — a no-results page that looks exactly")
        print("  like a real one. /find flags this as fallbackSuspected rather than pretending.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
