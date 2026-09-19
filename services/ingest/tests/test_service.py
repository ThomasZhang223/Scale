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
    assert chair["price"]["cents"] == 24900
    assert chair["productUrl"] == "https://shop.test/products/oak-chair"


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

    def slow_llm(p, cfg, http=None):
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
