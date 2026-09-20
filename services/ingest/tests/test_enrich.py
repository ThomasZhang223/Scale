"""Tests for the three enrich steps. Run: python3 tests/test_enrich.py

These set the pipeline's runtime and had no coverage at all until a --llm --vlm run took over
half an hour: 1600 serial calls, 252 of them redoing products step 2.5 had already solved.
Both of those are behaviours, not performance trivia, so they are asserted here.
"""

import sys, pathlib, time, threading

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import build_prebake as bp
from app.ai_extract import DimensionHit, OpenAIConfig

CFG = OpenAIConfig(api_key="k", model="m")


def product(i, images=1):
    return {"id": i, "title": f"Item {i}", "handle": f"item-{i}", "product_type": "Desks",
            "variants": [{"title": "Default Title"}], "options": [], "body_html": "",
            "images": [{"src": f"https://cdn.example.com/{i}-{n}.jpg"} for n in range(images)]}


def a_hit():
    return DimensionHit(w=1.52, h=0.74, d=0.76, method="llm", confidence=0.6,
                        source_field="body_html", raw="W 152 x D 76 x H 74 cm")


class FakeResp:
    def __init__(self): self.content, self.headers = b"img", {"content-type": "image/jpeg"}
    def raise_for_status(self): pass


class FakeClient:
    def __init__(self): self.gets = []
    def get(self, url, *a, **k):
        self.gets.append(url)
        return FakeResp()


class FakeFetcher:
    """Step 2.5's fetcher. Solves the products whose handle is in `solves`."""
    def __init__(self, solves): self.solves, self.seen = set(solves), []
    def fetch(self, url):
        self.seen.append(url)
        class R:
            content = (b"<html><details><summary>Dimensions</summary>"
                       b'<div>60" W x 30" D x 29" H</div></details></html>')
        class Empty:
            content = b"<html><body>nothing here</body></html>"
        return R() if any(h in url for h in self.solves) else Empty()


# --------------------------------------------------------------------------- step 2.5

def test_step_2_5_reports_what_it_did_not_solve():
    """The bug that cost the runtime: needs_page was never narrowed, so step 3 re-did
    everything step 2.5 had already measured, at three calls a product."""
    products = [product(i) for i in range(6)]
    fetcher = FakeFetcher(["item-0", "item-1", "item-2"])
    recovered, missing, stats = bp.enrich_from_pages("m", "https://s.com", products, fetcher, 10)

    assert len(recovered) == 3, recovered
    assert stats["recovered"] == 3 and stats["attempted"] == 6
    assert [p["handle"] for p in missing] == ["item-3", "item-4", "item-5"]
    solved = {r["handle"] for r in recovered}
    assert not solved & {p["handle"] for p in missing}, "a product cannot be both"


def test_step_2_5_counts_products_past_the_limit_as_missing():
    """Un-attempted is not solved. Past the limit they were never looked at."""
    products = [product(i) for i in range(6)]
    fetcher = FakeFetcher(["item-0", "item-1"])
    recovered, missing, stats = bp.enrich_from_pages("m", "https://s.com", products, fetcher, 2)

    assert stats["attempted"] == 2 and len(recovered) == 2
    assert [p["handle"] for p in missing] == ["item-2", "item-3", "item-4", "item-5"]


def test_a_fetch_failure_leaves_the_product_for_the_next_step():
    class Failing:
        def fetch(self, url): raise bp.FetchError(503, "upstream said no")
    recovered, missing, stats = bp.enrich_from_pages(
        "m", "https://s.com", [product(0)], Failing(), 10)
    assert recovered == [] and stats["failed"] == 1
    assert [p["handle"] for p in missing] == ["item-0"]


# --------------------------------------------------------------------------- step 2

def test_llm_partitions_into_recovered_and_missing(monkey=None):
    products = [product(i) for i in range(4)]
    orig = bp.extract_with_llm
    bp.extract_with_llm = (lambda p, cfg, client=None, errors=None:
                           a_hit() if p["id"] % 2 == 0 else None)
    try:
        recovered, missing = bp.enrich_with_llm("m", "https://s.com", products, CFG, 10)
    finally:
        bp.extract_with_llm = orig
    assert [r["handle"] for r in recovered] == ["item-0", "item-2"]
    assert [p["handle"] for p in missing] == ["item-1", "item-3"]


