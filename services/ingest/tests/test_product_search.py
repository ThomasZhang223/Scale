"""Prompt -> candidate products. Run: python3 tests/test_product_search.py

The search page is the only new surface in the live path; everything behind it is the
pipeline that already has coverage. Ordering is asserted hard, because the merchant's
relevance ranking is the entire reason to fetch their page instead of filtering titles.
"""

import sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.product_search import (
    search_url, handles_from_search_page, products_by_handle, normalise_query,
    relevance, drop_unplaceable,
)


# --- utterance -> query, without a model ------------------------------------

def test_filler_and_deictics_are_dropped():
    """"add" and "there" describe the placement, which the solver owns. They say nothing
    about the product and only make a merchant's search worse."""
    assert normalise_query("add a red chair there") == "red chair"
    assert normalise_query("can you put a lamp here") == "lamp"


def test_separating_the_place_from_the_product_is_not_this_layer_s_job():
    """The voice agent already does this properly: find_anchor takes "beside my desk" and
    search_objects gets the product. A second version here would be two places parsing one
    utterance, and truncating on location words ate real product words —
    "bar stool under 70cm" lost its size to "under"."""
    assert normalise_query("bar stool under 70cm") == "bar stool under 70cm"
    assert normalise_query("shelf under the window") == "shelf under window"


def test_an_already_clean_query_is_left_alone():
    """The normal path: the voice agent's first pass already produced this."""
    assert normalise_query("walnut side table") == "walnut side table"
    assert normalise_query("sofa") == "sofa"


def test_stripping_everything_returns_the_original_rather_than_nothing():
    """A query that finds the wrong things beats one that finds nothing."""
    assert normalise_query("there") == "there"
    assert normalise_query("a the some") == "a the some"


# --- the URL ---------------------------------------------------------------

def test_the_search_url_is_shopify_s_own_route():
    assert search_url("https://floydhome.com", "red chair") == \
        "https://floydhome.com/search?q=red+chair"
    assert search_url("https://floydhome.com/", "red chair").count("//") == 1


def test_a_query_with_punctuation_is_encoded():
    u = search_url("https://s.com", 'oak "side table" & lamp')
    assert " " not in u and "&" not in u.split("?q=")[1].replace("%26", "")


def test_an_empty_query_raises_rather_than_searching_for_nothing():
    for bad in ("", "   ", None):
        try:
            search_url("https://s.com", bad)
        except (ValueError, AttributeError, TypeError):
            continue
        raise AssertionError(f"{bad!r} did not raise")


# --- parsing the results page ---------------------------------------------

PAGE = """
<html><body>
  <a href="/cart">Cart</a>
  <a href="/collections/seating/products/oak-chair?variant=123"><img></a>
  <a href="/collections/seating/products/oak-chair">Oak Chair</a>
  <a href="/products/walnut-stool#gallery">Walnut Stool</a>
  <a href="https://floydhome.com/products/linen-sofa">Linen Sofa</a>
  <a href="/blogs/news/products/not-a-product">Blog post</a>
  <a href="/account">Account</a>
</body></html>
"""


def test_handles_come_back_in_page_order_which_is_relevance_order():
    assert handles_from_search_page(PAGE) == ["oak-chair", "walnut-stool", "linen-sofa"]


def test_a_product_linked_twice_keeps_its_first_position():
    """Themes link a product from both its image and its title. The second link must not
    demote it — position IS the merchant's ranking."""
    html = '<a href="/products/b">B</a><a href="/products/a">A</a><a href="/products/a">A</a>'
    assert handles_from_search_page(html) == ["b", "a"]


def test_query_strings_and_fragments_are_stripped():
    html = '<a href="/products/oak-chair?variant=42&pr_strat=x">c</a>'
    assert handles_from_search_page(html) == ["oak-chair"]


def test_cart_and_account_links_are_not_results():
    html = '<a href="/cart/products/x">c</a><a href="/account/products/y">a</a>'
    assert handles_from_search_page(html) == []


def test_a_theme_that_renders_results_from_json_still_yields_handles():
    """No <a> in the markup at all. Reporting "no results" there is the wrong conclusion and
    looks exactly like a genuinely empty search."""
    html = '<script>window.results = {"items":[{"url":"/products/hidden-desk"}]}</script>'
    assert handles_from_search_page(html) == ["hidden-desk"]


