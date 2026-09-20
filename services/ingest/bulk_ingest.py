#!/usr/bin/env python3
"""Run the whole verified merchant list through a running ingest container.

This is the mass-ingest driver. It does not contain a pipeline: it calls `POST /crawl` and
`POST /extract` on the service, merchant by merchant, exactly as the Worker's
IngestMerchantWorkflow does. That is deliberate and it is the rule from services/ingest/README:
**one implementation of the pipeline, not two.** A driver with its own regex would drift from
the service within a day and the demo would run whichever one nobody tested.

What it adds over calling the endpoints by hand is the part that matters at 60+ merchants:
resumability. Every merchant's raw pull and extracted rows are written to disk as they land,
and a re-run skips what is already on disk. A storefront that rate-limits at merchant 14 costs
you merchant 14, not the thirteen before it.

Output is one `catalog.ndjson` of Object v1 rows, which is exactly what load_catalog.py reads.

Usage
  # container up:  docker compose --profile local up -d --build ingest
  export UPSTREAM_TOKEN=...            # same value as infra/.env
  python3 bulk_ingest.py merchants.verified.json --out .bulk
  python3 bulk_ingest.py merchants.verified.json --out .bulk --browserbase --llm
  python3 load_catalog.py .bulk/catalog.ndjson --out .load

Flags worth knowing:
  --min-hit-rate   skip merchants whose verified regex hit rate is below this. The default of
                   0.0 ingests everything; verify_merchants.py already measured the number, and
                   a store at 0% costs a crawl and yields nothing.
  --browserbase    step 2.5, the rendered-page pass. Needs BROWSERBASE_API_KEY in the
                   container, not in this shell. Slow and metered; it is what recovers the
                   merchants whose /products.json carries no dimensions at all.
  --force          re-crawl and re-extract merchants already on disk.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import httpx

DEFAULT_BASE = "http://localhost:8003"


def slug(text: str) -> str:
    """Match build_prebake.py's merchant slug, so both produce the same R2 key prefix."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in (text or "")).strip("_")[:60]


def post(client: httpx.Client, base: str, path: str, body: dict, timeout: float) -> dict:
    r = client.post(f"{base.rstrip('/')}{path}", json=body, timeout=timeout)
    if r.status_code != 200:
        detail = r.text[:300]
        if r.status_code == 401:
            raise SystemExit(
                f"401 from {path}: UPSTREAM_TOKEN in this shell does not match the one the "
                f"container was started with (infra/.env). Fix it and re-run — progress on "
                f"disk is kept."
            )
        raise RuntimeError(f"{path} -> HTTP {r.status_code}: {detail}")
    return r.json()


