"""Does a measured object fit the space the caller asked about?

Two use cases want different things from a search. Someone browsing for a red chair wants
every red chair. Someone telling an agent to put one in the 80 cm gap beside their desk wants
only the ones that go there — and that check can only happen AFTER measurement, which is here,
not at /find where nothing has a size yet.

**This mirrors services/search/app/ranking.py on purpose, and the two must never disagree.**
Search filters objects already in the index; this filters ones being measured for the first
time. They are separate services with separate images, so the function is duplicated rather
than imported — but tests/test_fit_agrees_with_search.py imports both and asserts identical
answers over a table of cases. If someone changes one, that test fails. Fit is a dimensional
rule, and a project whose whole claim is true scale cannot afford two of them.
"""

from __future__ import annotations

MAX_PLAUSIBLE_M = 20.0


def fit_bounds_mm(fit: dict | None, relax: float = 0.0) -> dict | None:
    """{maxW, maxH, maxD} in metres -> integer millimetre ceilings.

    The single metres->mm conversion in this service. `relax` widens every bound by that
    fraction, matching the relaxed fallback search uses.
    """
    if not fit:
        return None
    out: dict[str, int] = {}
    for key, axis in (("maxW", "w"), ("maxH", "h"), ("maxD", "d")):
        if fit.get(key) is None:
            continue
        metres = float(fit[key])
        if metres <= 0:
            raise ValueError(f"fit.{key} must be positive metres, got {metres!r}")
        if metres > MAX_PLAUSIBLE_M:
            # Almost certainly centimetres or millimetres that escaped a UI edge. Refuse rather
            # than silently filter nothing (standing rule 4).
            raise ValueError(f"fit.{key}={metres} m is not a room dimension — check the units")
        out[axis] = int(round(metres * 1000 * (1 + relax)))
    return out or None


def passes_fit(bbox: dict | None, bounds: dict | None) -> bool:
    """Strict: the object's measured footprint must fit inside the space.

    ceiling: no rotation, matching search. An object 0.9 m wide and 0.4 m deep is rejected for
    an 0.8 m gap even though turning it would fit, because for most furniture the wide face is
    the front and turning it is not what the user meant.

    An object with no bbox cannot be shown to fit, so it does not. Saying "probably fine" about
    an unmeasured object is the one answer this pipeline must never give.
    """
    if not bounds:
        return True
    if not bbox:
        return False
    for axis, ceiling in bounds.items():
        value = bbox.get(axis)
        if value is None or int(round(value * 1000)) > ceiling:
            return False
    return True
