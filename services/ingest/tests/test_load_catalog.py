"""The D1 + R2 loader. Run: python3 tests/test_load_catalog.py

The SQL this generates is applied to the real database with `wrangler d1 execute --remote`, so
it gets tested against the project's actual schema (workers/src/schema.sql) in an in-memory
SQLite, not against a hand-written table that could drift from it.
"""

import json, os, sqlite3, sys, pathlib, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import load_catalog
from app.identity import object_id

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCHEMA = ROOT / "workers" / "src" / "schema.sql"


def _db():
    c = sqlite3.connect(":memory:")
    c.executescript(SCHEMA.read_text())
    return c


def _manifest(tmp, products):
    p = os.path.join(tmp, "manifest.json")
    json.dump({"products": products}, open(p, "w"))
    return p


def _product(**kw):
    return {
        "productId": "1", "merchant": "Shop", "title": "Thing",
        "handle": "thing", "productUrl": "https://shop.com/products/thing",
        "r2Key": "catalog/Shop/1/source.jpg", "category": "chairs",
        "bboxMeters": {"w": 0.5, "h": 0.8, "d": 0.5},
        "measure": {"method": "extracted", "confidence": 0.85}, **kw,
    }


def test_generated_sql_applies_to_the_real_schema():
    with tempfile.TemporaryDirectory() as tmp:
        rows = load_catalog.load_rows(_manifest(tmp, [_product()]))
        c = _db()
        c.executescript(open(load_catalog.write_sql(rows, tmp)).read())
        got = c.execute("SELECT id, source, state, name, bbox_w, merchant FROM objects").fetchone()
        assert got[1] == "catalog" and got[2] == "measured"
        assert got[3] == "Thing" and got[4] == 0.5 and got[5] == "Shop"


def test_reload_is_idempotent():
    """The property the whole design rests on: run the load twice, get one row."""
    with tempfile.TemporaryDirectory() as tmp:
        rows = load_catalog.load_rows(_manifest(tmp, [_product()]))
        sql = open(load_catalog.write_sql(rows, tmp)).read()
        c = _db()
        c.executescript(sql)
        c.executescript(sql)
        assert c.execute("SELECT COUNT(*) FROM objects").fetchone()[0] == 1


def test_reload_refreshes_dimensions():
    with tempfile.TemporaryDirectory() as tmp:
        c = _db()
        c.executescript(open(load_catalog.write_sql(
            load_catalog.load_rows(_manifest(tmp, [_product()])), tmp)).read())
        bigger = _product(bboxMeters={"w": 1.4, "h": 0.8, "d": 0.5})
        c.executescript(open(load_catalog.write_sql(
            load_catalog.load_rows(_manifest(tmp, [bigger])), tmp)).read())
        assert c.execute("SELECT bbox_w FROM objects").fetchone()[0] == 1.4


def test_reload_does_not_clobber_a_generated_mesh():
    """Ani's mesh and state:"ready" must survive a catalogue reload. The dimensions are ours
    to refresh; the mesh is not."""
    with tempfile.TemporaryDirectory() as tmp:
        rows = load_catalog.load_rows(_manifest(tmp, [_product()]))
        sql = open(load_catalog.write_sql(rows, tmp)).read()
        c = _db()
        c.executescript(sql)
        c.execute("UPDATE objects SET glb_key = 'objects/a/mesh.glb', state = 'ready'")
        c.executescript(sql)
        glb, state = c.execute("SELECT glb_key, state FROM objects").fetchone()
        assert glb == "objects/a/mesh.glb" and state == "ready"


def test_apostrophe_in_a_title_does_not_break_the_sql():
    """Titles come off a stranger's storefront. "Levi's Chair" is not an edge case."""
    with tempfile.TemporaryDirectory() as tmp:
        rows = load_catalog.load_rows(_manifest(tmp, [_product(title="Levi's ' Chair")]))
        c = _db()
        c.executescript(open(load_catalog.write_sql(rows, tmp)).read())
        assert c.execute("SELECT name FROM objects").fetchone()[0] == "Levi's ' Chair"


def test_missing_bbox_axis_is_rejected_loudly():
    with tempfile.TemporaryDirectory() as tmp:
        path = _manifest(tmp, [_product(bboxMeters={"w": 0.5, "h": 0.8})])
        try:
            load_catalog.load_rows(path)
        except SystemExit as e:
            assert "bboxMeters.d" in str(e)
            return
        raise AssertionError("expected a loud failure on a missing axis")


def test_ids_match_what_the_service_mints():
    """The loader and the service must agree, or the same product lands twice under two ids."""
    with tempfile.TemporaryDirectory() as tmp:
        rows = load_catalog.load_rows(_manifest(tmp, [_product()]))
        assert rows[0]["objectId"] == object_id("Shop", "https://shop.com/products/thing", "1", "thing")


def test_ndjson_rows_keep_the_service_id_and_price():
    with tempfile.TemporaryDirectory() as tmp:
        oid = object_id("Shop", "https://shop.com/products/thing")
        path = os.path.join(tmp, "c.ndjson")
        with open(path, "w") as fh:
            fh.write(json.dumps({
                "objectId": oid, "name": "Thing", "category": "chairs",
                "bboxMeters": {"w": 0.5, "h": 0.8, "d": 0.5},
                "measure": {"method": "extracted", "confidence": 0.9},
                "price": {"cents": 34900, "currency": "USD"},
                "productUrl": "https://shop.com/products/thing", "merchant": "Shop",
                "extraction": {"imageUrl": "https://cdn.shop.com/a.jpg"},
            }) + "\n")
        rows = load_catalog.load_rows(path)
        assert rows[0]["objectId"] == oid
        c = _db()
        c.executescript(open(load_catalog.write_sql(rows, tmp)).read())
        assert c.execute("SELECT price_cents, currency FROM objects").fetchone() == (34900, "USD")


def test_r2_script_uses_the_contract_key_layout():
    with tempfile.TemporaryDirectory() as tmp:
        rows = load_catalog.load_rows(_manifest(tmp, [_product()]))
        path, n = load_catalog.write_r2_script(rows, tmp, "bkt", tmp)
        body = open(path).read()
        assert n == 1
        assert "catalog/Shop/1/source.jpg" in body
        assert os.access(path, os.X_OK), "the script must be executable"


def test_the_committed_prebake_manifest_loads():
    """The real 100-product handoff, not a synthetic one."""
    real = pathlib.Path(__file__).resolve().parents[1] / "prebake" / "manifest.json"
    if not real.exists():
        print("  (skipped: prebake/manifest.json not present)")
        return
    rows = load_catalog.load_rows(str(real))
    assert len(rows) == 100, len(rows)
    assert len({r["objectId"] for r in rows}) == 100, "duplicate ids in the real manifest"
    with tempfile.TemporaryDirectory() as tmp:
        c = _db()
        c.executescript(open(load_catalog.write_sql(rows, tmp)).read())
        assert c.execute("SELECT COUNT(*) FROM objects").fetchone()[0] == 100
        assert c.execute(
            "SELECT COUNT(*) FROM objects WHERE bbox_w IS NULL OR bbox_h IS NULL "
            "OR bbox_d IS NULL").fetchone()[0] == 0


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
