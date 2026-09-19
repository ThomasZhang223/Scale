#!/usr/bin/env python3
"""Run step 2.5 against one real product page and show what each source found.

Built because the step-2.5 tests only prove the parser matches HTML I wrote. This answers the
question those tests cannot: does a real Shopify theme actually carry dimensions where the
extractor looks, and in which of the three sources?

The open question it exists to settle: themes reliably emit Product JSON-LD, but most fill only
name/image/offers/sku. If `width`/`height`/`depth` are absent in practice, the highest-confidence
source is dead weight and the spec-block path is doing all the work.

Usage
  export BROWSERBASE_API_KEY=...
  python3 probe_page.py https://floydhome.com/products/the-floyd-bed
  python3 probe_page.py --from-samples samples/Floyd_Home.json --base https://floydhome.com
  python3 probe_page.py --file saved.html          # no key needed
  python3 probe_page.py <url> --save-html out.html # keep the page for a test fixture
"""

from __future__ import annotations

import argparse
import json
import re
import sys

from app.browserbase import BrowserbaseFetch, CachedFetch, FetchError
from app.page_extract import from_json_ld, from_spec_block, from_full_text, product_url, _spec_texts


def report(label: str, html: str, verbose: bool) -> bool:
    print(f"\n=== {label}")
    print(f"    {len(html):,} bytes")

    found_any = False
    for name, fn in (("json_ld", from_json_ld), ("spec_block", from_spec_block),
                     ("page_text", from_full_text)):
        hit = fn(html)
        if hit is None:
            print(f"    {name:<11} -")
            continue
        found_any = True
        box = hit.as_bbox()
        state = "USABLE" if box else "partial"
        print(f"    {name:<11} {state}  {box or {k: v for k, v in (('w', hit.w), ('h', hit.h), ('d', hit.d)) if v}}"
              f"  conf={hit.confidence}  raw={hit.raw[:60]!r}")

    # The diagnostic that matters when nothing was found: is there a Product JSON-LD at all, and
    # what keys does it carry? That is the difference between "my parser is wrong" and "the data
    # is not there".
    blocks = re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I)
    print(f"    json-ld blocks: {len(blocks)}")
    for b in blocks[:3]:
        try:
            data = json.loads(b)
        except ValueError:
            print("      (unparseable)")
            continue
        nodes = data if isinstance(data, list) else (data.get("@graph") or [data])
        for n in nodes if isinstance(nodes, list) else []:
            if isinstance(n, dict) and "product" in str(n.get("@type", "")).lower():
                keys = sorted(n.keys())
                dims = [k for k in keys if k in ("width", "height", "depth", "size", "additionalProperty")]
                print(f"      Product keys: {keys}")
                print(f"      dimension-ish keys present: {dims or 'NONE'}")

    specs = _spec_texts(html)
    print(f"    spec-labelled blocks: {len(specs)}")
    for t in specs[:3]:
        print(f"      {re.sub(chr(92)+'s+', ' ', t)[:110]!r}")

    if verbose and not found_any:
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))
        near = re.findall(r'[^.]{0,70}\d+(?:\.\d+)?\s*(?:"|cm|in\b|mm\b)[^.]{0,40}', text)[:5]
        print("    numbers with units anywhere on the page:")
        for n in near:
            print(f"      …{n.strip()[:110]}")
    return found_any


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", nargs="?")
    ap.add_argument("--file", help="a saved HTML file; needs no API key")
    ap.add_argument("--from-samples", help="a samples/*.json from verify_merchants.py --dump")
    ap.add_argument("--base", help="storefront base URL, required with --from-samples")
    ap.add_argument("--limit", type=int, default=3, help="pages to probe from --from-samples")
    ap.add_argument("--cache", default=".page-cache", help="where fetched pages are cached")
    ap.add_argument("--save-html", help="write the fetched page here, to become a test fixture")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="on a miss, show every number-with-unit on the page")
    args = ap.parse_args()

    if args.file:
        with open(args.file) as f:
            report(args.file, f.read(), args.verbose)
        return 0

    urls: list[str] = []
    if args.url:
        urls.append(args.url)
    if args.from_samples:
        if not args.base:
            ap.error("--from-samples needs --base (the storefront URL)")
        products = json.load(open(args.from_samples))
        missing = [p.get("title") for p in products if not p.get("handle")]
        if missing:
            print(f"note: {len(missing)} sampled products have no handle — re-run "
                  f"verify_merchants.py --dump to pick up the fix\n", file=sys.stderr)
        for p in products:
            if p.get("handle") and len(urls) < args.limit:
                urls.append(product_url(args.base, p["handle"]))
    if not urls:
        ap.error("give a URL, --file, or --from-samples")

    try:
        fetcher = CachedFetch(args.cache, upstream=BrowserbaseFetch())
    except ValueError as e:
        print(f"{e}\n\nOr probe a saved page with --file, which needs no key.", file=sys.stderr)
        return 2

    usable = 0
    for url in urls:
        try:
            res = fetcher.fetch(url)
        except FetchError as e:
            print(f"\n=== {url}\n    FETCH FAILED ({e.status}): {e}")
            continue
        if args.save_html:
            with open(args.save_html, "w") as f:
                f.write(res.content)
            print(f"saved {args.save_html}")
        if report(url, res.content, args.verbose):
            usable += 1

    print(f"\n{usable}/{len(urls)} pages yielded a dimension. "
          f"cache: {fetcher.hits} hit, {fetcher.misses} fetched\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
