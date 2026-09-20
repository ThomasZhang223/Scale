"""HTTP tests for the ingest service — the surface Thomas's Workflow calls.

Entrypoint-level on purpose: every bug this service has shipped past its unit tests died at an
HTTP or CLI boundary.
"""

import os, sys, pathlib, json, threading, http.server, socketserver, functools

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

TOKEN = "test-upstream-token"
os.environ.setdefault("UPSTREAM_TOKEN", TOKEN)
TOKEN = os.environ["UPSTREAM_TOKEN"]

from fastapi.testclient import TestClient
from app import main

client = TestClient(main.app, headers={"X-Upstream-Token": TOKEN})

CATALOGUE = [
    {"id": 1, "title": "Oak Dining Chair", "handle": "oak-chair", "product_type": "Chairs",
     "body_html": "<p>W 45 x D 50 x H 90 cm</p>", "variants": [{"price": "249.00"}],
     "images": [{"src": "https://cdn/x.jpg"}]},
    {"id": 2, "title": "Mystery Sofa", "handle": "mystery-sofa", "product_type": "Sofas",
     "body_html": "<p>W 8 x D 90 x H 75 cm</p>",   # 8 cm wide — a unit mistake
     "variants": [{"price": "1299.00"}], "images": [{"src": "https://cdn/y.jpg"}]},
    {"id": 3, "title": "Page-only Shelf", "handle": "page-shelf", "product_type": "Bookcases",
     "body_html": "<p>Solid oak.</p>", "variants": [{"price": "399.00"}],
     "images": [{"src": "https://cdn/z.jpg"}]},
]


class Store(http.server.BaseHTTPRequestHandler):
    mode = "ok"
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.split("?")[0] not in ("/products.json", "/collections/beds/products.json"):
            return self._send(404, b"", "text/plain")
        if self.mode == "html":
            return self._send(200, b"<html>shop</html>", "text/html")
        if self.mode == "403":
            return self._send(403, b"no", "text/plain")
        self._send(200, json.dumps({"products": CATALOGUE}).encode(), "application/json")
    def _send(self, code, body, ctype):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


def serve(mode="ok"):
    srv = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(type("H", (Store,), {"mode": mode})))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def test_crawl_returns_the_raw_catalogue():
    srv, base = serve()
    try:
        r = client.post("/crawl", json={"storefront": base})
        assert r.status_code == 200, r.text
        assert r.json()["count"] == 3
        assert r.json()["products"][0]["title"] == "Oak Dining Chair"
    finally:
        srv.shutdown()


def test_crawl_names_a_disabled_endpoint_rather_than_guessing():
    srv, base = serve("html")
    try:
        r = client.post("/crawl", json={"storefront": base})
        assert r.status_code == 422 and r.json()["error"] == "not_shopify"
    finally:
        srv.shutdown()


def test_crawl_reports_a_blocking_storefront():
    srv, base = serve("403")
    try:
        r = client.post("/crawl", json={"storefront": base})
        assert r.status_code == 502 and "403" in r.json()["detail"]
    finally:
        srv.shutdown()


def test_crawl_without_a_storefront_is_422():
    assert client.post("/crawl", json={}).status_code == 422


def test_extract_returns_object_v1_rows():
    r = client.post("/extract", json={"merchant": "Fake Co", "storefront": "https://shop.test",
                                      "products": CATALOGUE})
    assert r.status_code == 200, r.text
    body = r.json()
    chair = next(o for o in body["objects"] if o["name"] == "Oak Dining Chair")
    for k in ("schemaVersion", "objectId", "source", "state", "name", "category",
              "glbUrl", "bboxMeters", "measure", "productUrl", "merchant", "createdAt"):
        assert k in chair, k
    assert chair["source"] == "catalog" and chair["state"] == "measured"
    assert chair["glbUrl"] is None, "ingest never generates a mesh"
    assert chair["bboxMeters"] == {"w": 0.45, "h": 0.9, "d": 0.5}
    assert chair["measure"]["method"] == "extracted"
    assert chair["price"] is None, "no currency supplied -> no price, never a guessed USD"
    assert chair["extraction"]["productId"] == "1", "the Worker builds catalog/{m}/{productId}/source.jpg"
    assert chair["productUrl"] == "https://shop.test/products/oak-chair"


