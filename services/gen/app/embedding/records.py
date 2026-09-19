"""B05 records for Paul's existing /index; no ranking or remote writes."""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import re

from .config import DIMENSION, MAX_IMAGE_BYTES


class RecordError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise RecordError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "Expected SHA-256")
    return value


def finite(value, *, positive=False):
    return (type(value) in (int, float) and math.isfinite(value)
            and (not positive or value > 0))


def bbox(value):
    require(isinstance(value, dict) and set(value) == {"w", "h", "d"}
            and all(finite(v, positive=True) for v in value.values()),
            "Complete positive finite bboxMeters in metres required")
    return copy.deepcopy(value)


def validate_embedding(result, expected_fingerprint):
    digest(expected_fingerprint)
    require(isinstance(result, dict), "Embedding response required")
    require(result.get("fingerprint") == expected_fingerprint, "Incompatible encoder fingerprint")
    require(type(result.get("dimension")) is int and result["dimension"] == DIMENSION,
            "Embedding dimension must be 768")
    values = result.get("values")
    require(isinstance(values, list) and len(values) == DIMENSION
            and all(finite(v) for v in values), "Expected 768 finite vector values")
    require(abs(math.sqrt(sum(v*v for v in values)) - 1) <= 1e-5, "Vector must be normalized")
    digest(result.get("inputHash"))
    require(result.get("modality") in ("image", "text"), "Unknown embedding modality")
    return copy.deepcopy(result)


def safe_reference(value):
    # Receipts never retain signed capabilities, URL credentials or fragments.
    require(isinstance(value, str) and bool(value.strip()) and not any(c in value for c in "?#@\r\n"),
            "Use a non-secret image reference, not a signed URL")
    return value


def make_record(metadata, embedding, *, expected_fingerprint, scope, image_ref, image_bytes):
    """Unknown fields stay absent/null. No IDs, confidence, units or prices guessed."""
    result = validate_embedding(embedding, expected_fingerprint)
    require(result["modality"] == "image", "Index records require an image embedding")
    require(isinstance(image_bytes, bytes) and 0 < len(image_bytes) <= MAX_IMAGE_BYTES,
            "Bounded image bytes required")
    require(hashlib.sha256(image_bytes).hexdigest() == result["inputHash"], "Image hash mismatch")
    require(isinstance(scope, str) and bool(scope.strip()), "Explicit scope required")
    require(isinstance(metadata, dict), "Object metadata required")
    allowed = {"objectId", "productId", "variantId", "name", "source", "category", "bboxMeters",
               "measure", "price", "merchant", "productUrl", "state", "glbUrl", "createdAt",
               "caption", "palette", "provenance", "schemaVersion"}
    require(set(metadata) <= allowed, "Unsupported metadata field")
    obj = copy.deepcopy(metadata)
    require(type(obj.get("schemaVersion", 1)) is int and obj.get("schemaVersion", 1) == 1, "Expected Object v1")
    obj["schemaVersion"] = 1
    require(obj.get("source") in ("scan", "catalog", "primitive"), "Explicit source required")
    for key in ("objectId", "productId", "variantId", "name", "category", "merchant"):
        if obj.get(key) is not None:
            require(isinstance(obj[key], str) and bool(obj[key].strip()), "Invalid identity/text field")
    if obj.get("bboxMeters") is not None:
        bbox(obj["bboxMeters"])
    if obj.get("state") is not None:
        require(obj["state"] in ("measured", "generating", "ready", "failed"), "Invalid object state")
    if obj.get("measure") is not None:
        m = obj["measure"]
        require(isinstance(m, dict) and set(m) <= {"method", "confidence"}, "Invalid measure")
        if m.get("method") is not None:
            require(m["method"] in ("lidar", "extracted", "declared"), "Invalid measurement method")
        if m.get("confidence") is not None:
            require(finite(m["confidence"]) and 0 <= m["confidence"] <= 1, "Invalid confidence")
    if obj.get("price") is not None:
        p = obj["price"]
        require(isinstance(p, dict) and set(p) == {"cents", "currency"}
                and type(p["cents"]) is int and p["cents"] >= 0
                and isinstance(p["currency"], str) and re.fullmatch(r"[A-Z]{3}", p["currency"]),
                "Price needs integer cents and supplied ISO currency")
    for key in ("productUrl", "glbUrl"):
        if obj.get(key) is not None:
            safe_reference(obj[key])
    if obj.get("provenance") is not None:
        p = obj["provenance"]
        require(isinstance(p, dict) and set(p) <= {"dataset", "source", "license", "capturedAt", "dimensionSource"},
                "Provenance accepts only non-secret source facts")
        for value in p.values():
            safe_reference(value)
    obj["vector"] = result["values"]
    obj["embeddingMeta"] = {"dimension": DIMENSION, "fingerprint": result["fingerprint"],
                            "inputHash": result["inputHash"], "modality": "image",
                            "scope": scope, "imageRef": safe_reference(image_ref)}
    # JSON round trip takes a deterministic, independent snapshot and refuses NaN.
    return json.loads(canonical(obj))


def index_payload(records, *, expected_fingerprint, scope):
    """Exact body for POST services/search/index. Refuse Paul's guessed defaults."""
    require(isinstance(records, list) and bool(records), "Nonempty record list required")
    seen = set()
    for obj in records:
        meta = obj.get("embeddingMeta", {})
        validate_embedding({"values": obj.get("vector"), **{k: meta.get(k) for k in
                           ("dimension", "fingerprint", "inputHash", "modality")}}, expected_fingerprint)
        require(meta.get("scope") == scope and bool(scope), "Scope mismatch")
        identity = obj.get("objectId")
        require(isinstance(identity, str) and bool(identity.strip()), "Paul's index requires a supplied objectId")
        require(identity not in seen, "Duplicate objectId")
        seen.add(identity)
        bbox(obj.get("bboxMeters"))
        require(obj.get("source") in ("scan", "catalog", "primitive"), "Source required")
        confidence = (obj.get("measure") or {}).get("confidence")
        require(finite(confidence) and 0 <= confidence <= 1,
                "Paul's index defaults missing confidence to 0.5; supply real confidence before indexing")
    return json.loads(canonical({"objects": records}))


def main():
    parser = argparse.ArgumentParser(description="Embed a local manifest; emit Paul's /index JSON. No network.")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--fingerprint", required=True)
    parser.add_argument("--scope", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    from .encoder import SiglipEncoder
    encoder = SiglipEncoder(args.cache_dir)
    require(encoder.fingerprint == args.fingerprint, "Incompatible encoder fingerprint")
    records = []
    for item in json.loads(args.manifest.read_text(encoding="utf-8")):
        path = (args.manifest.parent / item["imagePath"]).resolve()
        with path.open("rb") as handle:
            raw = handle.read(MAX_IMAGE_BYTES + 1)
        records.append(make_record(item["object"], encoder.response(image=raw),
                                  expected_fingerprint=args.fingerprint, scope=args.scope,
                                  image_ref=item["imageRef"], image_bytes=raw))
    payload = index_payload(records, expected_fingerprint=args.fingerprint, scope=args.scope)
    with args.output.open("x", encoding="utf-8") as handle:
        handle.write(canonical(payload) + "\n")
    print(f"Exported {len(records)} records; no index mutated")


if __name__ == "__main__":
    main()
