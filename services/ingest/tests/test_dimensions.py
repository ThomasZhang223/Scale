"""Unit tests for the regex pass. Run: python3 -m pytest tests/ -q  (or python3 tests/run.py)"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.dimensions import extract, strip_html


def _p(**kw):
    return {"title": "Thing", "variants": [], "options": [], "body_html": "", **kw}


def test_labelled_metric():
    h = extract(_p(body_html="<p>W 152 x D 76 x H 74 cm</p>"))
    assert h.as_bbox() == {"w": 1.52, "h": 0.74, "d": 0.76}
    assert h.method == "labelled"


def test_labelled_imperial_with_symbols():
    h = extract(_p(body_html='Width: 60" &nbsp;Depth: 30" &nbsp;Height: 29"'))
    b = h.as_bbox()
    assert abs(b["w"] - 1.524) < 1e-3 and abs(b["d"] - 0.762) < 1e-3


def test_variant_title_sequence():
    h = extract(_p(variants=[{"title": '60" x 30"'}]))
    assert h.method == "sequence"
    assert abs(h.w - 1.524) < 1e-3 and abs(h.d - 0.762) < 1e-3
    assert h.as_bbox() is None, "two axes is not a usable bbox"


def test_trailing_unit_applies_to_all():
    h = extract(_p(body_html="Dimensions: 152 x 76 x 74 cm"))
    assert h.as_bbox() == {"w": 1.52, "h": 0.74, "d": 0.76}


def test_millimetres():
    h = extract(_p(body_html="W 1520mm x D 760mm x H 740mm"))
    assert h.as_bbox() == {"w": 1.52, "h": 0.74, "d": 0.76}


def test_no_unit_is_refused_not_guessed():
    # "60 x 30" could be cm or inches. Refusing is the point (standing rule 4).
    assert extract(_p(body_html="Dimensions: 60 x 30 x 29")) is None


def test_absurd_values_rejected():
    assert extract(_p(body_html="W 8000 x D 9000 x H 7000 cm")) is None


def test_no_dimensions_at_all():
    assert extract(_p(body_html="<p>Solid oak. Made in Canada. Free shipping.</p>")) is None


def test_weight_is_not_a_dimension():
    assert extract(_p(body_html="<p>Weight: 24 kg. Ships flat.</p>")) is None


def test_labelled_beats_sequence():
    h = extract(_p(variants=[{"title": "60 x 30 in"}], body_html="W 152 x D 76 x H 74 cm"))
    assert h.method == "labelled" and h.as_bbox() is not None


def test_strip_html_entities():
    assert '"' in strip_html("<p>60&quot;</p>")


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
