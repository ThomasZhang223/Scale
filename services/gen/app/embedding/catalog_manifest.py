"""Map Paul's downloaded pre-bake manifest to B05 input, without crawling or IDs invented."""
import argparse
import hashlib
import json
import os
from pathlib import Path

from .config import MAX_IMAGE_BYTES
from .preprocess import decode_image
from .records import require, validate_metadata, safe_reference, canonical


def convert(prebake_manifest, identities, *, output_directory):
    """identities maps Paul's r2Key to an actual backend objectId supplied by Thomas.

    Product IDs are merchant-scoped; do not pretend they are globally unique object
    IDs. No network, uploads, model calls, dimensions/price inference or mesh work.
    """
    source = Path(prebake_manifest).resolve(strict=True)
    manifest = json.loads(source.read_text(encoding="utf-8"))
    rows = manifest.get("products") if isinstance(manifest, dict) else None
    require(isinstance(rows, list) and bool(rows), "Downloaded product manifest required")
    require(isinstance(identities, dict), "Supplied r2Key to backend objectId mapping required")
    result, keys, object_ids = [], set(), set()
    for row in rows:
        require(isinstance(row, dict) and row.get("source") == "catalog", "Expected catalog row")
        require(not row.get("downloadError"), "Product image download failed")
        merchant, product_id, key = row.get("merchant"), row.get("productId"), row.get("r2Key")
        for value in (merchant, product_id):
            require(isinstance(value, str) and value.strip() and value not in ("None", "null", ".", "..")
                    and not any(c in value for c in '/\\:\r\n\x00'), "Verified merchant/product identity required")
        require(key == f"catalog/{merchant}/{product_id}/source.jpg" and key not in keys,
                "Invalid or duplicate catalog image key")
        keys.add(key)
        identity = identities.get(key)
        require(isinstance(identity, str) and identity.strip() and identity not in object_ids,
                "Supply a distinct real backend objectId for each catalog image key")
        object_ids.add(identity)
        image = (source.parent / key).resolve(strict=True)
        require(image.is_relative_to(source.parent) and image.is_file(), "Image escaped the downloaded corpus")
        with image.open("rb") as handle:
            raw = handle.read(MAX_IMAGE_BYTES + 1)
        decode_image(raw)  # Paul's .jpg key may hold PNG; validate actual bytes.
        metadata = {"objectId": identity, "productId": product_id, "merchant": merchant,
            "source": "catalog", "name": row.get("title"), "category": row.get("category"),
            "bboxMeters": row.get("bboxMeters"), "measure": row.get("measure"),
            "productUrl": row.get("productUrl"),
            "provenance": {"source": safe_reference(row.get("productUrl")),
                           "dimensionSource": "Paul ingestion manifest"}}
        # Never manufacture price/currency/variant identity that Paul's manifest omits.
        for field in ("price", "variantId"):
            if field in row:
                metadata[field] = row[field]
        metadata = validate_metadata(metadata)
        result.append({"imagePath": os.path.relpath(image, Path(output_directory).resolve()),
                       "imageRef": key, "imageSha256": hashlib.sha256(raw).hexdigest(), "object": metadata})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prebake", type=Path, required=True)
    parser.add_argument("--identities", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows = convert(args.prebake, json.loads(args.identities.read_text(encoding="utf-8")),
                   output_directory=args.output.parent)
    with args.output.open("x", encoding="utf-8") as handle:
        handle.write(canonical(rows) + "\n")
    print(f"Converted {len(rows)} supplied catalog records; no network or index writes")


if __name__ == "__main__":
    main()
