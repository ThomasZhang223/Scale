"""The deterministic objectId rule. Run: python3 tests/test_identity.py

These are the properties IngestMerchantWorkflow's `ON CONFLICT(id) DO UPDATE` depends on. If
any of them break, a second ingest of a merchant appends a duplicate catalogue to D1 instead
of refreshing it, and nobody notices until search returns everything twice.
"""

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.identity import canonical_product_key, object_id


def test_same_product_same_id():
    a = object_id("floyd", "https://floydhome.com/products/the-block")
    b = object_id("floyd", "https://floydhome.com/products/the-block")
    assert a == b


def test_id_is_stable_across_merchant_label():
    """build_prebake.py slugs the label, the Worker passes whatever ScoutAgent was given.
    The same product must not get two ids because two callers spelled the merchant
    differently — that is the whole reason identity keys on the URL."""
    a = object_id("Floyd_Home", "https://floydhome.com/products/the-block")
    b = object_id("floyd", "https://floydhome.com/products/the-block")
    assert a == b


def test_url_noise_does_not_change_identity():
    base = object_id("m", "https://shop.com/products/x")
    for noisy in (
        "https://www.shop.com/products/x",
        "https://SHOP.com/products/x/",
        "https://shop.com/products/x?variant=42",
        "https://shop.com/products/x#reviews",
    ):
        assert object_id("m", noisy) == base, noisy


def test_different_products_differ():
    a = object_id("m", "https://shop.com/products/x")
    b = object_id("m", "https://shop.com/products/y")
    assert a != b


def test_different_merchants_same_path_differ():
    """Two storefronts both selling /products/sofa are two rows, not one."""
    a = object_id("m", "https://a.com/products/sofa")
    b = object_id("m", "https://b.com/products/sofa")
    assert a != b


def test_falls_back_to_merchant_and_product_id():
    a = object_id("bend", None, 8451502113048)
    b = object_id("Bend", None, "8451502113048")
    assert a == b, "the fallback key is case-insensitive on the label"


def test_handle_used_when_no_product_id():
    assert object_id("m", None, None, "the-block") == object_id("m", None, None, "the-block")


def test_no_stable_key_raises():
    """Standing rule 4: never substitute a default. A random id here is the bug."""
    try:
        object_id(None, None)
    except ValueError:
        return
    raise AssertionError("expected ValueError when no stable key can be derived")


def test_relative_url_is_not_treated_as_identity():
    """A url with no host cannot be globally unique, so it must fall through to the
    merchant-scoped key rather than colliding with another store's same path."""
    assert canonical_product_key("m", "/products/x", 7) == "m|7"


def test_id_is_a_uuid():
    import uuid
    uuid.UUID(object_id("m", "https://shop.com/products/x"))


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
