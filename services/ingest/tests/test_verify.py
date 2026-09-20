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


def _connect_error(cause: BaseException) -> httpx.ConnectError:
    """A ConnectError with a realistic __cause__, as httpx raises in the wild."""
    err = httpx.ConnectError("connection failed")
    err.__cause__ = cause
    return err


def test_dns_failure_is_named_as_such():
    import socket
    # macOS wording; Linux says "Name or service not known". Both must classify the same.
    for msg in ("[Errno 8] nodename nor servname provided, or not known",
                "[Errno -2] Name or service not known"):
        status, note = vm.classify_error(_connect_error(socket.gaierror(msg)))
        assert status == "dns_error", f"{msg!r} -> {status}"
        assert "resolve" in note


def test_timeout_is_not_a_dns_error():
    status, note = vm.classify_error(httpx.ConnectTimeout("timed out"))
    assert status == "timeout" and "timed out" in note


def test_refused_connection():
    status, note = vm.classify_error(_connect_error(ConnectionRefusedError("[Errno 61] Connection refused")))
    assert status == "refused"


def test_tls_failure():
    import ssl
    status, note = vm.classify_error(_connect_error(ssl.SSLCertVerificationError("certificate has expired")))
    assert status == "tls_error" and "certificate" in note


def test_unknown_error_still_reports_its_type():
    status, note = vm.classify_error(httpx.HTTPError("something odd"))
    assert status == "error" and "HTTPError" in note


def test_coverage_buckets_products_by_category():
    r = run("good")
    # The fixture's products have no product_type, so they land in "uncategorised" and count
    # toward no demo bucket — which is exactly the gap the report is meant to surface.
    assert r.usable_products == 30
    assert sum(vm.coverage([r]).values()) == 0


def test_coverage_counts_a_real_product_type():
    import copy
    srv, base = serve("good")
    try:
        with httpx.Client(headers={"User-Agent": vm.USER_AGENT}, timeout=5) as c:
            rep = vm.check(c, "good", base, 250)
        for p in rep._products:
            p["product_type"] = "Desks"
        rep.categories = {"desks": 30}
        assert vm.coverage([rep])["surface"] == 30
    finally:
        srv.shutdown()


def test_a_table_lamp_is_lighting_not_a_surface():
    """First-match-in-dict-order put "table lamps" in `surface` because "table" is a surface
    keyword, so a real run reported "lighting 0" while holding a lighting merchant's catalogue."""
    assert vm.bucket_for("table lamps") == "lighting"
    assert vm.bucket_for("floor lamp") == "lighting"
    assert vm.bucket_for("dining table") == "surface"


def test_an_empty_product_type_falls_back_to_the_title():
    """101 usable products came back with no product_type at all on a real run; the title
    names the thing in every one of those cases."""
    assert vm.bucket_for("", "Brass Floor Lamp") == "lighting"
    assert vm.bucket_for("", "Oak Bookshelf") == "storage"
    assert vm.bucket_for("", "") is None


def test_spaced_and_plural_spellings_match():
    """'foyer/hall lanterns' and 'night stands' were both uncategorised on a real run."""
    assert vm.bucket_for("foyer/hall lanterns") == "lighting"
    assert vm.bucket_for("night stands") == "surface"


def test_longest_keyword_wins_outside_lighting():
    assert vm.bucket_for("bookcase") == "storage"
    assert vm.bucket_for("sofas") == "seating"


def test_uncategorised_lists_what_matched_nothing():
    r = run("good")
    r.categories = {"table lamps": 4, "throws & blankets": 9}
    assert vm.coverage([r])["lighting"] == 4
    assert vm.uncategorised([r]) == [("throws & blankets", 9)]


def test_output_keys_are_camel_case_like_the_example_file():
    """merchants.verified.json must match merchants.example.json's shape — the crawler reads it."""
    import json as _json
    example = _json.load(open(pathlib.Path(__file__).resolve().parents[1] / "merchants.example.json"))
    expected = set(example["merchants"][0]) - {"_comment"}
    got = set(run("good").to_dict())
    missing = expected - got
    assert not missing, f"generated output is missing documented keys: {missing}"
    snake = [k for k in got if "_" in k]
    assert not snake, f"generated output has snake_case keys: {snake}"


def test_cli_probe_mode_succeeds_on_one_store():
    """A one-off --url probe is a lookup, not the H-4 gate: finding one store is not a failure."""
    import subprocess
    srv, base = serve("good")
    try:
        r = subprocess.run(
            [sys.executable, "verify_merchants.py", "--url", base],
            cwd=pathlib.Path(__file__).resolve().parents[1],
            capture_output=True, text=True,
        )
        assert r.returncode == 0, f"probe exited {r.returncode}:\n{r.stderr}"
        assert "usable" in r.stdout
    finally:
        srv.shutdown()


def test_cli_file_mode_gates_on_product_count():
    """A candidates file IS the gate. Products are the requirement, not merchants."""
    import subprocess, json as _json, tempfile, os
    srv, base = serve("good")
    fd, path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            _json.dump({"merchants": [{"name": "One", "storefrontBaseUrl": base}]}, f)
        r = subprocess.run(
            [sys.executable, "verify_merchants.py", path],
            cwd=pathlib.Path(__file__).resolve().parents[1],
            capture_output=True, text=True,
        )
        assert r.returncode == 1
        assert "usable products" in r.stderr, r.stderr
    finally:
        srv.shutdown()
        os.unlink(path)



# --- beds are a category, soft goods are not ------------------------------

def test_beds_get_their_own_category_instead_of_falling_into_other():
    """20 of 100 slots in a real handoff went to beds and mattresses via `other`, four
    colourways of one model among them. If they are in the set they are in it on purpose."""
    assert vm.bucket_for("beds", "Orbit Bed") == "sleeping"
    assert vm.bucket_for("mattresses", "The Mattress 2.0") == "sleeping"
    assert vm.bucket_for("daybeds", "") == "sleeping"
    # product_type is often empty; the title has to carry it.
    assert vm.bucket_for("", "The Floyd Bed — Upholstered, Lift Off") == "sleeping"


def test_soft_goods_are_not_placeable_even_when_they_contain_a_category_word():
    """"bedding" contains "bed" and "table runner" contains "table". Neither is an object you
    place against a room scan, and substring matching would have taken both."""
    assert vm.bucket_for("Bedding", "Duvet cover") is None
    assert vm.bucket_for("Pillows", "Throw Pillow") is None
    assert vm.bucket_for("Rugs", "Jute Runner") is None
    assert vm.bucket_for("Mirrors", "Full Length Mirror") is None
    assert vm.bucket_for("Gift Cards", "Gift card") is None


def test_the_exclusion_does_not_swallow_real_furniture():
    assert vm.bucket_for("Sofas", "Sectional") == "seating"
    assert vm.bucket_for("Bedside Tables", "Nightstand") == "surface"
    assert vm.bucket_for("Table Lamps", "") == "lighting"
    assert vm.bucket_for("Bookcases", "") == "storage"

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