def test_an_empty_page_yields_nothing_rather_than_raising():
    assert handles_from_search_page("") == []
    assert handles_from_search_page("<html><body>No results</body></html>") == []


def test_the_limit_is_respected():
    html = "".join(f'<a href="/products/item-{i}">x</a>' for i in range(50))
    assert len(handles_from_search_page(html, limit=5)) == 5


# --- joining back to the catalogue ----------------------------------------

CATALOGUE = [
    {"handle": "linen-sofa", "title": "Linen Sofa", "body_html": "<p>W 200 x D 90 x H 75 cm</p>"},
    {"handle": "oak-chair", "title": "Oak Chair", "body_html": "<p>W 45 x D 50 x H 90 cm</p>"},
    {"handle": "walnut-stool", "title": "Walnut Stool", "body_html": ""},
]


def test_products_come_back_in_search_order_not_catalogue_order():
    got = products_by_handle(CATALOGUE, ["oak-chair", "linen-sofa"])
    assert [p["handle"] for p in got] == ["oak-chair", "linen-sofa"]


def test_a_handle_the_catalogue_does_not_list_is_dropped_not_half_filled():
    """A product /products.json does not serve cannot be measured anyway. Better absent than
    present with no variants and no images."""
    got = products_by_handle(CATALOGUE, ["oak-chair", "ghost-item", "walnut-stool"])
    assert [p["handle"] for p in got] == ["oak-chair", "walnut-stool"]


def test_handle_matching_ignores_case():
    got = products_by_handle([{"handle": "Oak-Chair"}], ["oak-chair"])
    assert len(got) == 1


# --- a no-results page that looks like results -----------------------------

def _p(title, ptype="", tags=()):
    return {"handle": title.lower().replace(" ", "-"), "title": title,
            "product_type": ptype, "tags": list(tags)}


def test_a_store_serving_popular_products_for_a_miss_is_detectable():
    """Measured on the real thing: floydhome.com answers "red chair" with twelve beds, and
    "red chair" and "bed" return the same twelve handles in the same order. Their catalogue
    has no chairs, so the theme falls back — and that page looks exactly like a real one."""
    beds = [_p("The Floyd Bed", "beds"), _p("The Mattress 2.0", "mattresses"),
            _p("Bedside Table", "tables"), _p("Underbed Storage", "storage")]
    hits, ratio = relevance("red chair", beds)
    assert hits == 0 and ratio == 0.0, "a fallback page must be distinguishable from a ranking"


def test_a_genuine_result_set_scores_high():
    chairs = [_p("Ligna Dining Chair | Walnut", "chairs"),
              _p("Ferrara Dining Chair | Walnut", "chairs"),
              _p("Torge Dining Chair | Walnut", "chairs")]
    hits, ratio = relevance("walnut dining chair", chairs)
    assert hits == 3 and ratio == 1.0


def test_a_match_on_type_or_tags_counts_not_just_the_title():
    """Bend Goods names products "Ethel" and "Gloria"; the word chair is in the type."""
    rows = [_p("Ethel", "Chairs"), _p("Gloria", "", tags=["chair", "dining"])]
    hits, _ = relevance("chair", rows)
    assert hits == 2


def test_short_words_do_not_create_false_matches():
    """A two-letter token matches half a catalogue by accident."""
    hits, _ = relevance("a in of", [_p("Linen Sofa", "sofas")])
    assert hits == 0


def test_relevance_of_nothing_is_zero_not_a_crash():
    assert relevance("chair", []) == (0, 0.0)
    assert relevance("", [_p("Chair")]) == (0, 0.0)


# --- things that are not objects -------------------------------------------

def test_gift_cards_and_samples_are_dropped():
    """polyandbark.com returns its gift card first for "walnut dining chair". Nothing
    downstream can make a mesh of it or place it in a room."""
    rows = [_p("Digital Gift Card"), _p("Ligna Dining Chair", "chairs"),
            _p("Fabric Swatch", "samples"), _p("5-Year Protection Plan")]
    kept = [p["title"] for p in drop_unplaceable(rows)]
    assert kept == ["Ligna Dining Chair"], kept


def test_real_furniture_survives_the_filter():
    rows = [_p("Oak Chair", "chairs"), _p("Linen Sofa", "sofas"), _p("The Floyd Bed", "beds")]
    assert len(drop_unplaceable(rows)) == 3


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
