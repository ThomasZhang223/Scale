"""Tests for step 2.5 — dimensions from a rendered product page.

HTML shapes here mirror what real Shopify themes emit: schema.org JSON-LD, a spec table, a
<details>/<summary> accordion, and pages where the only numbers are noise.
"""

import sys, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.page_extract import (
    extract_from_page, from_json_ld, from_spec_block, from_full_text, product_url,
)
from app.browserbase import BrowserbaseFetch, CachedFetch, FetchError, FetchResult

JSON_LD = """
<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Oak Desk",
 "width":{"@type":"QuantitativeValue","value":152,"unitCode":"CMT"},
 "height":{"@type":"QuantitativeValue","value":74,"unitCode":"CMT"},
 "depth":{"@type":"QuantitativeValue","value":76,"unitCode":"CMT"}}
</script></head><body><p>A desk.</p></body></html>
"""

SPEC_TABLE = """
<html><body><table>
  <tr><th>Material</th><td>Solid oak</td></tr>
  <tr><th>Dimensions</th><td>W 152 x D 76 x H 74 cm</td></tr>
  <tr><th>Weight</th><td>24 kg</td></tr>
</table></body></html>
"""

ACCORDION = """
<html><body><details><summary>Dimensions</summary>
  <div>60" W x 30" D x 29" H</div>
</details></body></html>
"""

DEF_LIST = """
<html><body><dl>
  <dt>Finish</dt><dd>Walnut</dd>
  <dt>Product Size</dt><dd>1520mm x 760mm x 740mm</dd>
</dl></body></html>
"""

# The realistic shape, and the one my first fixtures were too optimistic about: the theme emits
# Product JSON-LD but fills only name/image/offers/sku. No dimensions in the structured data at
# all, so the spec block has to carry it.
JSON_LD_WITHOUT_DIMENSIONS = """
<html><head><script type="application/ld+json">
{"@context":"https://schema.org/","@type":"Product","name":"The Floyd Bed",
 "image":["https://cdn.shopify.com/x.jpg"],"sku":"BED-Q",
 "offers":{"@type":"Offer","price":"995.00","priceCurrency":"USD"}}
</script></head><body>
<details><summary>Dimensions</summary><div>Queen: 60" W x 80" L x 14" H</div></details>
<p>Ships in 3-5 days.</p>
</body></html>
"""

NOISE_ONLY = """
<html><body>
 <p>Ships in 3-5 days. Free returns within 30 days. Rated 4.8 by 120 reviews.</p>
 <script>var price = 1299;</script>
</body></html>
"""


def test_json_ld_is_unambiguous_about_axes():
    hit = from_json_ld(JSON_LD)
    assert hit.as_bbox() == {"w": 1.52, "h": 0.74, "d": 0.76}
    assert hit.method == "json_ld" and hit.confidence >= 0.9


def test_json_ld_in_a_graph_wrapper():
    html = JSON_LD.replace('{"@context":"https://schema.org","@type":"Product"',
                           '{"@context":"https://schema.org","@graph":[{"@type":"Product"')
    html = html.replace('"unitCode":"CMT"}}', '"unitCode":"CMT"}}]}')
    assert from_json_ld(html).as_bbox() == {"w": 1.52, "h": 0.74, "d": 0.76}


def test_json_ld_value_without_a_unit_is_refused():
    html = JSON_LD.replace('"unitCode":"CMT"', '"unitCode":"XXX"')
    assert from_json_ld(html) is None, "a number with no known unit is not a measurement"


def test_broken_json_ld_does_not_crash_the_page():
    assert from_json_ld('<script type="application/ld+json">{not json</script>') is None


def test_spec_table_row_labelled_dimensions():
    hit = from_spec_block(SPEC_TABLE)
    assert hit.as_bbox() == {"w": 1.52, "h": 0.74, "d": 0.76}
    assert hit.source_field == "spec_block"


def test_spec_table_does_not_read_the_weight_row():
    hit = from_spec_block(SPEC_TABLE)
    assert hit.as_bbox()["h"] != 0.024


def test_accordion_with_suffix_labels():
    assert from_spec_block(ACCORDION).as_bbox() is not None


def test_definition_list():
    assert from_spec_block(DEF_LIST).as_bbox() == {"w": 1.52, "h": 0.74, "d": 0.76}


def test_a_spec_block_outranks_page_prose():
    spec = from_spec_block(SPEC_TABLE)
    text = from_full_text(SPEC_TABLE)
    assert text is None or spec.confidence > text.confidence


def test_page_with_only_noise_yields_nothing():
    assert extract_from_page(NOISE_ONLY) is None, "shipping days and ratings are not dimensions"


def test_scripts_are_stripped_before_reading_text():
    hit = from_full_text('<html><body><script>var w = "60 cm";</script><p>A lamp.</p></body></html>')
    assert hit is None, "a number inside a <script> is not page content"


def test_extract_prefers_json_ld_over_the_rest():
    both = JSON_LD.replace("</body>", "<table><tr><th>Dimensions</th><td>1 x 1 x 1 m</td></tr></table></body>")
    assert extract_from_page(both).method == "json_ld"


