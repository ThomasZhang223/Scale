"""Steps 4 and 5 — the plausibility check. Run: python3 tests/test_validate.py

This file exists because it did not. validate.py decides which measurements are trusted, and
it had no direct coverage, so a prior that flagged every correctly measured sectional Poly &
Bark sells went unnoticed until someone read a run by hand.

The rule under test: a flag must mean the DATA is suspect, never that the category table is
too narrow. A false positive here is worse than silence — it pushes an accurate row below a
worse-measured one in both curate() and /search, invisibly.
"""

import sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.validate import validate, prior_for, candidate_priors


def v(bbox, category="", title=""):
    return validate(bbox, category=category, title=title, source_field="body_html")


# --- which prior a product is judged by ------------------------------------

def test_the_title_wins_over_a_product_type_that_names_a_collection():
    """A product_type is often a collection covering several kinds of thing; a title names one
    product. Both of these are real Poly & Bark rows that flagged correct measurements."""
    assert prior_for("Modular Sofas", 'Aspen 157" 6-Piece L-Shaped Sectional')[0] == "sectional"
    assert prior_for("Benches, Stools & Ottomans", "Este Bench | Shadow Brown")[0] == "bench"


def test_the_product_type_is_used_when_the_title_names_nothing():
    """Brand names carry no category. "The Cloud" is only a chair because the type says so."""
    assert prior_for("Chairs", "The Cloud")[0] == "chair"
    assert prior_for("Bookcases", "Astrid")[0] == "shelf"


def test_an_empty_product_type_falls_back_to_the_title():
    """101 products on a real run had no product_type at all."""
    assert prior_for("", "The Floyd Bed — Upholstered")[0] == "bed"
    assert prior_for(None, "Brass Floor Lamp")[0] == "lamp"


def test_an_unknown_product_is_judged_by_nothing_rather_than_guessed_at():
    assert prior_for("Wall Hooks", "Brass Hook") == (None, None)


# --- the bug this file was written for -------------------------------------

def test_a_real_l_shaped_sectional_is_not_flagged():
    """Aspen 157" 6-Piece, measured from Poly & Bark: 3.96 x 2.97 x 0.86 m. An L-shape's
    bounding box contains the arm that sticks out, so its depth is that arm and not the seat
    depth. Judged as a sofa it flagged at 0.488, just under the 0.5 unverified threshold."""
    r = v({"w": 3.96, "h": 0.86, "d": 2.97}, "Modular Sofas",
          'Aspen 157" Modular 6-Piece L-Shaped Sectional')
    assert r.ok and not r.unverified, f"{r.confidence} {r.notes}"
    assert r.confidence >= 0.5


def test_a_bench_is_not_judged_as_an_ottoman():
    """"Benches, Stools & Ottomans" holds three categories and the longest alias in it is
    "ottoman", whose 1.40 m width ceiling a 1.41 m bench just misses."""
    r = v({"w": 1.41, "h": 0.43, "d": 0.47}, "Benches, Stools & Ottomans",
          "Este Bench | Shadow Brown")
    assert not r.unverified, f"{r.confidence} {r.notes}"


def test_a_straight_sofa_still_uses_the_straight_sofa_prior():
    """The sectional prior must not become a blanket excuse. A 2.4 m DEEP two-seater is not a
    real product and has to stay flagged."""
    r = v({"w": 2.1, "h": 0.85, "d": 2.4}, "Sofas", "Bergen Two-Seater Sofa")
    assert r.unverified or r.flags, "a 2.4 m deep sofa passed unflagged"


def test_a_product_is_checked_against_every_reading_of_what_it_is():
    """Which source is right VARIES, so picking a winner is wrong in one direction or the
    other. Real: Poly & Bark's "Sink Down Lounge Chair" has product_type "sectionals" and is
    2.34 m wide — the type is right and the title is a marketing name. Preferring the title
    flagged it; preferring the type would flag the L-shaped sectional above."""
    keys = [k for k, _ in candidate_priors("sectionals", "Sink Down Lounge Chair")]
    assert set(keys) == {"chair", "sectional"}, keys
    r = v({"w": 2.34, "h": 0.81, "d": 1.14}, "sectionals", "Sink Down Lounge Chair")
    assert not r.unverified, f"{r.confidence} {r.notes}"
    assert "sectional" in " ".join(r.notes), r.notes


def test_a_wardrobe_is_not_judged_as_a_dresser():
    """Real: "Maro Wardrobe / Armoire" is 1.95 m tall with product_type "storage". A wardrobe
    is a dresser's height plus a hanging rail."""
    assert prior_for("storage", "Maro Wardrobe / Armoire | Walnut")[0] == "wardrobe"
    r = v({"w": 1.20, "h": 1.95, "d": 0.55}, "storage", "Maro Wardrobe / Armoire | Walnut")
    assert not r.unverified, f"{r.confidence} {r.notes}"


def test_a_single_modular_piece_is_a_plausible_sectional():
    """Modular ranges sell armless pieces well under a whole sofa's width."""
    r = v({"w": 1.35, "h": 0.71, "d": 1.07}, "sectionals", "Soft Serve Lounge Chair")
    assert not r.unverified, f"{r.confidence} {r.notes}"


def test_failing_every_reading_is_still_a_mismatch():
    """Checking more readings must not become a way of never flagging anything. Nothing this
    service sells is 8 cm wide under any category."""
    r = v({"w": 0.08, "h": 0.75, "d": 0.90}, "sectionals", "Mystery Lounge Chair")
    assert "prior_mismatch" in r.flags, f"{r.confidence} {r.notes}"


# --- the flags that must keep firing ---------------------------------------

def test_a_unit_mistake_is_still_caught():
    """The 8 cm sofa from a real run: centimetres read as metres somewhere upstream."""
    r = v({"w": 0.08, "h": 0.75, "d": 0.90}, "Sofas", "Mystery Sofa")
    assert r.flags, "an 8 cm sofa passed clean"


def test_swapped_width_and_depth_is_still_caught():
    """City Entry Bench, real: 0.41 wide and 0.79 deep. An entry bench is not deeper than it
    is wide."""
    r = v({"w": 0.41, "h": 0.45, "d": 0.79}, "", "City Entry Bench")
    assert r.unverified, f"{r.confidence} {r.notes}"
    assert any("swap" in n.lower() for n in r.notes), r.notes


def test_having_no_prior_is_not_the_same_as_failing_one():
    """An unchecked measurement is slightly less certain than a checked one, so no_prior costs
    a little — but it must never read as "this data is wrong". A wall hook is a real product
    nobody wrote a prior for, and it has to stay usable."""
    r = v({"w": 0.05, "h": 0.08, "d": 0.04}, "Wall Hooks", "Brass Hook")
    assert r.ok and not r.unverified, f"{r.confidence} {r.notes}"
    assert r.flags == ["no_prior"], r.flags
    assert "prior_mismatch" not in r.flags, "no opinion is not a mismatch"
    assert r.confidence >= 0.5, f"an unjudged product fell below the trust line: {r.confidence}"


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
