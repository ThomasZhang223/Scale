"""Integration tests for verify_merchants.check() against local fake storefronts.

Covers the four things that actually happen in the wild: a good catalogue, a catalogue with
no dimensions anywhere, an endpoint that is "disabled" by returning the HTML shop page with a
200, and one that 403s. Plus robots.txt.

Run: python3 tests/test_verify.py
"""

import json, sys, pathlib, threading, http.server, socketserver, functools

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import httpx
import verify_merchants as vm

vm.REQUEST_DELAY_S = 0  # don't sleep through the tests


def product(i, body=""):
    return {"id": i, "title": f"Item {i}", "variants": [{"title": "Default Title"}],
            "options": [], "body_html": body}


CATALOGUES = {
    "good": [product(i, "<p>W 152 x D 76 x H 74 cm</p>") for i in range(30)],
    "partial": ([product(i, "<p>W 152 x D 76 x H 74 cm</p>") for i in range(6)]
                + [product(i, "<p>Solid oak. Free shipping.</p>") for i in range(6, 30)]),
    "nodims": [product(i, "<p>Solid oak. Weight 24 kg.</p>") for i in range(30)],
    "thin": [product(i, "<p>W 152 x D 76 x H 74 cm</p>") for i in range(3)],
}


class Handler(http.server.BaseHTTPRequestHandler):
    mode = "good"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        raw = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/robots.txt":
            if self.mode == "robots":
                return self._send(200, "User-agent: *\nDisallow: /products.json\n", "text/plain")
            return self._send(404, "", "text/plain")
        if path == "/products.json":
            if self.mode == "blocked":
                return self._send(403, "forbidden", "text/plain")
            if self.mode == "html":
                return self._send(200, "<!doctype html><html>shop</html>", "text/html")
            if self.mode == "notshopify":
                return self._send(200, json.dumps({"items": []}), "application/json")
            return self._send(200, json.dumps({"products": CATALOGUES.get(self.mode, [])}),
                              "application/json")
        return self._send(404, "", "text/plain")


def serve(mode):
    handler = functools.partial(type("H", (Handler,), {"mode": mode}))
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/"


def run(mode, sample=250):
    srv, base = serve(mode)
    try:
        with httpx.Client(headers={"User-Agent": vm.USER_AGENT}, timeout=5) as c:
            return vm.check(c, mode, base, sample)
    finally:
        srv.shutdown()


def test_good_catalogue_is_verified():
    r = run("good")
    assert r.status == "ok" and r.products_json_verified
    assert r.fully_dimensioned_rate == 1.0
    assert r.example["bboxMeters"] == {"w": 1.52, "h": 0.74, "d": 0.76}


def test_partial_catalogue_reports_a_real_rate():
    r = run("partial")
    assert r.status == "ok"
    assert r.fully_dimensioned_rate == 0.2, r.fully_dimensioned_rate


def test_catalogue_without_dimensions_is_reachable_but_useless():
    r = run("nodims")
    # This is the case the whole script exists to catch: green on reachability, worthless.
    assert r.status == "ok" and r.products_json_verified
    assert r.fully_dimensioned_rate == 0.0
    assert r.fully_dimensioned_rate < vm.MIN_DIMENSION_RATE


def test_disabled_endpoint_serving_html_is_not_shopify():
    r = run("html")
    assert r.status == "not_shopify" and not r.products_json_verified


def test_json_without_products_key_is_not_shopify():
    r = run("notshopify")
    assert r.status == "not_shopify"


def test_403_is_blocked():
    r = run("blocked")
    assert r.status == "blocked" and r.http_status == 403


def test_robots_disallow_is_respected():
    r = run("robots")
    assert r.status == "robots_disallow" and not r.products_json_verified


def test_thin_catalogue_is_not_verified():
    r = run("thin")
    assert r.status == "thin" and not r.products_json_verified


def test_report_renders():
    out = vm.render([run("good"), run("nodims"), run("blocked")])
    assert "usable" in out and "reachable: 2/3" in out


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
