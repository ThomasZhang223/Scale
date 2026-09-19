"""The one place a catalogue product becomes an objectId.

Why this exists: `_object_v1` used to mint `uuid.uuid4()` per call, so the same product got a
new id on every extraction. The Worker's IngestMerchantWorkflow writes rows with
`INSERT ... ON CONFLICT(id) DO UPDATE` and its comment says "the service mints the id, so a
re-run of this step upserts rather than duplicating" — with a random id that conflict clause
can never fire, and a second run of a merchant appends a full duplicate catalogue to D1
instead of refreshing it. At 100+ products and a pre-demo re-run, that is a silently doubled
catalogue and a search index full of twins.

The fix is an id derived from what the product *is* rather than from when we looked at it.

Identity is the product URL, not the merchant name. A storefront URL already carries the
domain, so it is globally unique without any naming convention, and it survives the merchant
label changing between callers — `build_prebake.py` slugs it ("Floyd_Home"), the Worker passes
whatever the ScoutAgent was given ("floyd"). Keying on the label would have given the same
product two ids depending on who asked, which is the bug this module exists to prevent.

ceiling: one row per product, not per variant. A sofa sold in three fabrics is one object with
one set of dimensions, which is right for fit and wrong for price — the row carries the first
variant's price. Per-variant rows need the variant id in the key below and a price column that
knows which variant it came from.
"""

from __future__ import annotations

import uuid
from urllib.parse import urlsplit

# A fixed namespace, so the same product maps to the same id on every machine and every run.
# Generated once and pasted here; never regenerate it, or every existing row orphans.
NAMESPACE = uuid.UUID("6f2a4c8e-1d3b-4f27-9a56-0c7e8b1d4a90")


def canonical_product_key(
    merchant: str | None,
    product_url: str | None,
    product_id: str | int | None = None,
    handle: str | None = None,
) -> str:
    """The stable string a product's id is derived from.

    Prefers the product URL because it is globally unique on its own. Falls back to the
    merchant label plus the storefront's own product id, which is unique within a merchant.
    """
    if product_url:
        parts = urlsplit(product_url.strip())
        if parts.netloc:
            host = parts.netloc.lower()
            if host.startswith("www."):
                host = host[4:]
            path = parts.path.rstrip("/")
            # Query and fragment are tracking, not identity: the same product arrives as
            # ?variant=123 and #reviews from different surfaces.
            return f"{host}{path}"

    label = (merchant or "").strip().lower()
    tail = str(product_id or "").strip() or (handle or "").strip().lower()
    if label and tail:
        return f"{label}|{tail}"

    # Standing rule 4: never substitute a default. A row with no stable identity would be
    # re-inserted as a new object on every run, which is the exact failure this module
    # prevents — so it is an error, not a random uuid.
    raise ValueError(
        "cannot derive a stable product key: need a productUrl, or a merchant plus a "
        f"product id/handle (got merchant={merchant!r}, url={product_url!r}, "
        f"id={product_id!r}, handle={handle!r})"
    )


def object_id(
    merchant: str | None,
    product_url: str | None,
    product_id: str | int | None = None,
    handle: str | None = None,
) -> str:
    """Deterministic Object v1 id. Same product, same id, on every run and every machine."""
    return str(uuid.uuid5(NAMESPACE, canonical_product_key(merchant, product_url, product_id, handle)))
