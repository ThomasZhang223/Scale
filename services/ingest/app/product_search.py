"""Prompt -> candidate products, using the merchant's own search page.

The pipeline was merchant-driven: crawl a whole catalogue, extract everything, curate. That
pre-generates assets fine, but it cannot answer "find me a red chair" live. This module is the
missing front half; everything behind it — dimensions, rendered pages, validation — is reused
untouched.

Why the search PAGE and not a filter over /products.json: the merchant already solved
relevance. Their search knows "sectional" is a sofa and that a product called "Cloud" is a
chair, which title matching never will. Rendering it through Browserbase also means stores
whose search is client-side JavaScript work the same as ones that render server-side — the
same reason step 2.5 exists.

What comes back is an ORDER, not a set. A search results page lists its best match first, and
that ordering is the merchant's relevance ranking, free. Preserve it.

ceiling: one search page per merchant per query, so no pagination — the first page of results
is 20-50 products and a demo picks from the top handful. Pagination would mean following
?page=2 links and is not worth it until someone asks for result 60.
"""

from __future__ import annotations

import re
from urllib.parse import quote_plus, urlsplit

from bs4 import BeautifulSoup

# Both shapes Shopify themes use, with anything after the handle (?variant=, #frag) dropped.
# Handles are lowercase alphanumeric and hyphens by Shopify's own rules.
_PRODUCT_HREF = re.compile(
    r"/(?:collections/[a-z0-9\-_%]+/)?products/([a-z0-9][a-z0-9\-_]*)", re.IGNORECASE
)

# The whole path-ish token around a /products/ hit, used by the JSON fallback below. Matching
# only the /products/<handle> fragment there would strip the very prefix the exclusion list
# needs to see, so /cart/products/x came back as the product "x".
_PRODUCT_PATH = re.compile(r"[^\s\"'<>\\]*/products/[a-z0-9][a-z0-9\-_]*", re.IGNORECASE)

# Links a results page carries that are not results.
_NOT_A_RESULT = ("/cart", "/account", "/checkout", "/policies", "/blogs")


# Filler an utterance carries that a merchant's search engine only gets worse for seeing.
# Deictics ("there", "here") and imperatives ("add", "put") describe the PLACEMENT, which the
# solver owns — they say nothing about the product.
#
# Deliberately not an LLM. The voice agent's first pass already turns an utterance into a
# structured intent with a clean `text` field, and that is where intent becomes an objective
# (CLAUDE.md rule 3). A second model here would be a second place to be wrong, on a live path,
# for a job a word list does exactly. This is a safety net for direct callers, not the primary
# route.
_FILLER = frozenset("""
a an the some any my me i we you it this that these those there here
add put place get find show me bring stick drop set need want looking look
can could would will please just like really actually maybe
for with of to in on at
new nice good something anything thing stuff one
""".split())


def normalise_query(text: str) -> str:
    """Light hygiene on a query, not intent parsing. "add a red chair" -> "red chair".

    Separating the product from the place is NOT done here, deliberately. The voice agent
    already does it properly — `find_anchor` takes "beside my desk" and `search_objects` gets
    the product — and a second, worse version of that in this service would be two places
    parsing one utterance, which is how they drift. A caller is expected to pass a query that
    already describes a product. This only drops the imperative and article noise a direct or
    CLI caller might leave on.

    If stripping would leave nothing, the original is returned: a query that finds the wrong
    things beats a query that finds nothing, and a single word like "sofa" must survive.
    """
    words = re.findall(r"[\w'-]+", (text or "").lower())
    kept = [w for w in words if w not in _FILLER]
    return " ".join(kept) if kept else (text or "").strip()


def search_url(storefront_base_url: str, query: str) -> str:
    """The merchant's search results page for this query.

    /search?q= is Shopify's own route and is present on every storefront regardless of theme,
    unlike /search/suggest.json which depends on the theme shipping predictive search.
    """
    if not (query or "").strip():
        raise ValueError("empty search query")  # standing rule 4: never search for nothing
    return f"{storefront_base_url.rstrip('/')}/search?q={quote_plus(query.strip())}"


