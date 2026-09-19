"""Step 1 of the extraction pipeline: the regex pass. See ../EXTRACTION.md.

Catches roughly 60% of products for almost no cost, and its hit rate per merchant is the
number that decides whether P3 is viable at all (workstreams/paul.md, H4 report).

Everything returned is METRES (CLAUDE.md standing rule 1). Conversion happens here, at ingest,
and never downstream. Nothing in this module guesses: a value it cannot determine comes back
as None so the caller can raise or fall through to step 2 (standing rule 4).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict

# Unit -> metres.
TO_METRES = {
    "mm": 0.001,
    "millimetre": 0.001, "millimeter": 0.001, "millimetres": 0.001, "millimeters": 0.001,
    "cm": 0.01,
    "centimetre": 0.01, "centimeter": 0.01, "centimetres": 0.01, "centimeters": 0.01,
    "m": 1.0, "metre": 1.0, "meter": 1.0, "metres": 1.0, "meters": 1.0,
    "in": 0.0254, "inch": 0.0254, "inches": 0.0254, '"': 0.0254, "”": 0.0254, "″": 0.0254,
    "ft": 0.3048, "foot": 0.3048, "feet": 0.3048, "'": 0.3048, "’": 0.3048,
}

_UNIT_ALT = "|".join(
    sorted((re.escape(u) for u in TO_METRES), key=len, reverse=True)
)
_NUM = r"\d+(?:[.,]\d+)?"

# Label first: "W 60\" x D 30\" x H 29\"", "Width: 152 cm", "Depth - 76cm"
_LABELLED = re.compile(
    rf"\b(?P<label>W|D|H|L|width|depth|height|length)\b\s*[:\-–]?\s*"
    rf"(?P<value>{_NUM})\s*(?P<unit>{_UNIT_ALT})?",
    re.IGNORECASE,
)

# Label last: '15.5" H x 19.75" L x 18.5" W', '50"W x 70"L', '60 in. wide'.
# Found in real catalogues (Sabai, Kohara) and missed entirely by the label-first pattern,
# which is why those stores read as 0% on the first live run.
_LABELLED_SUFFIX = re.compile(
    rf"(?P<value>{_NUM})\s*(?P<unit>{_UNIT_ALT})?\s*"
    rf"(?P<label>W|D|H|L|wide|deep|high|tall|long)\b\.?",
    re.IGNORECASE,
)

# "13-24\"L x 4-7\"W" — a range across a product family, not one product's size. Parsing it
# would invent a dimension, so the field is refused outright (standing rule 4).
_RANGE = re.compile(rf"{_NUM}\s*[-–]\s*{_NUM}\s*(?:{_UNIT_ALT})?\s*(?:W|D|H|L)\b", re.IGNORECASE)

# "152 x 76 x 74 cm", "60\" x 30\"", "60in x 30in x 29in"
_SEQUENCE = re.compile(
    rf"(?P<a>{_NUM})\s*(?P<ua>{_UNIT_ALT})?\s*[x×]\s*"
    rf"(?P<b>{_NUM})\s*(?P<ub>{_UNIT_ALT})?"
    rf"(?:\s*[x×]\s*(?P<c>{_NUM})\s*(?P<uc>{_UNIT_ALT})?)?",
    re.IGNORECASE,
)

_TAG = re.compile(r"<[^>]+>")
_ENTITY = {"&nbsp;": " ", "&quot;": '"', "&amp;": "&", "&#39;": "'", "&rsquo;": "'"}

# A furniture dimension outside this range is a parse error, not a product.
# (Unit sanity is step 4's job proper; this is the cheap guard that stops step 1 emitting
# obvious nonsense like an 8 cm sofa or a 40 m table.)
MIN_M, MAX_M = 0.02, 5.0

LABEL_TO_AXIS = {
    "w": "w", "width": "w",
    "d": "d", "depth": "d", "l": "d", "length": "d",
    "h": "h", "height": "h",
}


@dataclass
class DimensionHit:
    w: float | None
    h: float | None
    d: float | None
    method: str          # "labelled" | "sequence"
    confidence: float
    source_field: str
    raw: str

    def as_bbox(self) -> dict | None:
        """Object v1 bboxMeters, or None when an axis is missing."""
        if self.w is None or self.h is None or self.d is None:
            return None
        return {"w": round(self.w, 4), "h": round(self.h, 4), "d": round(self.d, 4)}

    def to_dict(self) -> dict:
        return asdict(self)


def strip_html(s: str) -> str:
    if not s:
        return ""
    for entity, char in _ENTITY.items():
        s = s.replace(entity, char)
    return _TAG.sub(" ", s)


def _to_metres(value: str, unit: str | None, fallback_unit: str | None) -> float | None:
    unit = (unit or fallback_unit or "").strip().lower()
    factor = TO_METRES.get(unit)
    if factor is None:
        return None  # no unit anywhere: refuse rather than assume (standing rule 4)
    metres = float(value.replace(",", ".")) * factor
    return metres if MIN_M <= metres <= MAX_M else None


def _labelled(text: str, field: str) -> DimensionHit | None:
    if _RANGE.search(text):
        return None  # a range is not a measurement

    found: dict[str, float] = {}
    raw_bits: list[str] = []
    # Prefer whichever convention this merchant uses; a catalogue mixes them only rarely.
    prefix = list(_LABELLED.finditer(text))
    suffix = list(_LABELLED_SUFFIX.finditer(text))
    matches = prefix if len(prefix) >= len(suffix) else suffix
    if not matches:
        return None

    # A trailing unit often applies to every value: "W 152 x D 76 x H 74 cm".
    trailing = next((m.group("unit") for m in reversed(matches) if m.group("unit")), None)

    for m in matches:
        axis = LABEL_TO_AXIS.get(m.group("label").lower())
        if axis is None or axis in found:
            continue
        metres = _to_metres(m.group("value"), m.group("unit"), trailing)
        if metres is None:
            continue
        found[axis] = metres
        raw_bits.append(m.group(0).strip())

    if not found:
        return None
    # All three labelled and parsed is about as good as a regex gets; fewer is a partial.
    confidence = 0.75 if len(found) == 3 else 0.45
    return DimensionHit(
        w=found.get("w"), h=found.get("h"), d=found.get("d"),
        method="labelled", confidence=confidence,
        source_field=field, raw=" ".join(raw_bits)[:120],
    )


def _sequence(text: str, field: str) -> DimensionHit | None:
    if _RANGE.search(text):
        return None
    m = _SEQUENCE.search(text)
    if not m:
        return None
    trailing = m.group("uc") or m.group("ub") or m.group("ua")
    a = _to_metres(m.group("a"), m.group("ua"), trailing)
    b = _to_metres(m.group("b"), m.group("ub"), trailing)
    c = _to_metres(m.group("c"), m.group("uc"), trailing) if m.group("c") else None
    if a is None or b is None:
        return None

    # Convention on Shopify listings is W x D x H when there are three, W x D when two.
    # ceiling: order is assumed, not verified. Step 4's aspect-ratio cross-check against the
    # product photo is what actually catches a transposed pair.
    return DimensionHit(
        w=a, d=b, h=c,
        method="sequence",
        confidence=0.55 if c is not None else 0.3,
        source_field=field, raw=m.group(0).strip()[:120],
    )


def extract(product: dict) -> DimensionHit | None:
    """Best regex hit for one Shopify product, or None.

    Searched in descending order of trustworthiness: an explicit variant title beats prose.
    """
    candidates: list[tuple[str, str]] = []

    for v in product.get("variants") or []:
        if v.get("title") and v["title"].lower() != "default title":
            candidates.append(("variant.title", v["title"]))
    for o in product.get("options") or []:
        for value in o.get("values") or []:
            candidates.append((f"option.{o.get('name', '?')}", str(value)))
    if product.get("body_html"):
        candidates.append(("body_html", strip_html(product["body_html"])))
    if product.get("title"):
        candidates.append(("title", product["title"]))

    best: DimensionHit | None = None
    for field, text in candidates:
        for hit in (_labelled(text, field), _sequence(text, field)):
            if hit is None:
                continue
            if best is None or hit.confidence > best.confidence:
                best = hit
        if best is not None and best.confidence >= 0.75:
            break  # a fully labelled hit is good enough; stop looking
    return best
