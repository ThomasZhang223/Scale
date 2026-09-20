#!/usr/bin/env python3
"""Load a measured catalogue into D1 and R2.

SUPERSEDED by the Worker intake (workers/scripts/catalog-queue.mjs -> POST /v1/catalog/ingest).
This path writes D1 directly and creates no job row and no mesh_outbox row, so nothing it loads
can ever get a mesh. Kept only because services/ingest/Dockerfile COPYs this file. Paul: remove
it together with that Dockerfile line and tests/test_load_catalog.py.

The extraction pipeline produces rows; this puts them where the demo reads them from. It is a
separate step on purpose — extraction needs merchant storefronts, loading needs Cloudflare
credentials, and those are rarely the same machine at the same moment. Splitting them means a
catalogue pulled once can be loaded, reloaded and loaded into a second account without
re-scraping anybody.

Two inputs, same output:

  prebake/manifest.json   what build_prebake.py curates — 100 products with images, committed
  *.ndjson                what bulk_ingest.py writes — Object v1 rows straight from /extract

Two outputs, neither of which touches the network:

  <out>/catalog.d1.sql    idempotent upserts into the `objects` table
  <out>/r2-upload.sh      one `wrangler r2 object put` per source image

Nothing here calls Cloudflare. It writes files you then run, so the expensive, rate-limited,
credential-carrying part is a command you can read before you run it, re-run after a failure,
and diff against the last one.

Usage
  python3 load_catalog.py prebake/manifest.json --out .load/
  python3 load_catalog.py catalog.ndjson --out .load/ --bucket full-scale-objects
  bash .load/r2-upload.sh
  cd ../../workers && npx wrangler d1 execute full-scale-db --remote --file ../services/ingest/.load/catalog.d1.sql
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app.identity import object_id  # noqa: E402

DEFAULT_BUCKET = "full-scale-objects"
DEFAULT_DB = "full-scale-db"


def sql_str(value) -> str:
    """A SQL literal. Every string in this file goes through here.

    Product titles are attacker-adjacent text — they come off a stranger's storefront and they
    contain apostrophes constantly ("Levi's"). This doubles quotes and rejects the NUL byte
    rather than trusting the input.
    """
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    s = str(value)
    if "\x00" in s:
        raise ValueError("NUL byte in a value destined for SQL")
    return "'" + s.replace("'", "''") + "'"


def row_from_manifest(p: dict) -> dict:
    """One prebake manifest entry -> the loader's row shape.

    ceiling: build_prebake.py carries no price, so every row loaded from a manifest has
    price_cents NULL and is invisible to /v1/search's maxPriceCents filter. The price is in the
    raw Shopify product (`variants[0].price`) that build_prebake already reads — it needs a
    `price` key in the manifest and one line here, not another crawl.
    """
    bbox = p.get("bboxMeters") or {}
    for axis in ("w", "h", "d"):
        if not isinstance(bbox.get(axis), (int, float)):
            raise ValueError(f"{p.get('productId')}: bboxMeters.{axis} missing or not a number")
    measure = p.get("measure") or {}
    return {
        "objectId": object_id(p.get("merchant"), p.get("productUrl"), p.get("productId"), p.get("handle")),
        "name": p.get("title"),
        "category": p.get("category") or p.get("bucket"),
        "bboxMeters": bbox,
        "measure": {
            "method": measure.get("method") or "extracted",
            "confidence": measure.get("confidence"),
        },
        "price": None,
        "productUrl": p.get("productUrl"),
        "merchant": p.get("merchant"),
        # The image the pre-bake downloaded, and where it belongs in R2 per contracts.md.
        "r2Key": p.get("r2Key"),
        "localImage": os.path.join("prebake", p["r2Key"]) if p.get("r2Key") else None,
    }


def row_from_object_v1(o: dict) -> dict:
    """One Object v1 row from /extract -> the loader's row shape.

    The service already minted a deterministic objectId (app/identity.py), so this trusts it
    rather than recomputing — two id rules would be the same class of bug this loader exists
    to avoid.
    """
    bbox = o.get("bboxMeters") or {}
    for axis in ("w", "h", "d"):
        if not isinstance(bbox.get(axis), (int, float)):
            raise ValueError(f"{o.get('objectId')}: bboxMeters.{axis} missing or not a number")
    extraction = o.get("extraction") or {}
    image_url = extraction.get("imageUrl")
    merchant = o.get("merchant")
    # Shopify's own product id is not in Object v1, so the R2 key uses the same stable key the
    # object id is built from. Different string, same guarantee: one product, one prefix.
    product_key = (o.get("productUrl") or "").rstrip("/").rsplit("/", 1)[-1] or o["objectId"]
    return {
        "objectId": o["objectId"],
        "name": o.get("name"),
        "category": o.get("category"),
        "bboxMeters": bbox,
        "measure": o.get("measure") or {},
        "price": o.get("price"),
        "productUrl": o.get("productUrl"),
        "merchant": merchant,
        "r2Key": f"catalog/{merchant}/{product_key}/source.jpg" if merchant else None,
        # Nothing on disk: bulk_ingest.py records the CDN url, and r2-upload.sh streams it.
        "localImage": None,
        "imageUrl": image_url,
    }


def load_rows(path: str) -> list[dict]:
    if path.endswith(".ndjson") or path.endswith(".jsonl"):
        rows = []
        with open(path) as fh:
            for n, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(row_from_object_v1(json.loads(line)))
                except (ValueError, KeyError) as e:
                    raise SystemExit(f"{path}:{n}: {e}")
        return rows

    doc = json.load(open(path))
    products = doc.get("products")
    if products is None:
        raise SystemExit(f"{path}: no 'products' key — is this a build_prebake.py manifest?")
    rows = []
    for n, p in enumerate(products, 1):
        try:
            rows.append(row_from_manifest(p))
        except (ValueError, KeyError) as e:
            raise SystemExit(f"{path}: product {n}: {e}")
    return rows


def write_sql(rows: list[dict], out: str) -> str:
    """Idempotent upserts into `objects`.

    ON CONFLICT DO UPDATE, and the ids are deterministic, so running this twice is a refresh
    rather than a doubling — which is the whole reason app/identity.py exists.

    `glb_key` is deliberately left alone on conflict. A row whose mesh Ani has already
    generated must not be reset to NULL because somebody re-ran the catalogue load; the
    dimensions are ours to refresh, the mesh is not.
    """
    at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    lines = [
        "-- Generated by services/ingest/load_catalog.py. Do not edit by hand.",
        f"-- {len(rows)} catalogue objects, generated {at}.",
        "-- Idempotent: deterministic ids + ON CONFLICT DO UPDATE, so re-running refreshes.",
        "-- glb_key is NOT reset on conflict — a generated mesh survives a catalogue reload.",
        "",
    ]
    for r in rows:
        bbox, measure = r["bboxMeters"], r["measure"]
        price = r.get("price") or {}
        lines.append(
            "INSERT INTO objects (id, source, state, name, category, glb_key, "
            "bbox_w, bbox_h, bbox_d, measure_method, measure_confidence, "
            "caption, palette_json, price_cents, currency, product_url, merchant, created_at) VALUES ("
            f"{sql_str(r['objectId'])}, 'catalog', 'measured', {sql_str(r['name'])}, "
            f"{sql_str(r['category'])}, NULL, "
            f"{sql_str(bbox['w'])}, {sql_str(bbox['h'])}, {sql_str(bbox['d'])}, "
            f"{sql_str(measure.get('method') or 'extracted')}, {sql_str(measure.get('confidence'))}, "
            f"NULL, NULL, {sql_str(price.get('cents'))}, {sql_str(price.get('currency'))}, "
            f"{sql_str(r['productUrl'])}, {sql_str(r['merchant'])}, {sql_str(at)}) "
            "ON CONFLICT(id) DO UPDATE SET "
            "name = excluded.name, category = excluded.category, "
            "bbox_w = excluded.bbox_w, bbox_h = excluded.bbox_h, bbox_d = excluded.bbox_d, "
            "measure_method = excluded.measure_method, "
            "measure_confidence = excluded.measure_confidence, "
            "price_cents = excluded.price_cents, currency = excluded.currency, "
            "product_url = excluded.product_url, merchant = excluded.merchant;"
        )
    path = os.path.join(out, "catalog.d1.sql")
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def write_r2_script(rows: list[dict], out: str, bucket: str, base: str) -> tuple[str, int]:
    """One `wrangler r2 object put` per image, from disk where we have the file and from the
    CDN url where we do not.

    A shell script rather than an API loop for the same reason as the SQL: it is readable
    before it runs, re-runnable after a failure, and it needs no credentials to generate. It
    is `set -u` but deliberately NOT `set -e` — one 404 on a merchant's CDN should not abandon
    the other 99 uploads. Failures are counted and the script exits non-zero at the end.
    """
    lines = [
        "#!/usr/bin/env bash",
        "# Generated by services/ingest/load_catalog.py. Do not edit by hand.",
        "#",
        "# Uploads catalogue source images to R2 under the contracts.md key layout,",
        "# catalog/{merchant}/{productId}/source.jpg. Re-running overwrites, which is safe.",
        "#",
        "# Needs wrangler authenticated: run `npx wrangler login` from workers/ first.",
        "#",
        "# Not `set -e`: one merchant's dead CDN link should not abandon the rest of the",
        "# batch. Failures are counted and reported, and the script exits non-zero if any.",
        "set -uo pipefail",
        "",
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        f'INGEST_DIR="{base}"',
        f'BUCKET="{bucket}"',
        'WRANGLER_DIR="$INGEST_DIR/../../workers"',
        "",
        'if [ ! -d "$WRANGLER_DIR/node_modules" ]; then',
        '  echo "ERROR: workers/node_modules missing. Run npm install in workers/ first." >&2',
        "  exit 1",
        "fi",
        "",
        "fail=0",
        "ok=0",
        "",
        "put_local() {",
        '  if [ ! -f "$2" ]; then',
        '    echo "MISS  $1 (no file at $2)" >&2; fail=$((fail + 1)); return',
        "  fi",
        '  if ( cd "$WRANGLER_DIR" && npx wrangler r2 object put "$BUCKET/$1" \\',
        '        --file "$2" --content-type image/jpeg --remote >/dev/null 2>&1 ); then',
        '    ok=$((ok + 1)); echo "ok    $1"',
        "  else",
        '    fail=$((fail + 1)); echo "FAIL  $1" >&2',
        "  fi",
        "}",
        "",
        "put_remote() {",
        '  tmp="$(mktemp)"',
        '  if ! curl -fsSL --max-time 60 "$2" -o "$tmp"; then',
        '    echo "MISS  $1 (fetch failed: $2)" >&2; fail=$((fail + 1)); rm -f "$tmp"; return',
        "  fi",
        '  put_local "$1" "$tmp"',
        '  rm -f "$tmp"',
        "}",
        "",
    ]
    n = 0
    for r in rows:
        key = r.get("r2Key")
        if not key:
            continue
        if r.get("localImage"):
            lines.append(f'put_local "{key}" "$INGEST_DIR/{r["localImage"]}"')
            n += 1
        elif r.get("imageUrl"):
            lines.append(f'put_remote "{key}" "{r["imageUrl"]}"')
            n += 1
    lines += [
        "",
        'echo',
        'echo "uploaded $ok, failed $fail"',
        'if [ "$fail" -gt 0 ]; then',
        '  echo "Re-run this script to retry the failures; overwriting is safe." >&2',
        "  exit 1",
        "fi",
    ]
    path = os.path.join(out, "r2-upload.sh")
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    os.chmod(path, 0o755)
    return path, n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="prebake/manifest.json, or an .ndjson of Object v1 rows")
    ap.add_argument("--out", default=".load", help="directory for the generated files")
    ap.add_argument("--bucket", default=DEFAULT_BUCKET, help=f"R2 bucket (default {DEFAULT_BUCKET})")
    ap.add_argument("--db", default=DEFAULT_DB, help=f"D1 database (default {DEFAULT_DB})")
    args = ap.parse_args()

    base = os.path.dirname(os.path.abspath(__file__))
    rows = load_rows(args.input)
    if not rows:
        print(f"ERROR: {args.input} produced no rows.", file=sys.stderr)
        return 1

    # A duplicate id inside one batch means two products resolved to the same identity. The
    # SQL would still apply — last one wins — but silently, and that is the wrong way to find
    # out that a merchant lists the same URL twice.
    seen: dict[str, str] = {}
    dupes = []
    for r in rows:
        prior = seen.get(r["objectId"])
        if prior:
            dupes.append((r["objectId"], prior, r.get("productUrl")))
        seen[r["objectId"]] = r.get("productUrl") or r.get("name") or "?"
    if dupes:
        print(f"WARNING: {len(dupes)} duplicate object ids within this batch:", file=sys.stderr)
        for oid, a, b in dupes[:5]:
            print(f"  {oid}\n    {a}\n    {b}", file=sys.stderr)

    os.makedirs(args.out, exist_ok=True)
    sql_path = write_sql(rows, args.out)
    r2_path, n_images = write_r2_script(rows, args.out, args.bucket, base)

    no_price = sum(1 for r in rows if not (r.get("price") or {}).get("cents"))
    # Print a path the reader can paste. relpath is right when --out is inside the service
    # directory (the normal case) and turns into a ladder of "../.." when it is not, so fall
    # back to the absolute path rather than printing something nobody can use.
    rel = os.path.relpath(args.out, base)
    if rel.startswith(".."):
        rel = os.path.abspath(args.out)
    print(f"{len(rows)} objects, {n_images} images")
    if no_price:
        print(f"  {no_price} of them carry no price — invisible to the maxPriceCents filter")
    print(f"  {sql_path}")
    print(f"  {r2_path}")
    print()
    print("Then, from a machine that can reach Cloudflare:")
    print(f"  bash {os.path.join(rel, 'r2-upload.sh')}")
    sql_arg = os.path.join(rel, "catalog.d1.sql")
    if not os.path.isabs(sql_arg):
        sql_arg = f"../services/ingest/{sql_arg}"
    print(f"  cd ../../workers && npx wrangler d1 execute {args.db} --remote --file {sql_arg}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
