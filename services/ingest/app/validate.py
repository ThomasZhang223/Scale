"""Steps 4 and 5 of the extraction pipeline: validation, then a confidence score.

Steps 1–3 answer "what number is on the page". These answer "should we believe it", which is
the part the Rox rubric rewards and the difference between an agent and a scraper. A number
that survives here carries a score; one that does not is flagged rather than dropped, so the
UI can say "unverified fit" instead of showing a confident wrong box.

Three checks, cheapest first:

  1. Unit sanity   — a sofa is not 8 cm wide, whatever the page said.
  2. Category priors — a dining chair is 40–50 cm, so 4 m is a parse error not a chair.
  3. Axis plausibility — a wardrobe deeper than it is tall usually means W and D were swapped.

Metres throughout (CLAUDE.md standing rule 1).
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Plausible metre ranges per category, (min, max) on each axis. Deliberately generous: this
# catches parse errors and unit mistakes, not unusual furniture. Narrowing it to reject real
# products would trade a visible failure for an invisible one.
CATEGORY_PRIORS: dict[str, dict[str, tuple[float, float]]] = {
    "chair":     {"w": (0.30, 0.95), "h": (0.55, 1.40), "d": (0.30, 1.00)},
    "stool":     {"w": (0.25, 0.70), "h": (0.35, 0.90), "d": (0.25, 0.70)},
    "sofa":      {"w": (1.10, 4.00), "h": (0.55, 1.30), "d": (0.60, 1.30)},
    # An L-shape's bounding box has to contain the arm that sticks out, so its "depth" is the
    # length of that arm and not the seat depth — a real Aspen 157" 6-piece measures
    # 3.96 x 2.97 x 0.86 m. Judged against the sofa prior, every correctly measured sectional
    # Poly & Bark sells came back flagged at confidence 0.488, just under the 0.5 threshold,
    # so accurate rows ranked below worse-measured ones. Height stays a sofa's: an L-shape is
    # wider and deeper than a sofa, never taller.
    "sectional": {"w": (1.50, 4.60), "h": (0.55, 1.30), "d": (0.60, 3.60)},
    "bench":     {"w": (0.60, 2.40), "h": (0.30, 0.70), "d": (0.25, 0.70)},
    "table":     {"w": (0.30, 3.20), "h": (0.25, 1.25), "d": (0.30, 1.60)},
    "desk":      {"w": (0.60, 2.40), "h": (0.55, 1.30), "d": (0.35, 1.00)},
    "shelf":     {"w": (0.25, 2.60), "h": (0.25, 2.50), "d": (0.15, 0.75)},
    "cabinet":   {"w": (0.30, 2.60), "h": (0.30, 2.40), "d": (0.20, 0.80)},
    "dresser":   {"w": (0.60, 2.20), "h": (0.60, 1.60), "d": (0.35, 0.70)},
    "bed":       {"w": (0.70, 2.20), "h": (0.20, 1.50), "d": (1.70, 2.40)},
    "lamp":      {"w": (0.08, 0.90), "h": (0.15, 2.10), "d": (0.08, 0.90)},
    "rug":       {"w": (0.50, 4.50), "h": (0.00, 0.10), "d": (0.50, 6.00)},
    "mirror":    {"w": (0.20, 1.60), "h": (0.20, 2.20), "d": (0.01, 0.15)},
    "ottoman":   {"w": (0.35, 1.40), "h": (0.25, 0.60), "d": (0.35, 1.00)},
}

# Which prior a merchant's product_type maps to. Substring match, longest wins, same rule the
# demo-category buckets use.
_PRIOR_ALIASES = {
    "chair": "chair", "armchair": "chair", "seating": "chair", "recliner": "chair",
    "stool": "stool", "counter stool": "stool",
    "sofa": "sofa", "couch": "sofa", "loveseat": "sofa", "settee": "sofa",
    # Longest alias wins, so "sectional sofa" and "l-shaped sectional" reach the sectional
    # prior rather than the sofa one.
    "sectional": "sectional", "chaise": "sectional", "corner sofa": "sectional",
    "pit lounge": "sectional", "l-shaped": "sectional", "u-shaped": "sectional",
    "bench": "bench",
    "table": "table", "console": "table", "nightstand": "table", "night stand": "table",
    "desk": "desk",
    "shelf": "shelf", "shelv": "shelf", "bookcase": "shelf", "bookshelf": "shelf",
    "cabinet": "cabinet", "credenza": "cabinet", "sideboard": "cabinet", "storage": "cabinet",
    "dresser": "dresser", "chest": "dresser", "wardrobe": "dresser",
    "bed": "bed", "mattress": "bed",
    "lamp": "lamp", "sconce": "lamp", "pendant": "lamp", "lantern": "lamp",
    "chandelier": "lamp", "light": "lamp",
    "rug": "rug", "carpet": "rug",
    "mirror": "mirror",
    "ottoman": "ottoman", "pouf": "ottoman", "footstool": "ottoman",
}

# Anything outside this is not furniture at any scale — a parse error, not a product.
ABSOLUTE_M = (0.02, 5.0)

# What each extraction surface is worth before validation. json_ld is self-describing, so the
# axis cannot be guessed wrong; page_text is the whole page and full of other numbers.
BASE_CONFIDENCE = {
    "json_ld": 0.90,
    "spec_block": 0.80,
    "variant.title": 0.70,
    "body_html": 0.65,
    "title": 0.55,
    "page_text": 0.40,
}


@dataclass
class Verdict:
    ok: bool
    confidence: float
    flags: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def unverified(self) -> bool:
        """Below this the UI says "unverified fit" rather than showing a number as fact."""
        return self.confidence < 0.5


def _best_alias(text: str) -> str | None:
    """Longest matching alias in one string, or None. Longest so "bookcase" beats a stray
    substring and "sectional" beats "sofa"."""
    best, best_len = None, 0
    for alias, prior_key in _PRIOR_ALIASES.items():
        if alias in text and len(alias) > best_len:
            best, best_len = prior_key, len(alias)
    return best


def prior_for(category: str | None, title: str = "") -> tuple[str, dict] | tuple[None, None]:
    """Which prior to judge a product by, from its product_type and its title.

    The title wins when both match, because a product_type is frequently a COLLECTION name
    covering several kinds of thing while a title names one product. Two real cases from Poly
    & Bark, both of which flagged correct measurements before this:

      "Modular Sofas" + "Aspen 157\" 6-Piece L-Shaped Sectional"
          -> sectional, not sofa. An L-shape is 2.97 m deep and a sofa prior stops at 1.30.
      "Benches, Stools & Ottomans" + "Este Bench"
          -> bench, not ottoman. That product_type holds three categories and the longest
             alias in it is "ottoman", whose 1.40 m width ceiling a 1.41 m bench just misses.

    This was an `or` before, so a non-empty product_type meant the title was never read at
    all. The fallback direction still holds — 101 products on a real run had an empty
    product_type and the title is all there is.
    """
    from_title = _best_alias((title or "").lower())
    if from_title:
        return from_title, CATEGORY_PRIORS[from_title]
    from_category = _best_alias((category or "").lower())
    if from_category:
        return from_category, CATEGORY_PRIORS[from_category]
    return None, None


def validate(bbox: dict, *, category: str | None = None, title: str = "",
             source_field: str = "body_html") -> Verdict:
    """Score a bbox. Never mutates it — a validator that quietly corrects data is a liar."""
    if not bbox or any(bbox.get(a) is None for a in ("w", "h", "d")):
        return Verdict(False, 0.0, ["incomplete"], ["needs all three axes"])

    confidence = BASE_CONFIDENCE.get(source_field.split(":")[0], 0.5)
    flags: list[str] = []
    notes: list[str] = []

    # 1. Unit sanity. Almost always a missed unit conversion rather than an odd product.
    lo, hi = ABSOLUTE_M
    for axis in ("w", "h", "d"):
        v = bbox[axis]
        if not (lo <= v <= hi):
            return Verdict(False, 0.0, ["unit_sanity"],
                           [f"{axis}={v} m is outside {lo}-{hi} m — a unit mistake, not a product"])

    # 2. Category priors.
    name, prior = prior_for(category, title)
    if prior is None:
        flags.append("no_prior")
        notes.append("no category prior to check against")
        confidence *= 0.9
    else:
        out = [f"{a}={bbox[a]:.2f} m outside {prior[a][0]}-{prior[a][1]} m"
               for a in ("w", "h", "d") if not (prior[a][0] <= bbox[a] <= prior[a][1])]
        if not out:
            confidence = min(1.0, confidence + 0.10)
            notes.append(f"agrees with the {name} prior on all three axes")
        else:
            # One axis out is often a real variant; all three means the parse is wrong.
            confidence *= 0.75 if len(out) == 1 else 0.45
            flags.append("prior_mismatch")
            notes.append(f"{name} prior: " + "; ".join(out))

    # 3. Axis plausibility. Deeper than tall and wider is the signature of swapped W and D,
    #    which reads as plausible furniture and places completely wrong.
    if bbox["d"] > bbox["w"] and bbox["d"] > bbox["h"] and name not in ("bed", "rug", None):
        flags.append("axis_suspect")
        notes.append("depth exceeds both width and height — W and D may be swapped")
        confidence *= 0.8

    confidence = round(max(0.0, min(1.0, confidence)), 3)
    return Verdict(ok=True, confidence=confidence, flags=flags, notes=notes)