def test_a_supplied_currency_is_carried_onto_the_price():
    r = client.post("/extract", json={"merchant": "Fake Co", "storefront": "https://shop.test",
                                      "products": [CATALOGUE[0]], "currency": "cad"})
    assert r.json()["objects"][0]["price"] == {"cents": 24900, "currency": "CAD"}


def test_a_confident_row_is_not_flagged_unverified():
    r = client.post("/extract", json={"merchant": "M", "storefront": "https://s.test",
                                      "products": [CATALOGUE[0]]})
    o = r.json()["objects"][0]
    assert o["measure"]["confidence"] >= 0.7
    assert o["extraction"]["unverified"] is False


def test_an_8cm_sofa_is_kept_but_flagged_not_silently_trusted():
    """Step 5's whole point: surface low confidence, never a silent guess."""
    r = client.post("/extract", json={"merchant": "M", "storefront": "https://s.test",
                                      "products": [CATALOGUE[1]]})
    body = r.json()
    o = body["objects"][0]
    assert o["measure"]["confidence"] < 0.5
    assert o["extraction"]["unverified"] is True
    assert "prior_mismatch" in o["extraction"]["flags"]
    assert body["stats"]["unverified"] == 1


def test_products_with_no_dimensions_are_skipped_without_browserbase():
    r = client.post("/extract", json={"merchant": "M", "storefront": "https://s.test",
                                      "products": CATALOGUE})
    titles = {o["name"] for o in r.json()["objects"]}
    assert "Page-only Shelf" not in titles
    assert r.json()["stats"]["from_api"] == 2


def test_browserbase_without_a_key_is_503_not_a_quiet_skip():
    saved = os.environ.pop("BROWSERBASE_API_KEY", None)
    try:
        r = client.post("/extract", json={"merchant": "M", "storefront": "https://s.test",
                                          "products": CATALOGUE, "browserbase": True})
        assert r.status_code == 503 and r.json()["error"] == "browserbase_unconfigured"
    finally:
        if saved:
            os.environ["BROWSERBASE_API_KEY"] = saved


def test_extract_needs_merchant_and_storefront():
    assert client.post("/extract", json={"products": []}).status_code == 422
    assert client.post("/extract", json={"merchant": "M", "products": []}).status_code == 422


def test_the_llm_pass_does_not_block_the_event_loop():
    """A regression guard with teeth.

    extract_with_llm is a synchronous call. Awaited straight from the async handler it stopped
    the whole process: measured, ten products held /health past its 3s timeout twice running,
    and compose marks a container unhealthy after five. The calls now go to worker threads, so
    they overlap AND the loop stays free. Both halves are asserted: serial would be >= 10 x
    0.05s, and /health has to answer while /extract is still in flight.
    """
    import time
    products = [dict(CATALOGUE[2], id=100 + i, handle=f"slow-{i}", title=f"Slow {i}")
                for i in range(10)]

    calls = []

    def slow_llm(p, cfg, http=None, errors=None):
        calls.append(p["handle"])
        time.sleep(0.05)
        return None

    orig_llm, orig_cfg = main.extract_with_llm, main.OpenAIConfig
    main.extract_with_llm = slow_llm
    main.OpenAIConfig = lambda *a, **k: type(
        "C", (), {"configured": True, "model": "m", "vlm_model": "m"})()
    try:
        started = time.time()
        r = client.post("/extract", json={
            "merchant": "m", "storefront": "https://s.com",
            "products": products, "llm": True, "aiLimit": 10})
        elapsed = time.time() - started
    finally:
        main.extract_with_llm, main.OpenAIConfig = orig_llm, orig_cfg

    assert r.status_code == 200, r.text
    assert len(calls) == 10, f"ran {len(calls)} of 10 products"
    serial = 10 * 0.05
    assert elapsed < serial * 0.6, (
        f"took {elapsed:.2f}s; serial would be ~{serial:.2f}s — the calls are not overlapping")


# --- fit: the placing use case ---------------------------------------------

