"""Paul 0888470 manifest format; synthetic catalog data, no merchant requests."""
import hashlib
import json
from pathlib import Path
import sys

import pytest

from test_embedding_contract import FakeEncoder, png
from app.embedding import catalog_manifest, records, encoder
from app.embedding.records import RecordError


def inputs(tmp_path, change=None):
    row = {"productId": "1000", "merchant": "Fake_Co", "title": "SYNTHETIC Chair",
        "handle": "test-chair", "productUrl": "https://store.invalid/products/test-chair",
        "imageUrl": "https://cdn.invalid/photo.jpg?v=123", "r2Key": "catalog/Fake_Co/1000/source.jpg",
        "category": "chair", "bucket": "seating", "source": "catalog",
        "bboxMeters": {"w": .5, "h": .8, "d": .6}, "measure": {"method": "extracted", "confidence": .8}}
    path = tmp_path / row["r2Key"]
    path.parent.mkdir(parents=True)
    path.write_bytes(png())
    row.update(change or {})
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"count": 1, "products": [row], "imagesDownloaded": 1}))
    return manifest, {"catalog/Fake_Co/1000/source.jpg": "supplied-backend-id"}


def test_conversion_and_export_cli_keep_known_facts_and_hash(tmp_path, monkeypatch):
    manifest, mapping = inputs(tmp_path)
    identity_file, converted, indexed = [tmp_path / n for n in ("ids.json", "converted.json", "index.json")]
    identity_file.write_text(json.dumps(mapping))
    monkeypatch.setattr(sys, "argv", ["catalog_manifest", "--prebake", str(manifest),
        "--identities", str(identity_file), "--output", str(converted)])
    catalog_manifest.main()
    rows = json.loads(converted.read_text())
    assert rows == catalog_manifest.convert(manifest, mapping, output_directory=tmp_path)
    obj = rows[0]["object"]
    assert obj["objectId"] == "supplied-backend-id" and obj["productId"] == "1000"
    assert obj["bboxMeters"] == {"w": .5, "h": .8, "d": .6}
    assert "price" not in obj and "variantId" not in obj and "state" not in obj
    assert rows[0]["imageSha256"] == hashlib.sha256(png()).hexdigest()
    assert "cdn.invalid" not in converted.read_text()  # No query-bearing image URL in receipts.
    monkeypatch.setattr(encoder, "SiglipEncoder", lambda cache: FakeEncoder())
    monkeypatch.setattr(sys, "argv", ["records", "--manifest", str(converted), "--cache-dir", "fake",
        "--fingerprint", FakeEncoder.fingerprint, "--scope", "test", "--output", str(indexed)])
    records.main()
    assert json.loads(indexed.read_text())["objects"][0]["embeddingMeta"]["inputHash"] == rows[0]["imageSha256"]
    (tmp_path / rows[0]["imagePath"]).write_bytes(b"changed")
    with pytest.raises(RecordError, match="hash changed"):
        records.main()


@pytest.mark.parametrize("change", [{"productId": "None"}, {"r2Key": "../../escape.jpg"},
    {"downloadError": "failed"}, {"bboxMeters": {"w": -1, "h": 1, "d": 1}},
    {"price": {"cents": 1.5, "currency": "CAD"}}, {"merchant": "../escape"}])
def test_rejects_invalid_current_manifest_rows(tmp_path, change):
    manifest, mapping = inputs(tmp_path, change)
    with pytest.raises(RecordError):
        catalog_manifest.convert(manifest, mapping, output_directory=tmp_path)


def test_requires_supplied_backend_identity_and_downloaded_image(tmp_path):
    manifest, mapping = inputs(tmp_path)
    with pytest.raises(RecordError, match="objectId"):
        catalog_manifest.convert(manifest, {}, output_directory=tmp_path)
    (tmp_path / next(iter(mapping))).unlink()
    with pytest.raises(FileNotFoundError):
        catalog_manifest.convert(manifest, mapping, output_directory=tmp_path)