def ingest_one(client, base, merchant, storefront, out, args) -> tuple[list[dict], dict]:
    name = slug(merchant)
    raw_path = os.path.join(out, "raw", f"{name}.json")
    obj_path = os.path.join(out, "objects", f"{name}.json")

    if os.path.exists(obj_path) and not args.force:
        doc = json.load(open(obj_path))
        return doc["objects"], {**doc.get("stats", {}), "skipped": "already on disk"}

    # The raw pull is cached separately from the extraction on purpose: re-extracting with a
    # different pass (--llm, --browserbase) must not re-hit somebody's storefront.
    if os.path.exists(raw_path) and not args.force:
        products = json.load(open(raw_path))["products"]
    else:
        crawled = post(client, base, "/crawl",
                       {"storefront": storefront, "collection": args.collection,
                        "pages": args.pages}, timeout=args.crawl_timeout)
        products = crawled.get("products") or []
        os.makedirs(os.path.dirname(raw_path), exist_ok=True)
        json.dump({"storefront": storefront, "products": products}, open(raw_path, "w"))

    if not products:
        return [], {"products": 0, "note": "storefront returned no products"}

    products = products[: args.max_products]
    extracted = post(client, base, "/extract",
                     {"merchant": name, "storefront": storefront, "products": products,
                      "browserbase": args.browserbase, "llm": args.llm, "vlm": args.vlm,
                      "pageLimit": args.page_limit, "aiLimit": args.ai_limit},
                     timeout=args.extract_timeout)
    objects = extracted.get("objects") or []
    os.makedirs(os.path.dirname(obj_path), exist_ok=True)
    json.dump({"merchant": name, "storefront": storefront, "objects": objects,
               "stats": extracted.get("stats", {})}, open(obj_path, "w"))
    return objects, extracted.get("stats", {})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("merchants", help="merchants.verified.json from verify_merchants.py")
    ap.add_argument("--base", default=os.environ.get("INGEST_BASE", DEFAULT_BASE),
                    help=f"running ingest service (default {DEFAULT_BASE})")
    ap.add_argument("--out", default=".bulk", help="working directory for raw pulls and rows")
    ap.add_argument("--pages", type=int, default=2, help="catalogue pages per merchant, 250 each")
    ap.add_argument("--max-products", type=int, default=250, help="cap per merchant")
    ap.add_argument("--min-hit-rate", type=float, default=0.0,
                    help="skip merchants whose verified dimensionHitRate is below this")
    ap.add_argument("--collection", default=None, help="narrow every pull to one collection handle")
    ap.add_argument("--browserbase", action="store_true", help="step 2.5, the rendered-page pass")
    ap.add_argument("--llm", action="store_true", help="step 2, the LLM text pass")
    ap.add_argument("--vlm", action="store_true", help="step 3, the spec-diagram pass")
    ap.add_argument("--page-limit", type=int, default=60, help="max rendered pages per merchant")
    ap.add_argument("--ai-limit", type=int, default=40, help="max LLM/VLM calls per merchant")
    ap.add_argument("--crawl-timeout", type=float, default=120.0)
    ap.add_argument("--extract-timeout", type=float, default=900.0)
    ap.add_argument("--force", action="store_true", help="re-crawl merchants already on disk")
    args = ap.parse_args()

    token = os.environ.get("UPSTREAM_TOKEN")
    if not token:
        # Standing rule 4. Without it every call 401s one merchant at a time, which looks like
        # a merchant problem and is not.
        print("ERROR: UPSTREAM_TOKEN is unset. It must match the value the container was "
              "started with (infra/.env).", file=sys.stderr)
        return 2

    doc = json.load(open(args.merchants))
    merchants = doc.get("merchants")
    if merchants is None:
        print(f"ERROR: {args.merchants} has no 'merchants' key — is this the output of "
              f"verify_merchants.py?", file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)
    client = httpx.Client(headers={"X-Upstream-Token": token})

    # Fail loud, once, before spending anybody's bandwidth on 20 merchants.
    try:
        h = client.get(f"{args.base.rstrip('/')}/health", timeout=10).json()
    except httpx.HTTPError as e:
        print(f"ERROR: no ingest service at {args.base} ({type(e).__name__}). Start it with "
              f"`docker compose --profile local up -d --build ingest`.", file=sys.stderr)
        return 2
    if args.browserbase and not h.get("browserbase"):
        print("ERROR: --browserbase requested but the container reports browserbase:false. "
              "BROWSERBASE_API_KEY is not set in the container's environment — see "
              "compose.ingest.yml. Refusing to run, because a skipped step 2.5 looks exactly "
              "like a merchant having no dimensions.", file=sys.stderr)
        return 2

    all_objects: list[dict] = []
    totals = {"merchants": 0, "skipped": 0, "failed": 0, "objects": 0}
    print(f"{'merchant':<34} {'products':>8} {'objects':>8}  notes")
    print("-" * 78)

    for m in merchants:
        name = m.get("name") or ""
        storefront = m.get("storefrontBaseUrl") or ""
        if not name or not storefront:
            print(f"{'(unnamed)':<34} {'-':>8} {'-':>8}  missing name or storefrontBaseUrl")
            totals["failed"] += 1
            continue
        if m.get("status") != "ok" or not m.get("productsJsonVerified"):
            print(f"{name[:33]:<34} {'-':>8} {'-':>8}  skipped: status={m.get('status')}")
            totals["skipped"] += 1
            continue
        if (m.get("dimensionHitRate") or 0.0) < args.min_hit_rate:
            print(f"{name[:33]:<34} {'-':>8} {'-':>8}  "
                  f"skipped: hit rate {m.get('dimensionHitRate')} < {args.min_hit_rate}")
            totals["skipped"] += 1
            continue

        started = time.time()
        try:
            objects, stats = ingest_one(client, args.base, name, storefront, args.out, args)
        except (httpx.HTTPError, RuntimeError) as e:
            # One bad storefront must not end a 20-merchant run. It is recorded and skipped;
            # a re-run retries only what has nothing on disk.
            print(f"{name[:33]:<34} {'-':>8} {'-':>8}  FAILED: {str(e)[:40]}")
            totals["failed"] += 1
            continue

        all_objects.extend(objects)
        totals["merchants"] += 1
        totals["objects"] += len(objects)
        note = stats.get("skipped") or (
            f"{stats.get('from_api', 0)} api / {stats.get('from_page', 0)} page / "
            f"{stats.get('from_llm', 0)} llm  {time.time() - started:.0f}s")
        print(f"{name[:33]:<34} {stats.get('products', len(objects)):>8} {len(objects):>8}  {note}")

    # Deduplicate across merchants. Two storefronts reselling the same product URL resolve to
    # the same deterministic id, and a duplicated id inside one file would make the row count
    # a lie.
    seen: set[str] = set()
    out_path = os.path.join(args.out, "catalog.ndjson")
    written = 0
    with open(out_path, "w") as fh:
        for o in all_objects:
            oid = o.get("objectId")
            if not oid or oid in seen:
                continue
            seen.add(oid)
            fh.write(json.dumps(o) + "\n")
            written += 1

    print("-" * 78)
    print(f"{totals['merchants']} merchants ingested, {totals['skipped']} skipped, "
          f"{totals['failed']} failed")
    print(f"{written} unique objects -> {out_path}")
    if totals["objects"] != written:
        print(f"  ({totals['objects'] - written} duplicate ids collapsed)")
    print()
    print("Next:")
    print(f"  python3 load_catalog.py {out_path} --out .load")
    return 0 if totals["merchants"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
