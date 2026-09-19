"""Regression tests against real merchant pages in tests/fixtures/pages/.

The rest of the page-extraction suite uses HTML I wrote, which proves only that the parser
matches itself. These are pages Floyd actually served.
"""

import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.page_extract import extract_from_page, from_json_ld, _loads_tolerant

PAGES = ROOT / "tests" / "fixtures" / "pages"


def _html(name):
    path = next(PAGES.glob(f"*{name}*.html"))
    return path.read_text()


def test_page_text_recovers_what_json_ld_and_spec_blocks_cannot():
    hit = extract_from_page(_html("headboard"))
    assert hit.as_bbox() is not None
    assert hit.source_field == "page_text", "JSON-LD and the spec block give nothing on Floyd"
    assert abs(hit.w - 1.7018) < 1e-3   # 67 in
    assert abs(hit.h - 0.4572) < 1e-3   # 18 in


def test_the_depth_label_is_not_read_as_height():
    """22" W 86" D 1.5" H — get this wrong and an 86-inch bed frame stands on its end."""
    box = extract_from_page(_html("expansion-kit")).as_bbox()
    assert abs(box["w"] - 0.5588) < 1e-3
    assert abs(box["d"] - 2.1844) < 1e-3
    assert abs(box["h"] - 0.0381) < 1e-3


def test_a_page_of_tracking_ids_and_prices_yields_nothing():
    assert extract_from_page(_html("duvet")) is None


def test_floyds_json_ld_parses_but_carries_no_dimensions():
    """Settled by reading the real markup: the block fails a strict parse on a control
    character, and once parsed holds only size: ["King"] — a size name, not a measurement."""
    import re
    html = _html("headboard")
    raw = re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I)[0]
    data = _loads_tolerant(raw)
    assert isinstance(data, dict) and data["@type"] == "Product"
    assert not {"width", "height", "depth"} & set(data), "Floyd would carry dimensions after all"
    assert from_json_ld(html) is None


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
