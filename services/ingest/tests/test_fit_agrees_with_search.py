"""app/fit.py must answer exactly what services/search answers.

Run: python3 tests/test_fit_agrees_with_search.py

Fit is a dimensional rule, and this project's whole claim is true scale. Two fit rules that
drift apart is the same failure as two places rescaling a mesh: nobody notices until a sofa is
offered for a gap it cannot go in, on stage.

The two services deploy as separate images and cannot import each other at runtime, so the
function is duplicated. This test is what makes that safe — it imports both implementations
from the repo and runs them over the same table. Change one and this fails.
"""

import sys, pathlib, itertools

HERE = pathlib.Path(__file__).resolve()
INGEST = HERE.parents[1]
SEARCH = INGEST.parent / "search"
sys.path.insert(0, str(INGEST))

from app.fit import fit_bounds_mm as ingest_bounds, passes_fit as ingest_passes

sys.path.insert(0, str(SEARCH))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "search_ranking", SEARCH / "app" / "ranking.py")
search_ranking = importlib.util.module_from_spec(spec)
sys.modules["search_ranking"] = search_ranking
spec.loader.exec_module(search_ranking)


class _C:
    """The shape search's passes_fit reads: millimetre attributes."""
    def __init__(self, w, h, d):
        self.w_mm, self.h_mm, self.d_mm = w, h, d


FITS = [
    None,
    {"maxW": 0.8},
    {"maxW": 0.8, "maxH": 1.2},
    {"maxW": 0.8, "maxH": 1.2, "maxD": 0.5},
    {"maxW": 2.0, "maxD": 0.9},
    {"maxW": 0.7999},
]

BBOXES = [
    {"w": 0.8, "h": 1.0, "d": 0.4},      # exactly on a bound
    {"w": 0.79, "h": 1.19, "d": 0.49},
    {"w": 0.81, "h": 1.0, "d": 0.4},     # one axis over
    {"w": 0.5, "h": 2.0, "d": 0.4},
    {"w": 1.52, "h": 0.74, "d": 0.76},
]


def test_the_two_services_compute_identical_bounds():
    for fit, relax in itertools.product(FITS, (0.0, 0.1, 0.25)):
        mine = ingest_bounds(fit, relax)
        theirs = search_ranking.fit_bounds_mm(fit, relax)
        # Search keys by w_mm/h_mm/d_mm, ingest by w/h/d — same numbers, named for what each
        # one holds. Compare the values.
        mine_v = None if mine is None else sorted(mine.items())
        theirs_v = None if theirs is None else sorted(
            (k.replace("_mm", ""), v) for k, v in theirs.items())
        assert mine_v == theirs_v, f"fit={fit} relax={relax}: {mine_v} vs {theirs_v}"


def test_the_two_services_agree_on_every_pass_or_fail():
    for fit, bbox in itertools.product(FITS, BBOXES):
        bounds_mine = ingest_bounds(fit)
        bounds_theirs = search_ranking.fit_bounds_mm(fit)
        mine = ingest_passes(bbox, bounds_mine)
        theirs = search_ranking.passes_fit(
            _C(int(round(bbox["w"] * 1000)), int(round(bbox["h"] * 1000)),
               int(round(bbox["d"] * 1000))),
            bounds_theirs)
        assert mine is theirs, f"fit={fit} bbox={bbox}: ingest={mine} search={theirs}"


def test_both_refuse_the_same_nonsense_units():
    """80 instead of 0.8 is centimetres that escaped a UI edge. Refusing beats filtering
    nothing, in both services, with the same threshold."""
    for bad in ({"maxW": 80}, {"maxH": 0}, {"maxD": -1}, {"maxW": 20.1}):
        for fn in (ingest_bounds, search_ranking.fit_bounds_mm):
            try:
                fn(bad)
            except ValueError:
                continue
            raise AssertionError(f"{fn.__module__}.{fn.__name__} accepted {bad}")


def test_an_unmeasured_object_never_passes_a_fit_filter():
    """Only ingest can see this case — search's candidates always carry a bbox — so it is
    asserted here alone. "Probably fine" about an unmeasured object is the one answer this
    pipeline must never give."""
    bounds = ingest_bounds({"maxW": 0.8})
    assert ingest_passes(None, bounds) is False
    assert ingest_passes({"w": None, "h": 1.0, "d": 0.4}, bounds) is False
    # With no filter asked for, an unmeasured object is not excluded by fit.
    assert ingest_passes(None, None) is True


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"PASS {name}")
            except Exception as e:
                print(f"FAIL {name}: {type(e).__name__}: {e}"); fails += 1
    print(f"\n{fails} failed")
    sys.exit(1 if fails else 0)
