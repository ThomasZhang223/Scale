"""Tests for hybrid ranking. Run: python3 tests/test_ranking.py

The central assertion is the one from RANKING.md: a thing that looks right but does not fit
must never outrank a thing that fits. That is the failure the whole product exists to prevent.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.ranking import (
    Candidate, rank, fit_bounds_mm, passes_fit, cosine, colour_similarity, RELAX_FACTOR,
)

OAK = "#b5834a"
WALNUT = "#4a3728"
WHITE = "#f5f5f0"


def c(oid, w, h, d, **kw):
    return Candidate(object_id=oid, w_mm=w, h_mm=h, d_mm=d,
                     object={"objectId": oid, "name": oid}, **kw)


# --- fit: the integer range filter -----------------------------------------

def test_metres_convert_to_millimetres_once():
    assert fit_bounds_mm({"maxW": 0.8, "maxH": 1.2, "maxD": 0.6}) == \
        {"w_mm": 800, "h_mm": 1200, "d_mm": 600}


def test_partial_fit_filter_only_constrains_what_it_names():
    assert fit_bounds_mm({"maxW": 0.8}) == {"w_mm": 800}
    assert fit_bounds_mm(None) is None
    assert fit_bounds_mm({}) is None


def test_centimetres_mistaken_for_metres_is_refused():
    # 80 "metres" is someone forgetting to convert. Filtering nothing silently is worse.
    try:
        fit_bounds_mm({"maxW": 80})
        raise AssertionError("should have raised")
    except ValueError as e:
        assert "units" in str(e)


def test_an_object_5cm_too_wide_does_not_pass():
    bounds = fit_bounds_mm({"maxW": 0.8})
    assert passes_fit(c("fits", 790, 1000, 300), bounds)
    assert not passes_fit(c("too-wide", 850, 1000, 300), bounds)


def test_every_named_axis_must_pass():
    bounds = fit_bounds_mm({"maxW": 0.8, "maxH": 1.2})
    assert not passes_fit(c("too-tall", 700, 1400, 300), bounds)


# --- the rule: fit decides membership, style only ranks --------------------

def test_a_perfect_style_match_that_does_not_fit_is_excluded():
    perfect_but_big = c("big", 900, 1000, 300, dominant_hex=OAK, vector=[1.0, 0.0])
    worse_but_fits = c("fits", 700, 1000, 300, dominant_hex=WHITE, vector=[0.0, 1.0])
    results, _ = rank([perfect_but_big, worse_but_fits],
                      fit={"maxW": 0.8}, query_vector=[1.0, 0.0], target_hex=OAK)
    ids = [r.object_id for r in results]
    assert ids == ["fits"], f"a non-fitting perfect match leaked into results: {ids}"


def test_style_ranks_within_the_fitting_set():
    oak = c("oak", 700, 1000, 300, dominant_hex=OAK, vector=[1.0, 0.0])
    white = c("white", 700, 1000, 300, dominant_hex=WHITE, vector=[1.0, 0.0])
    results, _ = rank([white, oak], fit={"maxW": 0.8}, query_vector=[1.0, 0.0], target_hex=OAK)
    assert [r.object_id for r in results] == ["oak", "white"]


# --- the fallback rule: never an empty screen ------------------------------

def test_nothing_fits_so_the_filter_relaxes_and_says_so():
    just_over = c("just-over", 850, 1000, 300, vector=[1.0])
    results, relaxed = rank([just_over], fit={"maxW": 0.8}, query_vector=[1.0])
    assert relaxed is True
    assert [r.object_id for r in results] == ["just-over"]
    assert all(r.relaxed for r in results), "results must carry the relaxed flag"


def test_relaxation_is_bounded_not_unlimited():
    # 10% of 800mm is 880mm, so a 1200mm object stays out even after relaxing.
    way_over = c("way-over", 1200, 1000, 300, vector=[1.0])
    results, relaxed = rank([way_over], fit={"maxW": 0.8}, query_vector=[1.0])
    assert relaxed is True and results == [], "relaxation must not become 'no filter'"
    assert fit_bounds_mm({"maxW": 0.8}, RELAX_FACTOR) == {"w_mm": 880}


def test_a_satisfied_filter_never_relaxes():
    _, relaxed = rank([c("fits", 700, 900, 300, vector=[1.0])],
                      fit={"maxW": 0.8}, query_vector=[1.0])
    assert relaxed is False


# --- colour: "matches its wood tone" --------------------------------------

def test_wood_tones_rank_above_white():
    assert colour_similarity(OAK, WALNUT) > colour_similarity(OAK, WHITE)


def test_identical_colour_is_one_and_missing_colour_is_none():
    assert colour_similarity(OAK, OAK) == 1.0
    assert colour_similarity(OAK, None) is None
    assert colour_similarity(None, OAK) is None


def test_shorthand_and_unprefixed_hex_both_parse():
    assert colour_similarity("#fff", "ffffff") == 1.0


def test_a_malformed_hex_is_ignored_not_fatal():
    assert colour_similarity(OAK, "not-a-colour") is None


# --- scoring hygiene -------------------------------------------------------

def test_cosine_of_identical_vectors_is_one():
    assert abs(cosine([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) - 1.0) < 1e-9


def test_mismatched_vector_lengths_raise():
    try:
        cosine([1.0], [1.0, 2.0])
        raise AssertionError("should have raised")
    except ValueError:
        pass


def test_verified_dimensions_break_a_tie():
    verified = c("verified", 700, 900, 300, vector=[1.0], measure_confidence=0.95)
    guessed = c("guessed", 700, 900, 300, vector=[1.0], measure_confidence=0.2)
    results, _ = rank([guessed, verified], query_vector=[1.0])
    assert [r.object_id for r in results] == ["verified", "guessed"]


def test_source_filter_selects_your_own_possessions():
    scan = c("mine", 700, 900, 300, source="scan", vector=[1.0])
    cat = c("shop", 700, 900, 300, source="catalog", vector=[1.0])
    results, _ = rank([scan, cat], source="scan", query_vector=[1.0])
    assert [r.object_id for r in results] == ["mine"]


def test_results_are_deterministic_across_runs():
    pool = [c(f"o{i}", 700, 900, 300, vector=[1.0]) for i in range(5)]
    first, _ = rank(pool, query_vector=[1.0])
    second, _ = rank(list(reversed(pool)), query_vector=[1.0])
    assert [r.object_id for r in first] == [r.object_id for r in second]


def test_limit_is_respected_and_must_be_positive():
    pool = [c(f"o{i}", 700, 900, 300, vector=[1.0]) for i in range(20)]
    assert len(rank(pool, query_vector=[1.0], limit=3)[0]) == 3
    try:
        rank(pool, limit=0)
        raise AssertionError("should have raised")
    except ValueError:
        pass


def test_no_query_vector_still_ranks_by_colour_and_confidence():
    oak = c("oak", 700, 900, 300, dominant_hex=OAK)
    white = c("white", 700, 900, 300, dominant_hex=WHITE)
    results, _ = rank([white, oak], target_hex=OAK)
    assert [r.object_id for r in results] == ["oak", "white"]


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
