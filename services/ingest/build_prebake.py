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

from app.dimensions import extract
from verify_merchants import USER_AGENT, REQUEST_DELAY_S, bucket_for, DEMO_CATEGORIES


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


def candidates_from(merchant: str, base: str, products: list[dict]) -> list[dict]:
    """Products that carry a real bbox AND an image. Both are required — a mesh needs a
    picture, and a placement needs dimensions, so a product missing either is not a candidate."""
    out = []
    for p in products:
        hit = extract(p)
        bbox = hit.as_bbox() if hit else None
        if not bbox:
            continue
        images = [i.get("src") for i in (p.get("images") or []) if i.get("src")]
        if not images:
            continue
        ptype = (p.get("product_type") or "").strip().lower()
        out.append({
            "productId": str(p.get("id")),
            "merchant": slug(merchant),
            "title": p.get("title"),
            "handle": p.get("handle"),
            "productUrl": f"{base.rstrip('/')}/products/{p.get('handle')}",
            "imageUrl": images[0],
            "r2Key": f"catalog/{slug(merchant)}/{p.get('id')}/source.jpg",
            "category": ptype or None,
            "bucket": bucket_for(ptype),
            "bboxMeters": bbox,
            "measure": {"method": "extracted", "confidence": hit.confidence},
            "source": "catalog",
        })
    return out


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


def download(rows: list[dict], out_dir: str, client: httpx.Client) -> int:
    ok = 0
    for row in rows:
        path = os.path.join(out_dir, row["r2Key"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):
            ok += 1
            continue
        try:
            time.sleep(REQUEST_DELAY_S / 4)
            r = client.get(row["imageUrl"], follow_redirects=True)
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
    args = ap.parse_args()

    data = json.load(open(args.verified))
    merchants = [m for m in data.get("merchants", []) if m.get("productsJsonVerified")]
    if not merchants:
        raise SystemExit(f"{args.verified} lists no verified merchants")  # standing rule 4

    os.makedirs(args.out, exist_ok=True)
    candidates: list[dict] = []
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True) as client:
        for m in merchants:
            name, base = m.get("name") or urlparse(m["storefrontBaseUrl"]).netloc, m["storefrontBaseUrl"]
            print(f"pulling {name} ...", file=sys.stderr, flush=True)
            try:
                products = pull_catalogue(client, base, args.pages)
            except httpx.HTTPError as e:
                print(f"  skipped: {type(e).__name__}", file=sys.stderr)
                continue
            found = candidates_from(name, base, products)
            print(f"  {len(products)} products, {len(found)} with both a bbox and an image",
                  file=sys.stderr)
            candidates.extend(found)

        picked = curate(candidates, args.limit)

        downloaded = 0
        if args.download:
            print(f"downloading {len(picked)} images ...", file=sys.stderr)
            downloaded = download(picked, args.out, client)

    manifest = {
        "_comment": "Pre-bake handoff for Ani (component C). Every row has a real bboxMeters "
                    "and an image. r2Key is where the image belongs per contracts.md.",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(picked),
        "byCategory": {k: sum(1 for c in picked if (c["bucket"] or "other") == k)
                       for k in list(DEMO_CATEGORIES) + ["other"]},
        "imagesDownloaded": downloaded,
        "products": picked,
    }
    path = os.path.join(args.out, "manifest.json")
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\n{len(picked)} products -> {path}")
    for k, n in manifest["byCategory"].items():
        print(f"  {k:<10} {n}")
    if not args.download:
        print("\nimages not fetched; re-run with --download to mirror the R2 layout locally")
    return 0


if __name__ == "__main__":
    sys.exit(main())
