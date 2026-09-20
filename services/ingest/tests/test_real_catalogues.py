"""Regression tests against real merchant catalogues, frozen in tests/fixtures/catalogues/.

Every other extraction test uses markup I wrote, which proves only that the regex matches
itself. These lock in measured behaviour on catalogues pulled from live stores, so a pattern
change that breaks a real merchant fails here instead of at H14.

They read fixtures/catalogues/ and NOT ../samples/, which they used to. `verify_merchants.py
--dump` rewrites samples/ on every run and takes whichever 8 products a store serves first, so
the baseline moved underneath the test: a re-run on 2026-09-20 pulled an InStyle sample opening
with rugs and fabric codes rather than its furniture line, usable went 7 -> 2, and this file
reported a fixture swap as an extractor regression. A test that cries wolf when nothing broke
is worse than no test. See fixtures/catalogues/README.md.

Run: python3 tests/test_real_catalogues.py
"""

import json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.dimensions import extract

SAMPLES = ROOT / "tests" / "fixtures" / "catalogues"

# merchant -> (min any-dimension hits, min fully-usable hits) out of 8 sampled.
# Floors, not equalities: improving the extractor should never fail these.
EXPECTED = {
    "Poly___Bark": (8, 8),                      # labelled, metric, complete — the benchmark
    "InStyle_Home__CA_": (6, 3),                # "Dimensions: 34 x 34 in" — often 2-axis only
    "Sabai_Design": (2, 2),                     # '15.5" H x 19.75" L x 18.5" W' — suffix labels
}

# Reachable catalogues that genuinely carry no dimensions in /products.json. Asserted so that
# if one of them ever starts extracting, we find out rather than assuming it cannot.
NO_DIMENSIONS = ["Bend_Goods", "Branch_Furniture__office_", "Floyd_Home", "Fyrn"]


def _measure(name):
    path = SAMPLES / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"{path} — frozen fixtures live here, not in samples/. Copy one over "
            f"deliberately and update EXPECTED in the same commit.")
    products = json.load(open(path))
    hits = [extract(p) for p in products]
    return sum(1 for h in hits if h), sum(1 for h in hits if h and h.as_bbox())


def test_known_good_merchants_still_extract():
    for name, (min_any, min_full) in EXPECTED.items():
        any_, full = _measure(name)
        assert any_ >= min_any, f"{name}: any-dim regressed {min_any} -> {any_}"
        assert full >= min_full, f"{name}: usable regressed {min_full} -> {full}"


def test_suffix_labels_are_what_makes_sabai_work():
    """Sabai was 0% before suffix-label support. Guards the specific pattern."""
    _, full = _measure("Sabai_Design")
    assert full >= 2, "suffix-label matching ('19.75\" L') has regressed"


def test_stores_without_dimensions_are_not_hallucinated():
    for name in NO_DIMENSIONS:
        any_, full = _measure(name)
        assert full == 0, (
            f"{name} has no dimensions in /products.json but the extractor produced {full} "
            f"bboxes — that is invented data, which is the one thing this pipeline must not do"
        )


def test_no_bbox_is_ever_physically_absurd():
    for path in SAMPLES.glob("*.json"):
        for p in json.load(open(path)):
            hit = extract(p)
            box = hit.as_bbox() if hit else None
            if not box:
                continue
            for axis, v in box.items():
                assert 0.02 <= v <= 5.0, f"{path.name}: {p.get('title')} {axis}={v}m"


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"PASS {name}")
            except Exception as e:
                print(f"FAIL {name}: {e}"); fails += 1
    print(f"\n{fails} failed")
    sys.exit(1 if fails else 0)
