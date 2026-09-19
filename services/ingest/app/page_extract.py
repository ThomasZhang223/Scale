"""Step 2.5 of the extraction pipeline: dimensions from a rendered product page.

Why this step exists, measured rather than assumed. The first live verification run found four
reachable Shopify stores — Floyd, Fyrn, Bend Goods, Branch Furniture, about 690 products — whose
`/products.json` carries no dimensions at all. Their body_html is marketing copy and the
variants are size NAMES ("Queen", "King"). The data is in metafields, and /products.json does
not serve metafields. It does get rendered into the product page, so that is where we go.

Three sources, best first:

  1. JSON-LD  — schema.org Product with width/height/depth QuantitativeValue. Structured, so
                no guessing about which number is which axis.
  2. Spec blocks — a <table>/<dl>/definition list row whose label says Dimensions.
  3. Full text — the page stripped to text, through the same regex pass as step 1.

Everything returns metres (CLAUDE.md standing rule 1) via app.dimensions, and anything it
cannot determine comes back None rather than guessed (standing rule 4).

SAFETY: page content is untrusted remote input, per Browserbase's own guidance. Nothing here
executes it or treats it as instructions; it is only ever pattern-matched. If an LLM pass is
added downstream, it must stay on a constrained output schema — a product description is a
place someone can write "ignore previous instructions".
"""

from __future__ import annotations

import json
import re

from bs4 import BeautifulSoup

from .dimensions import DimensionHit, TO_METRES, MIN_M, MAX_M, extract as regex_extract

# schema.org unitCode (UN/CEFACT) and unitText both appear in the wild.
_UNIT_CODES = {
    "CMT": 0.01, "MMT": 0.001, "MTR": 1.0, "INH": 0.0254, "FOT": 0.3048,
}

_DIMENSION_LABEL = re.compile(
    r"\b(dimension|dimensions|size|measurements|product\s+size|overall)\b", re.IGNORECASE
)

# Fetch does not execute JavaScript, so a client-rendered spec section comes back as its
# template. Floyd's pages return blocks reading "${ product.selectedOptions[0] }" — matching
# those wastes the spec-block pass on placeholders. A store whose specs are ONLY templates
# needs `browse open --remote`, not Fetch.
_TEMPLATE_PLACEHOLDER = re.compile(r"\$\{[^}]*\}|\{\{[^}]*\}\}|\[\[[^\]]*\]\]")


def _is_unrendered_template(text: str) -> bool:
    stripped = _TEMPLATE_PLACEHOLDER.sub("", text).strip()
    return not stripped or len(stripped) < max(8, len(text) * 0.3)


def _loads_tolerant(raw: str):
    """json.loads, then two fallbacks for the malformed blobs real themes ship.

    Floyd serves two ld+json blocks per page and both fail a strict parse. Skipping them loses
    the one source where the axis is unambiguous, so it is worth trying harder before giving up.
    """
    raw = raw.strip()
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        pass
    # Trailing commas before a close brace/bracket.
    cleaned = re.sub(r",\s*([}\]])", r"\1", raw)
    try:
        return json.loads(cleaned)
    except ValueError:
        pass
    # Several concatenated top-level objects: decode them one at a time and keep what parses.
    decoder = json.JSONDecoder()
    out, idx = [], 0
    while idx < len(cleaned):
        try:
            obj, end = decoder.raw_decode(cleaned, idx)
        except ValueError:
            idx += 1
            continue
        out.append(obj)
        idx = end
    return out or None


def _metres_from_quantitative(node) -> float | None:
    """schema.org QuantitativeValue -> metres. Accepts a bare number only with a unit."""
    if node is None:
        return None
    if isinstance(node, (int, float)):
        return None  # a number with no unit is not a measurement (standing rule 4)
    if isinstance(node, str):
        return None
    if isinstance(node, list):
        for item in node:
            got = _metres_from_quantitative(item)
            if got is not None:
                return got
        return None
    if not isinstance(node, dict):
        return None

    value = node.get("value", node.get("Value"))
    if value is None:
        return None
    try:
        value = float(str(value).replace(",", "."))
    except ValueError:
        return None

    code = str(node.get("unitCode") or "").strip().upper()
    factor = _UNIT_CODES.get(code)
    if factor is None:
        text = str(node.get("unitText") or "").strip().lower()
        factor = TO_METRES.get(text)
    if factor is None:
        return None

    metres = value * factor
    return metres if MIN_M <= metres <= MAX_M else None