def test_llm_keeps_input_order_when_parallel():
    """curate() breaks confidence ties by position, so a run must not reshuffle itself."""
    products = [product(i) for i in range(20)]
    orig = bp.extract_with_llm

    def slow(p, cfg, client=None, errors=None):
        time.sleep(0.02 if p["id"] % 3 else 0.001)   # finish out of order on purpose
        return a_hit()
    bp.extract_with_llm = slow
    try:
        recovered, _ = bp.enrich_with_llm("m", "https://s.com", products, CFG, 20, 8)
    finally:
        bp.extract_with_llm = orig
    assert [r["handle"] for r in recovered] == [f"item-{i}" for i in range(20)]


def test_a_product_with_no_image_is_missing_not_recovered():
    p = product(0); p["images"] = []
    orig = bp.extract_with_llm
    bp.extract_with_llm = lambda *a, **k: a_hit()
    try:
        recovered, missing = bp.enrich_with_llm("m", "https://s.com", [p], CFG, 10)
    finally:
        bp.extract_with_llm = orig
    assert recovered == [] and len(missing) == 1


# --------------------------------------------------------------------------- step 3

def test_vlm_stops_at_the_first_image_that_answers():
    """Three calls a product is the worst case, not the normal one."""
    products = [product(0, images=4)]
    client = FakeClient()
    orig = bp.extract_with_vlm
    bp.extract_with_vlm = lambda b, mt, cfg, c=None, errors=None: a_hit()
    try:
        rows = bp.enrich_with_vlm("m", "https://s.com", products, CFG, 10, client)
    finally:
        bp.extract_with_vlm = orig
    assert len(rows) == 1
    assert len(client.gets) == 1, f"stopped after {len(client.gets)} images, want 1"


def test_vlm_tries_at_most_three_images_and_skips_the_hero_shot():
    products = [product(0, images=6)]
    client = FakeClient()
    orig = bp.extract_with_vlm
    bp.extract_with_vlm = lambda b, mt, cfg, c=None, errors=None: None   # never answers
    try:
        rows = bp.enrich_with_vlm("m", "https://s.com", products, CFG, 10, client)
    finally:
        bp.extract_with_vlm = orig
    assert rows == []
    assert len(client.gets) == 3, f"made {len(client.gets)} image calls, want 3"
    assert "0-0.jpg" not in " ".join(client.gets), "image 1 is the hero shot, not a diagram"


# --------------------------------------------------------------------------- concurrency

def test_the_pool_actually_overlaps_calls():
    """The whole point. Serial, 12 x 0.1s is 1.2s; at 8 workers it should be a fraction."""
    products = [product(i) for i in range(12)]
    orig = bp.extract_with_llm
    bp.extract_with_llm = (lambda p, cfg, client=None, errors=None:
                           (time.sleep(0.1), a_hit())[1])
    try:
        t = time.time()
        bp.enrich_with_llm("m", "https://s.com", products, CFG, 12, 1)
        serial = time.time() - t

        t = time.time()
        bp.enrich_with_llm("m", "https://s.com", products, CFG, 12, 8)
        pooled = time.time() - t
    finally:
        bp.extract_with_llm = orig
    assert serial > 1.0, f"serial baseline was {serial:.2f}s, test is not measuring anything"
    assert pooled < serial / 3, f"pooled {pooled:.2f}s vs serial {serial:.2f}s — no overlap"


def test_concurrency_of_one_is_still_serial():
    """--ai-concurrency 1 has to restore the old behaviour exactly, as an escape hatch."""
    seen = []
    orig = bp.extract_with_llm
    bp.extract_with_llm = (lambda p, cfg, client=None, errors=None:
                           (seen.append(p["id"]), a_hit())[1])
    try:
        bp.enrich_with_llm("m", "https://s.com", [product(i) for i in range(5)], CFG, 5, 1)
    finally:
        bp.extract_with_llm = orig
    assert seen == [0, 1, 2, 3, 4], seen


def test_in_parallel_is_a_no_op_on_an_empty_list():
    assert bp._in_parallel([], lambda x: 1 / 0, 8) == []


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
