"""Opt-in, cached real SigLIP + Paul's ranker + FAKE-provider B04 timing smoke.

No paid requests. A supplied real image has SYNTHETIC object metadata below.
This is plumbing/performance evidence, never product retrieval quality.
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.embedding.config import MAX_IMAGE_BYTES
from app.embedding.encoder import SiglipEncoder
from app.embedding.records import make_record
from app.embedding.search import SearchHandoff
from app.generation import GenerationInput, GenerationAttempt
from test_generation_adapter import FakeProvider, IDENTITY, review


def measured(call):
    start = time.perf_counter()
    result = call()
    return result, time.perf_counter() - start


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--real", action="store_true", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--image-provenance", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    output = args.output.resolve()
    if output.exists() or output.is_relative_to(repo):
        parser.error("Use a new report file outside Git")
    with args.image.open("rb") as handle:
        raw = handle.read(MAX_IMAGE_BYTES + 1)
    encoder = SiglipEncoder(args.cache_dir)
    embedded, image_first = measured(lambda: encoder.response(image=raw))
    _, image_repeat = measured(lambda: encoder.response(image=raw))
    text, text_first = measured(lambda: encoder.response(text="a wooden chair"))
    _, text_repeat = measured(lambda: encoder.response(text="a wooden chair"))
    # Every fact below is a TEST INPUT, never an assertion about the supplied image.
    metadata = {"objectId": "synthetic-metadata-real-image", "source": "scan",
        "name": "PLUMBING ONLY: synthetic metadata", "state": "measured", "glbUrl": None,
        "bboxMeters": {"w": .61, "h": 1.07, "d": .49},
        "measure": {"method": "declared", "confidence": 0.},
        "price": {"cents": 100, "currency": "CAD"},
        "provenance": {"dataset": "SYNTHETIC metadata on a real input image"}}
    record = make_record(metadata, embedded, expected_fingerprint=encoder.fingerprint,
        image_bytes=raw, image_ref="local/supplied-real-image", scope="plumbing-test")
    search = SearchHandoff([record], fingerprint=encoder.fingerprint, scope="plumbing-test")
    queries = []
    for name, embedding in (("identical_source_image", embedded), ("text_wooden_chair", text),
                             ("text_red_sports_car", encoder.response(text="a red sports car"))):
        result, elapsed = measured(lambda: search.query(embedding))
        queries.append({"query": name, "rankings": [{"objectId": r["objectId"], "score": r["score"]} for r in result],
                        "searchSeconds": elapsed})
    constraints = [({"fit": {"maxW": .6099}}, 0), ({"fit": {"maxW": .61}}, 1),
                   ({"budget": {"cents": 99, "currency": "CAD"}}, 0),
                   ({"budget": {"cents": 100, "currency": "USD"}}, 0),
                   ({"budget": {"cents": 100, "currency": "CAD"}}, 1)]
    violations = sum(len(search.query(text, **kw)) != expected for kw, expected in constraints)
    if violations:
        raise AssertionError("Hard filter violation")
    # Best available composition: real query + Paul's selection + test image resolver
    # + fake provider + actual B04 + completion bytes, no remote storage/workflow.
    started = time.perf_counter()
    query = encoder.response(text="a wooden chair")
    selected = search.query(query)[0]["object"]
    queried = time.perf_counter()
    req = GenerationInput.from_object(selected, raw, image_sha256=embedded["inputHash"],
        image_ref=record["embeddingMeta"]["imageRef"], scope="plumbing-test")
    artifact = GenerationAttempt(req, FakeProvider(), IDENTITY).prepare()
    result = artifact.worker_result(review(artifact))
    completed = time.perf_counter()
    report = {"schemaVersion": 1, "measurement": "Single local CPU run, not p95; 4 torch threads; cached model; no warmup before first call",
        "host": {"python": platform.python_version(), "platform": platform.system()},
        "fingerprint": encoder.fingerprint, "imageSha256": hashlib.sha256(raw).hexdigest(),
        "imageProvenance": args.image_provenance,
        "evidence": {"embedding": "real cached SigLIP2", "search": "actual Paul index/ranking",
            "metadata": "synthetic TEST INPUTS", "provider": "fake_provider",
            "binding": "actual B04 on synthetic textured GLB", "storage": "not exercised in this timing run",
            "realProducts": 0, "corpusItems": 1, "heldOutPhotos": 0, "retrievalQualityClaim": False},
        "embeddingSeconds": {"modelLoad": encoder.load_seconds, "imageFirst": image_first,
            "imageRepeat": image_repeat, "textFirst": text_first, "textRepeat": text_repeat},
        "queries": queries, "queryCount": len(queries), "hardFilterChecks": len(constraints),
        "hardFilterViolations": violations, "queryInserted": len(search.index) != 1,
        "bindingSeconds": artifact.receipt["timings"]["bindingSeconds"],
        "integrationSeconds": {"queryToResults": queried-started, "queryThroughBoundInlineResult": completed-started},
        "artifact": {"boundSha256": artifact.receipt["boundSha256"], "bytes": len(artifact.glb),
            "scale": result["artifact"]["scale"], "measuredMeters": artifact.receipt["validation"]["measured_meters"]},
        "failures": [], "realGeneration": False, "realGeneratedMeshBinding": False,
        "gitHeadAtRun": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()}
    with output.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print("Real embedding / synthetic-metadata plumbing smoke passed. Report saved outside Git.")


if __name__ == "__main__":
    main()
