#!/usr/bin/env python3
"""Verify that candidate Shopify merchants actually serve /products.json — and that what they
serve is worth crawling.

This is the H-4 gate in workstreams/paul.md: it decides whether pipeline P3 exists at all, and
with it the Shopify and Rox tracks. Run it BEFORE H0.

Reachability alone is not the question. A store that serves a perfect /products.json with no
dimensions anywhere in it is useless to us, so this also runs step 1 of EXTRACTION.md (the
regex pass) over a sample and reports the real hit rate per merchant. That number is the H4
report, and the code is the first stage of the pipeline rather than a throwaway check.

Politeness, because this hits other people's shops:
  - robots.txt is fetched first and honoured for /products.json
  - one request at a time per host, with a delay between pages
  - a descriptive User-Agent
  - public catalogue endpoints only; nothing authenticated, nothing behind a login

Usage
  python3 verify_merchants.py candidates.json
  python3 verify_merchants.py candidates.json --sample 100 --out merchants.verified.json
  python3 verify_merchants.py --url https://some-shop.com          # one-off check
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx

from app.dimensions import extract

USER_AGENT = "FullScale-HTN2026/0.1 (hackathon project; catalogue dimension research)"
PRODUCTS_PATH = "/products.json"
REQUEST_DELAY_S = 1.0
TIMEOUT_S = 20.0

# Below this, a merchant costs more to support than it contributes.
MIN_PRODUCTS = 20
MIN_DIMENSION_RATE = 0.25

# What the pre-bake actually needs: BUILD_DOC.md asks for 60-100 products with real
# dimensions. Merchant COUNT was never the requirement — two good catalogues can satisfy it
# outright, and fifteen dimensionless ones cannot.
TARGET_USABLE_PRODUCTS = 100

# A small room needs one of each of these, so coverage matters as much as volume.
DEMO_CATEGORIES = {
    "seating": ("chair", "sofa", "couch", "stool", "bench", "seating", "armchair", "ottoman"),
    "surface": ("desk", "table", "console", "nightstand"),
    "storage": ("shelf", "shelving", "bookcase", "cabinet", "storage", "dresser", "credenza"),
    "lighting": ("lamp", "light", "sconce", "pendant"),
}


def bucket_for(ptype: str) -> str | None:
    """Which demo category a product_type belongs to, or None.

    Lighting wins outright: "table lamps" is a lamp, and first-match-in-dict-order put it in
    `surface` because "table" is a surface keyword — which is how a real run reported
    "lighting 0" while holding a lighting merchant's catalogue. Otherwise the longest matching
    keyword wins, so "bookcase" beats a stray substring.
    """
    ptype = (ptype or "").lower()
    if any(w in ptype for w in DEMO_CATEGORIES["lighting"]):
        return "lighting"
    best, best_len = None, 0
    for bucket, words in DEMO_CATEGORIES.items():
        for w in words:
            if w in ptype and len(w) > best_len:
                best, best_len = bucket, len(w)
    return best


def coverage(reports: list["MerchantReport"]) -> dict[str, int]:
    """Usable products per demo category, across every verified merchant."""
    out = {k: 0 for k in DEMO_CATEGORIES}
    for r in reports:
        for ptype, n in (r.categories or {}).items():
            bucket = bucket_for(ptype)
            if bucket:
                out[bucket] += n
    return out


def uncategorised(reports: list["MerchantReport"]) -> list[tuple[str, int]]:
    """product_type values that matched no bucket, commonest first.

    Without this a "no usable products in lighting" gate is unfalsifiable: you cannot tell a
    real gap from a keyword list that does not know what this merchant calls a lamp.
    """
    tally: dict[str, int] = {}
    for r in reports:
        for ptype, n in (r.categories or {}).items():
            if bucket_for(ptype) is not None:
                continue
            tally[ptype] = tally.get(ptype, 0) + n
    return sorted(tally.items(), key=lambda kv: -kv[1])


def classify_error(e: BaseException) -> tuple[str, str]:
    """Turn a transport exception into (status, a sentence worth reading).

    With 25 hand-typed candidates, "that domain does not exist" and "that store is refusing
    us" need different reactions — one is a typo, the other is a dead merchant.
    """
    chain = []
    cur: BaseException | None = e
    while cur is not None and len(chain) < 6:
        chain.append(f"{type(cur).__name__}: {cur}")
        cur = cur.__cause__ or cur.__context__
    blob = " | ".join(chain).lower()

    if isinstance(e, (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.PoolTimeout)):
        return "timeout", "timed out — slow host, or it is throttling us"
    if "nodename nor servname" in blob or "name or service not known" in blob \
            or "gaierror" in blob or "no address associated" in blob \
            or "temporary failure in name resolution" in blob:
        return "dns_error", "domain does not resolve — check the spelling, or the store is gone"
    if "certificate" in blob or "ssl" in blob or "tls" in blob:
        return "tls_error", "TLS failed — expired or mismatched certificate"
    if "refused" in blob:
        return "refused", "connection refused — nothing listening on 443"
    if "proxy" in blob or "403 to connect" in blob:
        return "blocked", "egress policy blocked this host (not the merchant's fault)"
    return "error", f"{type(e).__name__}: {e}"


@dataclass
class MerchantReport:
    name: str
    storefront_base_url: str
    products_json_verified: bool = False
    verified_at: str | None = None
    status: str = "unchecked"          # ok | blocked | robots_disallow | not_shopify | error | thin
    http_status: int | None = None
    product_count: int | None = None   # in the sample, not the whole catalogue
    paginates: bool | None = None
    dimension_hit_rate: float | None = None
    fully_dimensioned_rate: float | None = None   # all three axes, usable as bboxMeters
    usable_products: int = 0                      # the number that actually feeds the pre-bake
    categories: dict | None = None                # product_type -> usable count
    sample_size: int = 0
    example: dict | None = None
    note: str | None = None
    _products: list = field(default_factory=list, repr=False, compare=False)

    def to_dict(self) -> dict:
        """camelCase, to match merchants.example.json — that shape is what the crawler reads."""
        camel = {
            "storefront_base_url": "storefrontBaseUrl",
            "products_json_verified": "productsJsonVerified",
            "verified_at": "verifiedAt",
            "http_status": "httpStatus",
            "product_count": "productCount",
            "dimension_hit_rate": "dimensionHitRate",
            "fully_dimensioned_rate": "fullyDimensionedRate",
            "usable_products": "usableProducts",
            "sample_size": "sampleSize",
        }
        return {
            camel.get(k, k): v
            for k, v in asdict(self).items()
            if v is not None and not k.startswith("_")
        }


def _robots_allows(client: httpx.Client, base: str) -> tuple[bool, str | None]:
    """True when robots.txt permits /products.json. A missing robots.txt means allowed."""
    robots_url = urljoin(base, "/robots.txt")
    try:
        r = client.get(robots_url)
    except httpx.HTTPError as e:
        return True, f"robots.txt unreachable ({type(e).__name__}); proceeding"
    if r.status_code != 200 or not r.text.strip():
        return True, None
    rp = RobotFileParser()
    rp.parse(r.text.splitlines())
    allowed = rp.can_fetch(USER_AGENT, urljoin(base, PRODUCTS_PATH))
    return allowed, None if allowed else "robots.txt disallows /products.json"


def _fetch_page(client: httpx.Client, base: str, page: int, limit: int) -> list[dict]:
    url = urljoin(base, f"{PRODUCTS_PATH}?limit={limit}&page={page}")
    r = client.get(url)
    r.raise_for_status()
    # A storefront with the endpoint disabled often returns the HTML shop page with a 200.
    ctype = r.headers.get("content-type", "")
    if "json" not in ctype.lower():
        raise ValueError(f"expected JSON, got {ctype or 'no content-type'}")
    body = r.json()
    if not isinstance(body, dict) or "products" not in body:
        raise ValueError("no 'products' key — not a Shopify catalogue endpoint")
    return body["products"]


def dump_samples(products: list[dict], name: str, out_dir: str, n: int = 8) -> str:
    """Write raw products for a merchant whose hit rate looks implausible.

    A reachable catalogue at a 0% hit rate is either a store that genuinely publishes no
    dimensions, or a format the regex pass does not know yet. The only way to tell them apart
    is to read the real markup.
    """
    import os
    os.makedirs(out_dir, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
    path = os.path.join(out_dir, f"{safe}.json")
    with open(path, "w") as f:
        json.dump(
            [
                {
                    "title": p.get("title"),
                    # handle is load-bearing: step 2.5 builds {storefront}/products/{handle},
                    # so a sample without it cannot be used to test the page pass.
                    "handle": p.get("handle"),
                    "product_type": p.get("product_type"),
                    "tags": p.get("tags"),
                    "body_html": p.get("body_html"),
                    "variants": [{"title": v.get("title")} for v in (p.get("variants") or [])],
                    "options": p.get("options"),
                }
                for p in products[:n]
            ],
            f,
            indent=2,
        )
    return path


def check(client: httpx.Client, name: str, base: str, sample: int) -> MerchantReport:
    rep = MerchantReport(name=name, storefront_base_url=base)

    allowed, note = _robots_allows(client, base)
    rep.note = note
    if not allowed:
        rep.status = "robots_disallow"
        return rep

    time.sleep(REQUEST_DELAY_S)
    try:
        first = _fetch_page(client, base, page=1, limit=min(sample, 250))
    except httpx.HTTPStatusError as e:
        rep.status = "blocked"
        rep.http_status = e.response.status_code
        rep.note = f"HTTP {e.response.status_code} on {PRODUCTS_PATH}"
        return rep
    except (ValueError, json.JSONDecodeError) as e:
        rep.status = "not_shopify"
        rep.note = str(e)
        return rep
    except httpx.HTTPError as e:
        rep.status, rep.note = classify_error(e)
        return rep

    rep.http_status = 200
    products = list(first)

    # Pagination matters: 250 products is the per-page cap, and a catalogue we can only see
    # the first page of is a much smaller catalogue than it looks.
    if len(first) >= 250 and sample > 250:
        time.sleep(REQUEST_DELAY_S)
        try:
            second = _fetch_page(client, base, page=2, limit=250)
            rep.paginates = len(second) > 0 and second[0].get("id") != first[0].get("id")
            products.extend(second[: max(0, sample - len(products))])
        except httpx.HTTPError:
            rep.paginates = False
    else:
        rep.paginates = None  # not enough products to tell

    rep.product_count = len(products)
    rep.sample_size = len(products)

    hits = 0
    full = 0
    categories: dict[str, int] = {}
    for p in products:
        hit = extract(p)
        if hit is None:
            continue
        hits += 1
        if hit.as_bbox() is not None:
            full += 1
            # What a product IS matters as much as how many there are: the demo needs a desk,
            # a chair, shelving and a lamp, not 245 sofas.
            ptype = (p.get("product_type") or "uncategorised").strip().lower()
            categories[ptype] = categories.get(ptype, 0) + 1
            if rep.example is None:
                rep.example = {
                    "title": p.get("title"),
                    "bboxMeters": hit.as_bbox(),
                    "from": hit.source_field,
                    "raw": hit.raw,
                }
    rep.usable_products = full
    rep.categories = categories or None

    if products:
        rep.dimension_hit_rate = round(hits / len(products), 3)
        rep.fully_dimensioned_rate = round(full / len(products), 3)

    if len(products) < MIN_PRODUCTS:
        rep.status = "thin"
        rep.note = f"only {len(products)} products in the sample"
        return rep

    rep.status = "ok"
    rep.products_json_verified = True
    rep.verified_at = datetime.now(timezone.utc).date().isoformat()
    rep._products = products  # retained only for --dump; never serialised
    return rep


def load_candidates(path: str) -> list[tuple[str, str]]:
    with open(path) as f:
        data = json.load(f)
    out = []
    for m in data.get("merchants", []):
        url = m.get("storefrontBaseUrl")
        if not url:
            raise SystemExit(f"candidate {m!r} has no storefrontBaseUrl")  # standing rule 4
        out.append((m.get("name") or urlparse(url).netloc, url.rstrip("/") + "/"))
    return out


def render(reports: list[MerchantReport]) -> str:
    usable = [
        r for r in reports
        if r.status == "ok" and (r.fully_dimensioned_rate or 0) >= MIN_DIMENSION_RATE
    ]
    lines = [
        "",
        f"{'merchant':<34}{'status':<16}{'n':>6}{'any dim':>9}{'usable':>9}{'products':>10}",
        "-" * 84,
    ]
    # Verified merchants first, best dimension coverage at the top; everything else below.
    for r in sorted(reports, key=lambda r: (r.status != "ok", -(r.fully_dimensioned_rate or 0), r.name)):
        any_rate = f"{r.dimension_hit_rate:.0%}" if r.dimension_hit_rate is not None else "-"
        full_rate = f"{r.fully_dimensioned_rate:.0%}" if r.fully_dimensioned_rate is not None else "-"
        usable_n = str(r.usable_products) if r.status == "ok" else "-"
        lines.append(
            f"{r.name[:33]:<34}{r.status:<16}{r.product_count or 0:>6}"
            f"{any_rate:>9}{full_rate:>9}{usable_n:>10}"
        )
        if r.note:
            lines.append(f"  {r.note}")
    total_usable = sum(r.usable_products for r in reports)
    cov = coverage(reports)
    missing = [k for k, v in cov.items() if v == 0]

    lines += [
        "-" * 84,
        f"reachable: {sum(1 for r in reports if r.status == 'ok')}/{len(reports)}   "
        f"merchants worth keeping: {len(usable)}",
        "",
        f"USABLE PRODUCTS: {total_usable}  (target {TARGET_USABLE_PRODUCTS} for the pre-bake)",
        "  " + "   ".join(f"{k} {v}" for k, v in cov.items()),
        "",
    ]
    unmatched = uncategorised(reports)
    if unmatched:
        total_unmatched = sum(n for _, n in unmatched)
        lines += [
            f"UNCATEGORISED: {total_unmatched} usable products matched no demo category.",
            "  " + ", ".join(f"{t or '(none)'} {n}" for t, n in unmatched[:8]),
            "  If a lamp is in there, widen DEMO_CATEGORIES rather than hunting a new merchant.",
            "",
        ]
    if missing:
        lines.append(f"GAP: no usable products in {', '.join(missing)} — check UNCATEGORISED first.")
    lines += [
        "Products, not merchants, are the requirement. Two good catalogues can satisfy it and",
        "fifteen dimensionless ones cannot. Category coverage is the other half: a small room",
        "needs a surface, seating, storage and a lamp.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("candidates", nargs="?", help="JSON file, shape as candidates.example.json")
    ap.add_argument("--url", action="append", help="check one storefront (repeatable)")
    ap.add_argument("--sample", type=int, default=250, help="products to sample per merchant")
    ap.add_argument("--out", help="write the verified merchant list here")
    ap.add_argument(
        "--require", type=int, default=None,
        help=f"exit non-zero below this many usable PRODUCTS. Defaults to "
             f"{TARGET_USABLE_PRODUCTS} for a candidates file (the H-4 gate), 0 for --url.",
    )
    ap.add_argument(
        "--dump", metavar="DIR",
        help="write raw sample products per reachable merchant, for diagnosing a hit rate that "
             "looks too low to be true.",
    )
    args = ap.parse_args()

    if not args.candidates and not args.url:
        ap.error("give a candidates file or at least one --url")

    targets: list[tuple[str, str]] = []
    if args.candidates:
        targets += load_candidates(args.candidates)
    for u in args.url or []:
        targets.append((urlparse(u).netloc, u.rstrip("/") + "/"))

    reports: list[MerchantReport] = []
    with httpx.Client(
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=TIMEOUT_S,
        follow_redirects=True,
    ) as client:
        for name, base in targets:
            print(f"checking {name} ...", file=sys.stderr, flush=True)
            reports.append(check(client, name, base, args.sample))

    print(render(reports))

    if args.out:
        usable = [r for r in reports if r.status == "ok"]
        with open(args.out, "w") as f:
            json.dump(
                {
                    "_comment": "Generated by verify_merchants.py. Re-run before H0 — a store "
                                "can disable /products.json at any time.",
                    "generatedAt": datetime.now(timezone.utc).isoformat(),
                    "merchants": [r.to_dict() for r in usable],
                },
                f,
                indent=2,
            )
        print(f"wrote {len(usable)} verified merchants to {args.out}\n")

    if args.dump:
        for r in reports:
            if r.status in ("ok", "thin") and r._products:
                print(f"dumped {dump_samples(r._products, r.name, args.dump)}", file=sys.stderr)

    # Non-zero exit makes this usable as a gate in a script. A one-off --url probe is a
    # lookup, not a gate, so it does not fail for having found only one store.
    total_usable = sum(r.usable_products for r in reports)
    required = (args.require if args.require is not None
                else (TARGET_USABLE_PRODUCTS if args.candidates else 0))
    if required == 0:
        return 0  # a probe reports; it does not judge

    if total_usable < required:
        print(f"GATE FAILED: {total_usable} usable products, need {required}.\n", file=sys.stderr)
        return 1
    missing = [k for k, v in coverage(reports).items() if v == 0]
    if missing:
        print(f"GATE FAILED: no usable products in {', '.join(missing)}.\n", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