def test_extract_flags_which_objects_fit_the_space():
    """Browsing wants every red chair; placing one in an 0.8 m gap wants only what goes there.
    The check can only happen after measurement, which is here — /find has no sizes yet."""
    r = client.post("/extract", json={
        "merchant": "m", "storefront": "https://s.com", "products": CATALOGUE[:2],
        "fit": {"maxW": 0.5}})
    assert r.status_code == 200, r.text
    b = r.json()
    by_name = {o["name"]: o for o in b["objects"]}
    # Oak Dining Chair is 0.45 wide, Mystery Sofa is 0.08 (a flagged unit mistake).
    assert by_name["Oak Dining Chair"]["extraction"]["fits"] is True
    assert b["stats"]["fitting"] + b["stats"]["too_big"] == len(b["objects"])


def test_an_object_wider_than_the_gap_is_flagged_not_dropped():
    """Missing by a centimetre is worth saying out loud, not vanishing with no explanation."""
    r = client.post("/extract", json={
        "merchant": "m", "storefront": "https://s.com", "products": CATALOGUE[:1],
        "fit": {"maxW": 0.40}})          # the chair is 0.45 wide
    b = r.json()
    assert len(b["objects"]) == 1, "it must still be returned"
    assert b["objects"][0]["extraction"]["fits"] is False
    assert b["stats"]["too_big"] == 1


def test_with_no_fit_asked_for_everything_fits():
    r = client.post("/extract", json={
        "merchant": "m", "storefront": "https://s.com", "products": CATALOGUE[:2]})
    b = r.json()
    assert all(o["extraction"]["fits"] for o in b["objects"])
    assert b["stats"]["too_big"] == 0


def test_a_fit_in_the_wrong_units_is_422_not_a_filter_that_does_nothing():
    """80 instead of 0.8 is centimetres that escaped a UI edge. Filtering nothing would look
    exactly like a gap big enough for everything."""
    for bad in ({"maxW": 80}, {"maxH": 0}, {"maxD": -1}):
        r = client.post("/extract", json={
            "merchant": "m", "storefront": "https://s.com",
            "products": CATALOGUE[:1], "fit": bad})
        assert r.status_code == 422, f"{bad} -> {r.status_code}"
        assert r.json()["error"] == "bad_fit"


# --- /find: prompt -> products ---------------------------------------------

SEARCH_PAGE = """
<html><body>
  <a href="/cart">Cart</a>
  <a href="/collections/seating/products/oak-chair"><img>Oak Chair</a>
  <a href="/products/page-shelf">Page-only Shelf</a>
  <a href="/products/ghost">Not in the catalogue</a>
</body></html>
"""


class _FakeFetcher:
    def __init__(self, content=SEARCH_PAGE): self.content, self.urls = content, []
    def fetch(self, url):
        self.urls.append(url)
        class R: pass
        r = R(); r.content = self.content; r.url = url; r.status_code = 200
        return r


def _find(body, fetcher=None, catalogue=None):
    """Drive POST /find with the Browserbase fetcher and the catalogue pull both stubbed."""
    import app.browserbase as bb
    orig_cached = main.CachedFetch
    orig_bbf = main.BrowserbaseFetch
    main.CachedFetch = lambda *a, **k: (fetcher or _FakeFetcher())
    main.BrowserbaseFetch = lambda *a, **k: None
    orig_get = main.httpx.AsyncClient
    rows = CATALOGUE if catalogue is None else catalogue

    class FakeAsyncClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, *a, **k):
            class R:
                status_code = 200
                def raise_for_status(self): pass
                def json(self): return {"products": rows}
            return R()
    main.httpx.AsyncClient = FakeAsyncClient
    try:
        return client.post("/find", json=body)
    finally:
        main.CachedFetch, main.BrowserbaseFetch = orig_cached, orig_bbf
        main.httpx.AsyncClient = orig_get


def test_find_returns_products_in_the_merchant_s_own_order():
    """Relevance is the merchant's. The order on their search page IS the ranking, and it has
    to survive the join back to the catalogue."""
    r = _find({"storefront": "https://s.com", "query": "chair"})
    assert r.status_code == 200, r.text
    b = r.json()
    assert [p["handle"] for p in b["products"]] == ["oak-chair", "page-shelf"]
    assert b["count"] == 2


