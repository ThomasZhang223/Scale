"""Hybrid ranking: style by similarity, fit by integer range. See ../RANKING.md.

The one rule: style and fit are two halves of the query and never mix. Fit filters FIRST, and
style ranks within what survives — not the other way round. A vector term that encodes size
returns things that look right and do not fit, which is the exact failure the product exists to
prevent.

Pure functions, no I/O, no index client. Everything here is testable without Vectorize, which
is also the documented fallback path (RANKING.md, "Cut Vectorize").

Metres in the request (CLAUDE.md standing rule 1), millimetres in the index metadata, and the
conversion happens in one place: fit_bounds_mm().
"""

from __future__ import annotations

from dataclasses import dataclass, field

# RANKING.md: never return an empty result set on stage. Widen the fit filter by this much and
# label what comes back, because a slightly-off result beats an empty screen in front of a judge.
RELAX_FACTOR = 0.10

# Style weights. Cosine carries the query; colour is the "matches its wood tone" half; the
# confidence term is a tiebreaker, not a ranking signal — it only decides between near-equals.
W_COSINE = 0.70
W_COLOUR = 0.30
W_CONFIDENCE = 0.05

# ΔE76 beyond this is "a different colour" as far as ranking cares.
DELTA_E_CEILING = 60.0


@dataclass
class Candidate:
    """One row as the index returns it. `vector` is optional — a Vectorize query already
    scored it, a brute-force scan has to."""
    object_id: str
    w_mm: int
    h_mm: int
    d_mm: int
    source: str = "catalog"
    category: str | None = None
    dominant_hex: str | None = None
    measure_confidence: float = 0.5
    vector: list[float] | None = None
    object: dict = field(default_factory=dict)


@dataclass
class Scored:
    object_id: str
    score: float
    object: dict
    relaxed: bool = False
    components: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Fit: an integer range filter, and nothing else
# ---------------------------------------------------------------------------

def fit_bounds_mm(fit: dict | None, relax: float = 0.0) -> dict | None:
    """{maxW, maxH, maxD} in metres -> integer millimetre ceilings.

    The single metres->mm conversion in this service. `relax` widens every bound by that
    fraction, which is how the fallback rule is implemented.
    """
    if not fit:
        return None
    out: dict[str, int] = {}
    for key, axis in (("maxW", "w_mm"), ("maxH", "h_mm"), ("maxD", "d_mm")):
        if fit.get(key) is None:
            continue
        metres = float(fit[key])
        if metres <= 0:
            raise ValueError(f"fit.{key} must be positive metres, got {metres!r}")
        if metres > 20:
            # Almost certainly centimetres or millimetres that escaped a UI edge. Refuse rather
            # than silently filter nothing (standing rule 4).
            raise ValueError(f"fit.{key}={metres} m is not a room dimension — check the units")
        out[axis] = int(round(metres * 1000 * (1 + relax)))
    return out or None


def passes_fit(c: Candidate, bounds: dict | None) -> bool:
    """Strict: the object's stored footprint must fit inside the space.

    ceiling: no rotation. An object 0.9 m wide and 0.4 m deep is rejected for an 0.8 m gap even
    though turning it 90 degrees would fit, because for most furniture the wide face is the
    front and turning it is not what the user meant. A rotation-aware mode belongs behind an
    explicit flag, not in the default.
    """
    if not bounds:
        return True
    for axis, ceiling in bounds.items():
        if getattr(c, axis) > ceiling:
            return False
    return True


# ---------------------------------------------------------------------------
# Style: cosine, plus colour for "matches its wood tone"
# ---------------------------------------------------------------------------

def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    if len(a) != len(b):
        raise ValueError(f"vector length mismatch: {len(a)} vs {len(b)}")
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _hex_to_rgb(h: str) -> tuple[float, float, float]:
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if len(h) != 6:
        raise ValueError(f"not a hex colour: {h!r}")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def _to_lab(h: str) -> tuple[float, float, float]:
    """sRGB hex -> CIELAB. Wood tones are all brownish, so RGB distance cannot separate them;
    Lab can. ~20 lines and no dependency, which is why it is here rather than a library."""
    r, g, b = _hex_to_rgb(h)
    # sRGB -> linear
    lin = [((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in (r, g, b)]
    # linear -> XYZ (D65)
    x = lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805
    y = lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722
    z = lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505
    # XYZ -> Lab, normalised to the D65 white point
    xn, yn, zn = 0.95047, 1.0, 1.08883
    def f(t: float) -> float:
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = f(x / xn), f(y / yn), f(z / zn)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def colour_similarity(target_hex: str | None, candidate_hex: str | None) -> float | None:
    """1.0 identical, 0.0 unrelated, None when either side has no colour to compare."""
    if not target_hex or not candidate_hex:
        return None
    try:
        l1, a1, b1 = _to_lab(target_hex)
        l2, a2, b2 = _to_lab(candidate_hex)
    except ValueError:
        return None
    delta_e = ((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2) ** 0.5
    return max(0.0, 1.0 - delta_e / DELTA_E_CEILING)


def score_one(c: Candidate, query_vector: list[float] | None, target_hex: str | None) -> Scored:
    """Blend the style signals. Fit is NOT here — it already decided membership."""
    parts: dict[str, float] = {}
    weights = 0.0
    total = 0.0

    if query_vector is not None and c.vector is not None:
        sim = (cosine(query_vector, c.vector) + 1) / 2  # cosine is [-1,1]; scores are [0,1]
        parts["style"] = round(sim, 4)
        total += W_COSINE * sim
        weights += W_COSINE

    col = colour_similarity(target_hex, c.dominant_hex)
    if col is not None:
        parts["colour"] = round(col, 4)
        total += W_COLOUR * col
        weights += W_COLOUR

    # Between two near-identical matches, prefer the one whose dimensions are actually verified.
    # Small on purpose: this is the product's honesty thesis as a tiebreaker, not a ranker.
    conf = max(0.0, min(1.0, c.measure_confidence))
    parts["confidence"] = round(conf, 4)
    total += W_CONFIDENCE * conf
    weights += W_CONFIDENCE

    return Scored(
        object_id=c.object_id,
        score=round(total / weights, 4) if weights else 0.0,
        object=c.object,
        components=parts,
    )


# ---------------------------------------------------------------------------
# The whole query
# ---------------------------------------------------------------------------

def rank(
    candidates: list[Candidate],
    *,
    fit: dict | None = None,
    query_vector: list[float] | None = None,
    target_hex: str | None = None,
    source: str | None = None,
    limit: int = 10,
) -> tuple[list[Scored], bool]:
    """Returns (results, relaxed). Fit filters, style ranks what survives.

    Never returns an empty list when anything could have matched: on an empty fit result the
    bounds widen by RELAX_FACTOR once and every result is flagged `relaxed` so the caller can
    say so out loud (RANKING.md).
    """
    if limit <= 0:
        raise ValueError(f"limit must be positive, got {limit}")

    pool = [c for c in candidates if source is None or c.source == source]

    relaxed = False
    bounds = fit_bounds_mm(fit)
    kept = [c for c in pool if passes_fit(c, bounds)]

    if not kept and bounds:
        relaxed = True
        kept = [c for c in pool if passes_fit(c, fit_bounds_mm(fit, RELAX_FACTOR))]

    scored = [score_one(c, query_vector, target_hex) for c in kept]
    for s in scored:
        s.relaxed = relaxed
    # Ties broken by objectId so the same query returns the same order every time — a demo that
    # reshuffles between runs looks broken.
    scored.sort(key=lambda s: (-s.score, s.object_id))
    return scored[:limit], relaxed
