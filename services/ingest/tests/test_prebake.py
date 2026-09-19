"""Tests for the Ani handoff. Run: python3 tests/test_prebake.py

Exercises the CLI against a local fake storefront, including image download, because the last
three bugs in this service were all at an entrypoint rather than in the logic behind it.
"""

import json, sys, pathlib, threading, http.server, socketserver, functools, tempfile, subprocess, os

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import build_prebake as bp

bp.REQUEST_DELAY_S = 0

PIXEL = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000a49444154789c6360000002000100ffff0300000600"
    "05570c1a250000000049454e44ae426082"
)

CATS = [("Desks", "surface"), ("Sofas", "seating"), ("Bookcases", "storage"),
        ("Table Lamps", "lighting")]

# A Floyd-shaped product page: no dimensions in the API, but the page renders them.
PRODUCT_PAGE = """
<html><body><h1>Shelf</h1>
<details><summary>Dimensions</summary><div>60" W x 30" D x 29" H</div></details>
</body></html>
"""


def catalogue(port):
    out = []
    for i in range(40):
        ptype, _ = CATS[i % len(CATS)]
        out.append({
            "id": 1000 + i, "title": f"{ptype[:-1]} {i}", "handle": f"item-{i}",
            "product_type": ptype, "variants": [{"title": "Default Title"}], "options": [],
            "body_html": "<p>W 152 x D 76 x H 74 cm</p>",
            "images": [{"src": f"http://127.0.0.1:{port}/img/{i}.png"}],
        })
    # Products with an image but NO dimensions in the API: invisible without step 2.5, and
    # rescued by it. This is the Floyd/Fyrn/Bend/Branch case, ~690 products.
    for i in range(6):
        out.append({
            "id": 3000 + i, "title": f"Page-only {i}", "handle": f"page-only-{i}",
            "product_type": "Bookcases", "variants": [], "options": [],
            "body_html": "<p>Solid oak. Made in Canada.</p>",
            "images": [{"src": f"http://127.0.0.1:{port}/img/p{i}.png"}],
        })
    # One with dimensions but no image, and one with an image but no dimensions and no handle:
    # both must be excluded, because a mesh needs a picture and a page fetch needs a handle.
    out.append({"id": 2001, "title": "No image", "handle": "no-image", "product_type": "Desks",
                "variants": [], "options": [], "body_html": "<p>W 152 x D 76 x H 74 cm</p>",
                "images": []})
    out.append({"id": 2002, "title": "No dims no handle", "handle": "", "product_type": "Desks",
                "variants": [], "options": [], "body_html": "<p>Solid oak.</p>",
                "images": [{"src": f"http://127.0.0.1:{port}/img/x.png"}]})
    return out


class Handler(http.server.BaseHTTPRequestHandler):
    port = 0
    def log_message(self, *a): pass
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/products.json":
            b = json.dumps({"products": catalogue(self.port)}).encode()
            ct = "application/json"
        elif p.startswith("/img/"):
            b, ct = PIXEL, "image/png"
        else:
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)


def serve():
    srv = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    srv.RequestHandlerClass = functools.partial(type("H", (Handler,), {"port": port}))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{port}/"


def prime_page_cache(cache_dir, base, handles):
    """Pre-fill the cache so --browserbase exercises the real path without an API call.
    Mirrors CachedFetch._path exactly — if that naming changes, these tests notice."""
    import hashlib
    os.makedirs(cache_dir, exist_ok=True)
    for h in handles:
        url = f"{base.rstrip('/')}/products/{h}"
        name = hashlib.sha256(url.encode()).hexdigest()[:24] + ".html"
        with open(os.path.join(cache_dir, name), "w") as f:
            f.write(PRODUCT_PAGE)


def run_cli(extra=(), limit="12", prime=()):
    srv, base = serve()
    tmp = tempfile.mkdtemp()
    verified = os.path.join(tmp, "v.json")
    cache = os.path.join(tmp, "pages")
    with open(verified, "w") as f:
        json.dump({"merchants": [{"name": "Fake Co", "storefrontBaseUrl": base,
                                  "productsJsonVerified": True}]}, f)
    if prime:
        prime_page_cache(cache, base, prime)
    env = {**os.environ, "BROWSERBASE_API_KEY": "test-key-not-used-when-cached"}
    try:
        r = subprocess.run(
            [sys.executable, "build_prebake.py", verified, "--out", os.path.join(tmp, "prebake"),
             "--limit", limit, "--page-cache", cache, *extra],
            cwd=ROOT, capture_output=True, text=True, env=env,
        )
        assert r.returncode == 0, f"exited {r.returncode}:\n{r.stderr}"
        with open(os.path.join(tmp, "prebake", "manifest.json")) as f:
            return json.load(f), tmp
    finally:
        srv.shutdown()