def test_a_partial_hit_is_kept_rather_than_discarded():
    html = '<html><body><table><tr><th>Dimensions</th><td>60" x 30"</td></tr></table></body></html>'
    hit = extract_from_page(html)
    assert hit is not None and hit.as_bbox() is None, "two axes is a partial, not a bbox"
    assert hit.w is not None


def test_json_ld_without_dimension_keys_falls_through_to_the_spec_block():
    """Most themes emit Product JSON-LD with only name/image/offers/sku. The structured path
    must yield nothing rather than something wrong, and the spec block must still win."""
    assert from_json_ld(JSON_LD_WITHOUT_DIMENSIONS) is None
    hit = extract_from_page(JSON_LD_WITHOUT_DIMENSIONS)
    assert hit.as_bbox() is not None
    assert hit.source_field == "spec_block"


def test_suffix_labels_map_to_the_right_axes():
    """60" W x 80" L x 14" H — L is depth, not height. Getting this wrong puts a bed on its end."""
    hit = extract_from_page(JSON_LD_WITHOUT_DIMENSIONS)
    box = hit.as_bbox()
    assert abs(box["w"] - 1.524) < 1e-3, box   # 60 in
    assert abs(box["d"] - 2.032) < 1e-3, box   # 80 in  (L)
    assert abs(box["h"] - 0.3556) < 1e-3, box  # 14 in


def test_shipping_days_are_not_read_as_a_dimension():
    hit = extract_from_page(JSON_LD_WITHOUT_DIMENSIONS)
    for v in hit.as_bbox().values():
        assert v not in (0.03, 0.05), "'Ships in 3-5 days' leaked into the dimensions"


def test_product_url_is_built_from_the_handle():
    assert product_url("https://shop.com/", "oak-desk") == "https://shop.com/products/oak-desk"
    try:
        product_url("https://shop.com", "")
        raise AssertionError("should have raised")
    except ValueError:
        pass


# --- the fetch client -----------------------------------------------------

def test_missing_api_key_fails_loudly_rather_than_fetching_directly():
    import os
    saved = os.environ.pop("BROWSERBASE_API_KEY", None)
    try:
        BrowserbaseFetch()
        raise AssertionError("should have raised")
    except ValueError as e:
        assert "BROWSERBASE_API_KEY" in str(e)
    finally:
        if saved:
            os.environ["BROWSERBASE_API_KEY"] = saved


def test_fetch_returns_page_content():
    class FakeClient:
        def post(self, url, headers=None, json=None):
            class R:
                status_code = 200
                def json(self):
                    return {"id": "req-1", "statusCode": 200, "content": SPEC_TABLE,
                            "contentType": "text/html"}
            assert headers["X-BB-API-Key"] == "k"
            assert json["allowRedirects"] is True
            return R()

    f = BrowserbaseFetch(api_key="k", client=FakeClient())
    res = f.fetch("https://shop.com/products/oak-desk")
    assert res.status_code == 200 and "Dimensions" in res.content
    assert extract_from_page(res.content).as_bbox() is not None


def test_a_403_is_raised_not_retried():
    calls = []

    class FakeClient:
        def post(self, url, headers=None, json=None):
            calls.append(1)
            class R:
                status_code = 403
                def json(self): return {}
            return R()

    try:
        BrowserbaseFetch(api_key="k", client=FakeClient()).fetch("https://x.com")
        raise AssertionError("should have raised")
    except FetchError as e:
        assert e.status == 403 and "API_KEY" in str(e)
    assert len(calls) == 1, "an auth failure must not be retried"


def test_concurrency_limit_is_retried():
    import app.browserbase as bb
    saved, bb.BACKOFF_S = bb.BACKOFF_S, 0
    calls = []

    class FakeClient:
        def post(self, url, headers=None, json=None):
            calls.append(1)
            class R:
                status_code = 429
                def json(self): return {}
            return R()

    try:
        bb.BrowserbaseFetch(api_key="k", client=FakeClient()).fetch("https://x.com")
        raise AssertionError("should have raised")
    except FetchError as e:
        assert e.status == 429
    finally:
        bb.BACKOFF_S = saved
    assert len(calls) == bb.MAX_RETRIES, f"429 should retry, got {len(calls)} attempts"


def test_cache_serves_the_second_request_without_the_upstream():
    import tempfile

    class OnceOnly:
        def __init__(self): self.n = 0
        def fetch(self, url):
            self.n += 1
            return FetchResult(url=url, status_code=200, content=SPEC_TABLE)

    up = OnceOnly()
    with tempfile.TemporaryDirectory() as d:
        c = CachedFetch(d, upstream=up)
        a = c.fetch("https://shop.com/products/x")
        b = c.fetch("https://shop.com/products/x")
        assert a.content == b.content
        assert up.n == 1, "the second call must come from cache"
        assert (c.hits, c.misses) == (1, 1)


def test_cache_miss_without_upstream_is_an_error_not_an_empty_page():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        try:
            CachedFetch(d).fetch("https://shop.com/products/x")
            raise AssertionError("should have raised")
        except FetchError as e:
            assert "cache miss" in str(e)


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