def from_json_ld(html: str) -> DimensionHit | None:
    """schema.org Product width/height/depth. The only source where the axis is unambiguous."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = tag.string or tag.get_text() or ""
        data = _loads_tolerant(raw)
        if data is None:
            continue

        # @graph, arrays, and single objects all occur.
        nodes = data if isinstance(data, list) else [data]
        if isinstance(data, dict) and isinstance(data.get("@graph"), list):
            nodes = data["@graph"]

        for node in nodes:
            if not isinstance(node, dict):
                continue
            types = node.get("@type")
            types = types if isinstance(types, list) else [types]
            if not any(str(t).lower() == "product" for t in types if t):
                continue

            w = _metres_from_quantitative(node.get("width"))
            h = _metres_from_quantitative(node.get("height"))
            d = _metres_from_quantitative(node.get("depth"))
            if w is None and h is None and d is None:
                continue
            complete = None not in (w, h, d)
            return DimensionHit(
                w=w, h=h, d=d,
                method="json_ld",
                # Structured and self-describing, so it outranks anything parsed from prose.
                confidence=0.9 if complete else 0.5,
                source_field="json_ld",
                raw=f"w={w} h={h} d={d}",
            )
    return None


def _spec_texts(html: str) -> list[str]:
    """Text of blocks that announce themselves as dimensions — table rows, definition lists,
    and the accordion sections Shopify themes favour."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[str] = []

    for row in soup.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in row.find_all(["th", "td"])]
        if cells and _DIMENSION_LABEL.search(cells[0]):
            out.append(" ".join(cells[1:]) or cells[0])

    for dt in soup.find_all("dt"):
        if _DIMENSION_LABEL.search(dt.get_text(" ", strip=True)):
            dd = dt.find_next_sibling("dd")
            if dd:
                out.append(dd.get_text(" ", strip=True))

    # <summary>Dimensions</summary> inside <details>, and headings followed by a block.
    for tag in soup.find_all(["summary", "h2", "h3", "h4", "strong", "span"]):
        label = tag.get_text(" ", strip=True)
        if not label or len(label) > 40 or not _DIMENSION_LABEL.search(label):
            continue
        parent = tag.parent
        if parent is not None:
            text = parent.get_text(" ", strip=True)
            if text and text != label:
                out.append(text)

    return out


def from_spec_block(html: str) -> DimensionHit | None:
    """A labelled spec row. More trustworthy than page prose, less than JSON-LD."""
    for text in _spec_texts(html):
        if _is_unrendered_template(text):
            continue  # a placeholder, not a spec — the page renders this client-side
        hit = regex_extract({"title": "", "body_html": text, "variants": [], "options": []})
        if hit is None:
            continue
        hit.method = f"spec_block:{hit.method}"
        hit.source_field = "spec_block"
        # A block that says "Dimensions" is a stronger signal than the same numbers in prose.
        hit.confidence = min(0.85, hit.confidence + 0.15)
        return hit
    return None


def from_full_text(html: str) -> DimensionHit | None:
    """Last resort: the whole page as text, through the step-1 regex.

    ceiling: a page mentions many numbers — shipping sizes, mattress thickness, related
    products — so this is the weakest source and its confidence says so. Prefer the two above.
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))
    hit = regex_extract({"title": "", "body_html": text, "variants": [], "options": []})
    if hit is None:
        return None
    hit.method = f"page_text:{hit.method}"
    hit.source_field = "page_text"
    hit.confidence = min(hit.confidence, 0.4)
    return hit


def extract_from_page(html: str) -> DimensionHit | None:
    """Best available hit for one rendered product page, or None.

    Stops at the first source that yields all three axes; otherwise keeps the most confident
    partial, so a page with only a height still contributes something for step 4 to work with.
    """
    best: DimensionHit | None = None
    for source in (from_json_ld, from_spec_block, from_full_text):
        hit = source(html)
        if hit is None:
            continue
        if hit.as_bbox() is not None:
            return hit
        if best is None or hit.confidence > best.confidence:
            best = hit
    return best


def product_url(storefront_base_url: str, handle: str) -> str:
    """Shopify product pages are always /products/<handle>, so no crawl is needed to find them —
    /products.json already gave us the handle."""
    if not handle:
        raise ValueError("product has no handle; cannot build its page URL")  # standing rule 4
    return f"{storefront_base_url.rstrip('/')}/products/{handle}"