def test_manifest_has_images_and_dimensions_for_every_row():
    m, _ = run_cli()
    assert m["count"] == 12
    for row in m["products"]:
        assert row["imageUrl"], row
        assert set(row["bboxMeters"]) == {"w", "h", "d"}, row
        assert row["r2Key"].startswith("catalog/") and row["r2Key"].endswith("/source.jpg")


def test_products_missing_an_image_or_a_bbox_are_excluded():
    m, _ = run_cli(limit="40")
    titles = {r["title"] for r in m["products"]}
    assert "No image" not in titles, "a product with no picture cannot be meshed"
    assert "No dims no handle" not in titles, "no size and no page to read one from"


def test_without_browserbase_page_only_products_are_invisible():
    m, _ = run_cli(limit="40")
    assert not [r for r in m["products"] if r["title"].startswith("Page-only")]
    assert m["step2_5"] is None


def test_browserbase_rescues_products_the_api_had_no_dimensions_for():
    """The Floyd case: dimensions in metafields the endpoint does not serve, rendered on
    the page."""
    handles = [f"page-only-{i}" for i in range(6)]
    m, _ = run_cli(["--browserbase"], limit="40", prime=handles)
    rescued = [r for r in m["products"] if r["title"].startswith("Page-only")]
    assert len(rescued) == 6, f"expected 6 rescued, got {len(rescued)}"
    for r in rescued:
        assert r["bboxMeters"]["w"] > 1.5   # 60 inches
        assert r["extractedFrom"] == "spec_block"
    assert m["step2_5"]["recovered"] == 6
    assert m["step2_5"]["failed"] == 0
    assert m["fromPageFetch"] == 6
    assert all(r["via"] == "page" for r in rescued)


def test_api_rows_are_tagged_as_such():
    m, _ = run_cli(limit="12")
    assert all(r["via"] == "api" for r in m["products"])
    assert m["fromPageFetch"] == 0


def test_browserbase_without_a_key_refuses_rather_than_skipping():
    """Quietly producing a smaller manifest would look like the stores had no dimensions."""
    srv, base = serve()
    tmp = tempfile.mkdtemp()
    v = os.path.join(tmp, "v.json")
    with open(v, "w") as f:
        json.dump({"merchants": [{"name": "X", "storefrontBaseUrl": base,
                                  "productsJsonVerified": True}]}, f)
    env = {k: val for k, val in os.environ.items() if k != "BROWSERBASE_API_KEY"}
    try:
        r = subprocess.run(
            [sys.executable, "build_prebake.py", v, "--out", tmp, "--browserbase"],
            cwd=ROOT, capture_output=True, text=True, env=env,
        )
        assert r.returncode != 0
        assert "BROWSERBASE_API_KEY" in r.stderr
    finally:
        srv.shutdown()


def test_selection_is_balanced_across_categories():
    """Top-N by confidence would hand Ani whatever the biggest merchant sells most of."""
    m, _ = run_cli()
    counts = {k: v for k, v in m["byCategory"].items() if v}
    assert set(counts) >= {"seating", "surface", "storage", "lighting"}, counts
    assert max(counts.values()) - min(counts.values()) <= 1, counts


def test_download_writes_images_at_the_r2_key():
    m, tmp = run_cli(["--download"])
    assert m["imagesDownloaded"] == m["count"]
    for row in m["products"]:
        path = os.path.join(tmp, "prebake", row["r2Key"])
        assert os.path.exists(path), path
        assert os.path.getsize(path) > 0


def test_image_width_is_requested_from_the_cdn():
    """100 full-resolution hero shots is tens of MB of git history for files that belong in R2,
    and image-to-3D wants ~512-1024px anyway."""
    assert bp.sized("https://cdn.shopify.com/x.jpg", 1024) == "https://cdn.shopify.com/x.jpg?width=1024"
    assert bp.sized("https://cdn.shopify.com/x.jpg?v=1", 1024) == "https://cdn.shopify.com/x.jpg?v=1&width=1024"
    assert bp.sized("https://cdn.shopify.com/x.jpg", None) == "https://cdn.shopify.com/x.jpg"


def test_a_verified_file_with_no_merchants_fails_loudly():
    tmp = tempfile.mkdtemp()
    v = os.path.join(tmp, "v.json")
    with open(v, "w") as f:
        json.dump({"merchants": []}, f)
    r = subprocess.run([sys.executable, "build_prebake.py", v, "--out", tmp],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode != 0 and "no verified merchants" in r.stderr


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
