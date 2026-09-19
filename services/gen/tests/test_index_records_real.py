"""Opt-in real B03 + B05 plumbing, using a real image and LABELED test metadata."""
import os
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.embedding.encoder import SiglipEncoder
from app.embedding.records import make_record
from app.embedding.search import SearchHandoff


@pytest.mark.skipif(os.environ.get("ANI_EMBEDDING_REAL") != "1", reason="Opt-in cached real model")
def test_real_image_record_and_uninserted_text_query():
    encoder = SiglipEncoder(os.environ["EMBEDDING_CACHE_DIR"])
    raw = Path(os.environ["EMBEDDING_TEST_IMAGE"]).read_bytes()
    # These dimensions/identity are test inputs, NOT claims about the pictured chair.
    record = make_record({"objectId": "synthetic-metadata-real-image", "source": "primitive",
                          "name": "PLUMBING ONLY", "bboxMeters": {"w": 1., "h": 1., "d": 1.},
                          "measure": {"method": "declared", "confidence": 0.}, "state": "measured",
                          "provenance": {"dataset": "real upstream image with synthetic test metadata"}},
                         encoder.response(image=raw), expected_fingerprint=encoder.fingerprint,
                         scope="plumbing-test", image_ref="upstream/sf3d/chair1.png", image_bytes=raw)
    handoff = SearchHandoff([record], fingerprint=encoder.fingerprint, scope="plumbing-test")
    assert handoff.query(encoder.response(text="a wooden chair"))[0]["objectId"] == record["objectId"]
    assert len(handoff.index) == 1