def handles_from_search_page(html: str, limit: int = 24) -> list[str]:
    """Product handles from a rendered search page, best match first, deduplicated.

    Order is the whole point, so dedupe keeps the FIRST occurrence: a product linked from both
    its image and its title must not be demoted to where its second link appeared.
    """
    if not html:
        return []

    seen: list[str] = []
    found: set[str] = set()

    def take(href: str) -> None:
        if not href or len(seen) >= limit:
            return
        path = urlsplit(href).path or href
        if any(bad in path for bad in _NOT_A_RESULT):
            return
        m = _PRODUCT_HREF.search(path)
        if not m:
            return
        handle = m.group(1).lower()
        if handle not in found:
            found.add(handle)
            seen.append(handle)

    soup = BeautifulSoup(html, "html.parser")
    for a in soup.find_all("a", href=True):
        take(a["href"])

    # Themes that render results from JSON in a <script> put no <a> in the markup at all. Fall
    # back to scanning the raw text rather than reporting a store as having no results, which
    # is the wrong conclusion and indistinguishable from a genuinely empty search.
    if not seen:
        for m in _PRODUCT_PATH.finditer(html):
            take(m.group(0))

    return seen[:limit]


def relevance(query: str, products: list[dict]) -> tuple[int, float]:
    """(how many products match a query word, as a fraction).

    Floyd answers a search for "red chair" with twelve beds: their catalogue has no chairs, so
    the theme falls back to popular products and the results page looks exactly like a real
    one. "red chair" and "bed" returned the same twelve handles in the same order.

    That is the worst kind of wrong — a confident answer to a question nobody asked — so it
    has to be detectable. A results page where NOTHING matches any query word is a fallback,
    not a ranking. Checked against title, product_type and tags, which is where a Shopify
    product says what it is.
    """
    words = {w for w in re.findall(r"[a-z]{3,}", (query or "").lower())}
    if not words or not products:
        return 0, 0.0
    hits = 0
    for p in products:
        haystack = " ".join([
            str(p.get("title") or ""),
            str(p.get("product_type") or ""),
            " ".join(str(x) for x in (p.get("tags") or [])),
        ]).lower()
        if any(w in haystack for w in words):
            hits += 1
    return hits, hits / len(products)


def drop_unplaceable(products: list[dict]) -> list[dict]:
    """Gift cards, samples, swatches, care kits. A search for a chair at Poly & Bark returns
    their gift card first; nothing downstream can make a mesh of it or place it in a room."""
    out = []
    for p in products:
        text = f"{p.get('title') or ''} {p.get('product_type') or ''}".lower()
        if any(w in text for w in _UNPLACEABLE):
            continue
        out.append(p)
    return out


# Kept here rather than imported from verify_merchants: that list is about which demo CATEGORY
# a product belongs to, this one is about whether it is a physical object at all. They overlap
# today and would drift for good reasons tomorrow.
_UNPLACEABLE = (
    "gift card", "e-gift", "sample", "swatch", "care kit", "cleaner", "touch-up",
    "replacement part", "warranty", "protection plan", "assembly service", "delivery",
)


def products_by_handle(catalogue: list[dict], handles: list[str]) -> list[dict]:
    """Full product records for those handles, in the handles' order.

    The search page gives a title, a thumbnail and a link — not variants, not body_html, not
    the image list. Rather than fetching each product again, look the handle up in the
    catalogue this merchant already served: same data, no extra request, and it is the exact
    record shape the extraction pipeline already takes.

    A handle with no catalogue entry is dropped rather than half-filled. A product that
    /products.json does not list is one this pipeline cannot measure anyway.
    """
    by_handle = {(p.get("handle") or "").lower(): p for p in catalogue}
    return [by_handle[h] for h in handles if h in by_handle]
