#!/usr/bin/env python3
"""Build the pre-bake handoff for Ani: images plus measured dimensions.

`.claude/contracts.md` owes Ani "product images plus extracted dimensions for the pre-bake" at
H14, keyed `catalog/{merchant}/{productId}/source.jpg`. This produces exactly that from a
verified merchant list.

The number that matters is NOT how many products were extracted — it is how many get a mesh,
and that ceiling is Ani's generation throughput (BUILD_DOC.md: pre-bake 60-100). So this
CURATES rather than dumps: only products with all three axes, balanced across the four
categories a small room needs, because 245 sofas do not furnish a room.

Usage
  python3 build_prebake.py merchants.verified.json --limit 100 --out prebake/
  python3 build_prebake.py merchants.verified.json --limit 100 --out prebake/ --download
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from urllib.parse import urlparse

import httpx

from app.ai_extract import OpenAIConfig, extract_with_llm, extract_with_vlm
from app.browserbase import BrowserbaseFetch, CachedFetch, FetchError
from app.dimensions import extract
from app.page_extract import extract_from_page, product_url
from app.validate import validate
from verify_merchants import USER_AGENT, REQUEST_DELAY_S, bucket_for, DEMO_CATEGORIES


def sized(url: str, width: int | None) -> str:
    """Ask Shopify's CDN for a specific width.

    Two reasons, both real: image-to-3D wants roughly 512-1024 px, so a 3000 px hero shot is
    wasted bytes, and 100 full-resolution images is tens of megabytes of git history for files
    that belong in R2 anyway. Shopify honours ?width=N; a CDN that does not just returns the
    original, which is harmless.
    """
    if not width:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}width={width}"


def slug(text: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in (text or "")).strip("_")[:60]


def pull_catalogue(client: httpx.Client, base: str, pages: int = 2) -> list[dict]:
    products: list[dict] = []
    for page in range(1, pages + 1):
        time.sleep(REQUEST_DELAY_S)
        r = client.get(f"{base.rstrip('/')}/products.json?limit=250&page={page}")
        r.raise_for_status()
        batch = r.json().get("products") or []
        products.extend(batch)
        if len(batch) < 250:
            break
    return products


def _accept(merchant: str, base: str, p: dict, hit, image: str, via: str) -> dict | None:
    """Steps 4 and 5 for one hit, from whichever source — the same gate the service applies.
    Taking `hit.confidence` raw, as this script used to, meant the CLI had no validation at
    all while /extract did: two pipelines, one of them quietly worse."""
    bbox = hit.as_bbox() if hit else None
    if not bbox:
        return None
    v = validate(bbox, category=p.get("product_type"), title=p.get("title") or "",
                 source_field=hit.source_field)
    if not v.ok:
        return None
    return _row(merchant, base, p, bbox, v, image, hit.source_field, via)


def _row(merchant: str, base: str, p: dict, bbox: dict, verdict,
         image: str, extracted_from: str, via: str) -> dict:
    return {
        "productId": str(p.get("id")),
        "merchant": slug(merchant),
        "title": p.get("title"),
        "handle": p.get("handle"),
        "productUrl": f"{base.rstrip('/')}/products/{p.get('handle')}",
        "imageUrl": image,
        "r2Key": f"catalog/{slug(merchant)}/{p.get('id')}/source.jpg",
        "category": (p.get("product_type") or "").strip().lower() or None,
        "bucket": bucket_for((p.get("product_type") or "").strip().lower(), p.get("title") or ""),
        "bboxMeters": bbox,
        # contracts.md allows lidar|extracted|declared, and a page read is still extraction —
        # inventing a fourth value would be a schema change. Which surface it came from is
        # recorded beside it instead.
        "measure": {"method": "extracted", "confidence": verdict.confidence},
        "validation": {"flags": verdict.flags, "unverified": verdict.unverified},
        "extractedFrom": extracted_from,
        # Which pass produced this row. Inferring it from extractedFrom was guesswork — the
        # field names overlap between the API pass and the page pass.
        "via": via,
        "source": "catalog",
    }


def candidates_from(merchant: str, base: str, products: list[dict]) -> tuple[list[dict], list[dict]]:
    """Returns (candidates, needs_page).

    A candidate carries a real bbox AND an image — a mesh needs a picture, a placement needs
    dimensions. `needs_page` is the rest: products with an image but no dimensions anywhere in
    /products.json, which is exactly what step 2.5 exists to rescue.
    """
    out, needs_page = [], []
    for p in products:
        images = [i.get("src") for i in (p.get("images") or []) if i.get("src")]
        if not images:
            continue  # no picture, no mesh — a page fetch cannot help
        hit = extract(p)
        if hit is None or hit.as_bbox() is None:
            if p.get("handle"):
                needs_page.append(p)
            continue
        row = _accept(merchant, base, p, hit, images[0], "api")
        if row is None:
            continue
        out.append(row)
    return out, needs_page


def enrich_with_llm(merchant: str, base: str, products: list[dict], cfg: OpenAIConfig,
                    limit: int) -> tuple[list[dict], list[dict]]:
    """Step 2. Returns (recovered, still_missing) so the caller can hand the rest to 2.5."""
    recovered, missing = [], []
    for p in products[:limit]:
        image = next((i.get("src") for i in (p.get("images") or []) if i.get("src")), None)
        row = _accept(merchant, base, p, extract_with_llm(p, cfg), image, "llm") if image else None
        (recovered if row else missing).append(row or p)
    return [r for r in recovered if r], missing + products[limit:]


def enrich_with_vlm(merchant: str, base: str, products: list[dict], cfg: OpenAIConfig,
                    limit: int, client: httpx.Client) -> list[dict]:
    """Step 3. Only over what every cheaper source failed, and a spec diagram is rarely the
    hero shot, so images 2 through 4 are tried rather than the first."""
    recovered = []
    for p in products[:limit]:
        srcs = [i.get("src") for i in (p.get("images") or []) if i.get("src")]
        for src in srcs[1:4]:
            try:
                r = client.get(src)
                r.raise_for_status()
            except httpx.HTTPError:
                continue
            hit = extract_with_vlm(r.content, r.headers.get("content-type", ""), cfg)
            row = _accept(merchant, base, p, hit, srcs[0], "vlm")
            if row:
                recovered.append(row)
                break
    return recovered


def enrich_from_pages(merchant: str, base: str, products: list[dict], fetcher,
                      limit: int) -> tuple[list[dict], dict]:
    """Step 2.5: recover dimensions from the rendered product page.

    For stores whose /products.json carries none — Floyd, Fyrn, Bend Goods, Branch Furniture,
    about 690 products — the dimensions sit in metafields the endpoint does not serve but the
    page does render. Fetches are cached, so a second run over the same products is free.
    """
    recovered, stats = [], {"attempted": 0, "recovered": 0, "failed": 0}
    for p in products[:limit]:
        url = product_url(base, p["handle"])
        stats["attempted"] += 1
        try:
            res = fetcher.fetch(url)
        except FetchError as e:
            stats["failed"] += 1
            print(f"    fetch failed: {p.get('title', '')[:34]} — {e}", file=sys.stderr)
            continue
        hit = extract_from_page(res.content)
        if hit is None or hit.as_bbox() is None:
            continue
        image = next(i.get("src") for i in p["images"] if i.get("src"))
        row = _accept(merchant, base, p, hit, image, "page")
        if row is None:
            continue
        recovered.append(row)
        stats["recovered"] += 1
    return recovered, stats


def curate(candidates: list[dict], limit: int) -> list[dict]:
    """Round-robin across the demo categories, highest confidence first inside each.

    Taking the top N by confidence would hand Ani whatever the biggest merchant sells most of.
    The demo needs a surface, seating, storage and a lamp.
    """
    buckets: dict[str, list[dict]] = {k: [] for k in DEMO_CATEGORIES}
    buckets["other"] = []
    for c in candidates:
        buckets.setdefault(c["bucket"] or "other", []).append(c)
    for rows in buckets.values():
        rows.sort(key=lambda c: -c["measure"]["confidence"])

    picked: list[dict] = []
    order = [k for k in DEMO_CATEGORIES] + ["other"]
    while len(picked) < limit and any(buckets[k] for k in order):
        for k in order:
            if buckets[k] and len(picked) < limit:
                picked.append(buckets[k].pop(0))
    return picked


def prune_orphans(rows: list[dict], out_dir: str) -> int:
    """Delete images from a previous run that nothing in this manifest points at.

    Product ids differ between runs, so without this every re-run leaves its predecessor's
    images behind — a first re-run left 42 orphans, and a directory holding 142 files for a
    100-product manifest is a thing someone has to stop and work out.
    """
    import glob
    keep = {r["r2Key"] for r in rows}
    removed = 0
    for path in glob.glob(os.path.join(out_dir, "catalog", "*", "*", "source.jpg")):
        if os.path.relpath(path, out_dir) in keep:
            continue
        os.remove(path)
        parent = os.path.dirname(path)
        if not os.listdir(parent):
            os.rmdir(parent)
        removed += 1
    return removed


def download(rows: list[dict], out_dir: str, client: httpx.Client, width: int | None = 1024) -> int:
    ok = 0
    for row in rows:
        path = os.path.join(out_dir, row["r2Key"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):
            ok += 1
            continue
        try:
            time.sleep(REQUEST_DELAY_S / 4)
            r = client.get(sized(row["imageUrl"], width), follow_redirects=True)
            r.raise_for_status()
            with open(path, "wb") as f:
                f.write(r.content)
            row["bytes"] = len(r.content)
            ok += 1
        except httpx.HTTPError as e:
            row["downloadError"] = f"{type(e).__name__}: {e}"
            print(f"  image failed: {row['title'][:40]} — {type(e).__name__}", file=sys.stderr)
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("verified", help="merchants.verified.json from verify_merchants.py")
    ap.add_argument("--limit", type=int, default=100, help="products to hand Ani (default 100)")
    ap.add_argument("--out", default="prebake", help="output directory")
    ap.add_argument("--download", action="store_true",
                    help="also fetch the images into <out>/catalog/... , mirroring the R2 layout")
    ap.add_argument("--pages", type=int, default=2, help="catalogue pages per merchant")
    ap.add_argument("--llm", action="store_true",
                    help="step 2: read dimensions stated as prose. Needs OPENAI_API_KEY and "
                         "OPENAI_MODEL.")
    ap.add_argument("--vlm", action="store_true",
                    help="step 3: read the spec-sheet diagram. The most expensive pass, so it "
                         "runs only on what every cheaper source failed.")
    ap.add_argument("--ai-limit", type=int, default=40,
                    help="products per merchant for steps 2 and 3 (default 40)")
    ap.add_argument("--browserbase", action="store_true",
                    help="step 2.5: for products with an image but no dimensions in "
                         "/products.json, fetch the rendered product page and read them there. "
                         "Needs BROWSERBASE_API_KEY. Fetches are cached.")
    ap.add_argument("--browserbase-limit", type=int, default=60,
                    help="pages to fetch per merchant (default 60). One request each, so this "
                         "is the cost knob.")
    ap.add_argument("--page-cache", default=".page-cache",
                    help="where fetched pages are cached, so re-runs are free")
    ap.add_argument("--image-width", type=int, default=1024,
                    help="ask the CDN for this width (0 for the original). 1024 suits "
                         "image-to-3D and keeps the set small enough to commit.")
    args = ap.parse_args()

    data = json.load(open(args.verified))
    merchants = [m for m in data.get("merchants", []) if m.get("productsJsonVerified")]
    if not merchants:
        raise SystemExit(f"{args.verified} lists no verified merchants")  # standing rule 4

    os.makedirs(args.out, exist_ok=True)

    fetcher = None
    if args.browserbase:
        try:
            fetcher = CachedFetch(args.page_cache, upstream=BrowserbaseFetch())
        except ValueError as e:
            raise SystemExit(f"{e}")  # standing rule 4: do not quietly skip step 2.5

    cfg = OpenAIConfig()
    if (args.llm or args.vlm) and not cfg.configured:
        # standing rule 4: skipping quietly would look like the merchants having no dimensions.
        raise SystemExit("--llm/--vlm need OPENAI_API_KEY and OPENAI_MODEL")

    candidates: list[dict] = []
    page_stats = {"attempted": 0, "recovered": 0, "failed": 0}
    ai_stats = {"llm": 0, "vlm": 0}
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True) as client:
        for m in merchants:
            name, base = m.get("name") or urlparse(m["storefrontBaseUrl"]).netloc, m["storefrontBaseUrl"]
            print(f"pulling {name} ...", file=sys.stderr, flush=True)
            try:
                products = pull_catalogue(client, base, args.pages)
            except httpx.HTTPError as e:
                print(f"  skipped: {type(e).__name__}", file=sys.stderr)
                continue
            found, needs_page = candidates_from(name, base, products)
            print(f"  {len(products)} products, {len(found)} with both a bbox and an image",
                  file=sys.stderr)
            candidates.extend(found)

            if args.llm and needs_page:
                rescued, needs_page = enrich_with_llm(name, base, needs_page, cfg, args.ai_limit)
                ai_stats["llm"] += len(rescued)
                candidates.extend(rescued)
                print(f"  step 2 (llm): recovered {len(rescued)}", file=sys.stderr)

            if fetcher is not None and needs_page:
                print(f"  step 2.5: {len(needs_page)} have an image but no dimensions; "
                      f"fetching up to {args.browserbase_limit} pages", file=sys.stderr)
                rescued, stats = enrich_from_pages(
                    name, base, needs_page, fetcher, args.browserbase_limit)
                for k in page_stats:
                    page_stats[k] += stats[k]
                rate = stats["recovered"] / stats["attempted"] if stats["attempted"] else 0
                print(f"  step 2.5: recovered {stats['recovered']}/{stats['attempted']} "
                      f"({rate:.0%}), {stats['failed']} fetch failures", file=sys.stderr)
                candidates.extend(rescued)

            if args.vlm and needs_page:
                rescued = enrich_with_vlm(name, base, needs_page, cfg, args.ai_limit, client)
                ai_stats["vlm"] += len(rescued)
                candidates.extend(rescued)
                print(f"  step 3 (vlm): recovered {len(rescued)}", file=sys.stderr)

        picked = curate(candidates, args.limit)

        downloaded = 0
        if args.download:
            pruned = prune_orphans(picked, args.out)
            if pruned:
                print(f"pruned {pruned} images from a previous run", file=sys.stderr)
            print(f"downloading {len(picked)} images ...", file=sys.stderr)
            downloaded = download(picked, args.out, client, args.image_width or None)

    manifest = {
        "_comment": "Pre-bake handoff for Ani (component C). Every row has a real bboxMeters "
                    "and an image. r2Key is where the image belongs per contracts.md.",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(picked),
        "byCategory": {k: sum(1 for c in picked if (c["bucket"] or "other") == k)
                       for k in list(DEMO_CATEGORIES) + ["other"]},
        "imagesDownloaded": downloaded,
        "fromPageFetch": sum(1 for c in picked if c.get("via") == "page"),
        "step2_5": page_stats if args.browserbase else None,
        "ai": ai_stats if (args.llm or args.vlm) else None,
        "byVia": {v: sum(1 for c in picked if c.get("via") == v)
                  for v in ("api", "llm", "page", "vlm")},
        "products": picked,
    }
    path = os.path.join(args.out, "manifest.json")
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\n{len(picked)} products -> {path}")
    for k, n in manifest["byCategory"].items():
        print(f"  {k:<10} {n}")
    if args.browserbase:
        a, r = page_stats["attempted"], page_stats["recovered"]
        print(f"\n  step 2.5: {r}/{a} pages yielded dimensions"
              f"{f' ({r / a:.0%})' if a else ''}, {page_stats['failed']} fetch failures")
        print(f"  cache: {fetcher.hits} hit, {fetcher.misses} fetched")
    if args.llm or args.vlm:
        print(f"  steps 2/3: llm recovered {ai_stats['llm']}, vlm recovered {ai_stats['vlm']}")
    print("  in the final set by source: " +
          ", ".join(f"{v} {n}" for v, n in manifest["byVia"].items() if n))
    total_bytes = sum(r.get("bytes", 0) for r in picked)
    if total_bytes:
        print(f"\n  images: {total_bytes / 1e6:.1f} MB at width={args.image_width or 'original'}")
    if not args.download:
        print("\nimages not fetched; re-run with --download to mirror the R2 layout locally")
    return 0


if __name__ == "__main__":
    sys.exit(main())
