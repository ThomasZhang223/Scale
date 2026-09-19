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
    sample_size: int = 0
    example: dict | None = None
    note: str | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        return {k: v for k, v in d.items() if v is not None}


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
        rep.status = "error"
        rep.note = f"{type(e).__name__}: {e}"
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
    for p in products:
        hit = extract(p)
        if hit is None:
            continue
        hits += 1
        if hit.as_bbox() is not None:
            full += 1
            if rep.example is None:
                rep.example = {
                    "title": p.get("title"),
                    "bboxMeters": hit.as_bbox(),
                    "from": hit.source_field,
                    "raw": hit.raw,
                }

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
        f"{'merchant':<34}{'status':<16}{'n':>6}{'any dim':>9}{'usable':>9}",
        "-" * 74,
    ]
    # Verified merchants first, best dimension coverage at the top; everything else below.
    for r in sorted(reports, key=lambda r: (r.status != "ok", -(r.fully_dimensioned_rate or 0), r.name)):
        any_rate = f"{r.dimension_hit_rate:.0%}" if r.dimension_hit_rate is not None else "-"
        full_rate = f"{r.fully_dimensioned_rate:.0%}" if r.fully_dimensioned_rate is not None else "-"
        lines.append(
            f"{r.name[:33]:<34}{r.status:<16}{r.product_count or 0:>6}{any_rate:>9}{full_rate:>9}"
        )
        if r.note:
            lines.append(f"  {r.note}")
    lines += [
        "-" * 74,
        f"reachable: {sum(1 for r in reports if r.status == 'ok')}/{len(reports)}   "
        f"usable (>={MIN_DIMENSION_RATE:.0%} fully dimensioned): {len(usable)}",
        "",
        "'usable' is the number that matters: a merchant whose catalogue has no dimensions",
        "costs more to support than it contributes. Target is 15-25 usable merchants.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("candidates", nargs="?", help="JSON file, shape as candidates.example.json")
    ap.add_argument("--url", action="append", help="check one storefront (repeatable)")
    ap.add_argument("--sample", type=int, default=250, help="products to sample per merchant")
    ap.add_argument("--out", help="write the verified merchant list here")
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

    # Non-zero exit makes this usable as a gate in a script.
    strong = [r for r in reports if r.status == "ok"
              and (r.fully_dimensioned_rate or 0) >= MIN_DIMENSION_RATE]
    return 0 if len(strong) >= 15 else 1


if __name__ == "__main__":
    sys.exit(main())