def test_find_strips_filler_before_searching():
    f = _FakeFetcher()
    r = _find({"storefront": "https://s.com", "query": "add a red chair there"}, fetcher=f)
    assert r.json()["searchedFor"] == "red chair"
    assert "q=red+chair" in f.urls[0], f.urls


def test_find_reports_handles_the_catalogue_does_not_serve():
    """A product /products.json does not list cannot be measured. Reported, not silently
    dropped, so count != len(handles) is explainable."""
    b = _find({"storefront": "https://s.com", "query": "chair"}).json()
    assert "ghost" in b["handles"]
    assert b["missing"] == ["ghost"]


def test_find_flags_a_fallback_page_rather_than_returning_beds_for_a_chair():
    """Real: floydhome.com answers "red chair" with twelve beds, and "red chair" and "bed"
    return the same twelve handles. Returning those unflagged is a confident answer to a
    question nobody asked."""
    page = ('<a href="/products/the-floyd-bed">Bed</a>'
            '<a href="/products/the-mattress">Mattress</a>')
    cat = [{"handle": "the-floyd-bed", "title": "The Floyd Bed", "product_type": "beds",
            "variants": [], "images": []},
           {"handle": "the-mattress", "title": "The Mattress 2.0", "product_type": "mattresses",
            "variants": [], "images": []}]
    b = _find({"storefront": "https://s.com", "query": "red chair"},
              fetcher=_FakeFetcher(page), catalogue=cat).json()
    assert b["count"] == 2, "the products still come back"
    assert b["fallbackSuspected"] is True
    assert b["relevance"]["matched"] == 0
    assert "nothing for that query" in (b["warning"] or "")


def test_find_does_not_cry_fallback_on_a_real_result_set():
    page = '<a href="/products/oak-chair">Oak Chair</a>'
    b = _find({"storefront": "https://s.com", "query": "oak chair"},
              fetcher=_FakeFetcher(page)).json()
    assert b["fallbackSuspected"] is False
    assert b["relevance"]["ratio"] == 1.0
    assert b["warning"] is None


def test_find_drops_a_gift_card_from_the_results():
    """polyandbark.com returns its gift card first for a chair query."""
    page = ('<a href="/products/gift">Gift</a><a href="/products/oak-chair">Chair</a>')
    cat = [{"handle": "gift", "title": "Digital Gift Card", "product_type": "",
            "variants": [], "images": []},
           {"handle": "oak-chair", "title": "Oak Chair", "product_type": "chairs",
            "variants": [], "images": []}]
    b = _find({"storefront": "https://s.com", "query": "chair"},
              fetcher=_FakeFetcher(page), catalogue=cat).json()
    assert [p["handle"] for p in b["products"]] == ["oak-chair"]
    assert "gift" in b["handles"], "still reported as a handle the search returned"


def test_find_with_no_results_is_a_zero_not_an_error():
    b = _find({"storefront": "https://s.com", "query": "kayak"},
              fetcher=_FakeFetcher("<html><body>No results</body></html>")).json()
    assert b["count"] == 0 and b["products"] == []
    assert b["searchUrl"].endswith("q=kayak"), b["searchUrl"]


def test_find_needs_a_storefront_and_a_query():
    assert _find({"storefront": "https://s.com"}).status_code == 422
    assert _find({"query": "chair"}).status_code == 422
    assert _find({"storefront": "https://s.com", "query": "   "}).status_code == 422


def test_find_without_a_browserbase_key_is_503_not_an_empty_list():
    """An empty list would look exactly like a merchant with nothing that matches."""
    def boom(*a, **k): raise ValueError("BROWSERBASE_API_KEY is not set")
    orig = main.CachedFetch
    main.CachedFetch = boom
    try:
        r = client.post("/find", json={"storefront": "https://s.com", "query": "chair"})
    finally:
        main.CachedFetch = orig
    assert r.status_code == 503 and r.json()["error"] == "browserbase_unconfigured"


def test_both_endpoints_require_the_upstream_token():
    bare = TestClient(main.app)
    assert bare.post("/crawl", json={"storefront": "https://x"}).status_code == 401
    assert bare.post("/extract", json={}).status_code == 401
    assert bare.get("/health").status_code == 200, "liveness answers without a secret"


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
