"""Repeatable real photo/text -> Paul's existing local ranker, with strict filters."""
import argparse
import json
from pathlib import Path
import time

from .config import MAX_IMAGE_BYTES
from .encoder import SiglipEncoder
from .records import require
from .search import SearchHandoff


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--records", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--fingerprint", required=True)
    parser.add_argument("--scope", required=True)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--image")
    inputs.add_argument("--text")
    for axis in "whd":
        parser.add_argument("--max-" + axis, type=float)
    parser.add_argument("--budget-cents", type=int)
    parser.add_argument("--currency")
    parser.add_argument("--source", choices=["scan", "catalog", "primitive"])
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    require((args.budget_cents is None) == (args.currency is None), "Budget needs cents AND currency")
    payload = json.loads(Path(args.records).read_text(encoding="utf-8"))
    handoff = SearchHandoff(payload["objects"], fingerprint=args.fingerprint, scope=args.scope)
    encoder = SiglipEncoder(args.cache_dir)
    require(encoder.fingerprint == args.fingerprint, "Runtime fingerprint mismatch")
    raw = None
    if args.image:
        with Path(args.image).open("rb") as handle:
            raw = handle.read(MAX_IMAGE_BYTES + 1)
    started = time.perf_counter()
    embedding = encoder.response(image=raw, text=args.text)
    encoded = time.perf_counter()
    results = handoff.query(embedding,
        fit={"max" + a.upper(): getattr(args, "max_" + a) for a in "whd" if getattr(args, "max_" + a) is not None},
        source=args.source, limit=args.limit,
        budget=None if args.budget_cents is None else {"cents": args.budget_cents, "currency": args.currency})
    finished = time.perf_counter()
    print(json.dumps({"fingerprint": encoder.fingerprint, "queryInserted": False,
        "scoreMeaning": "Paul composite rank score, not a probability", "results": [
            {"objectId": r["objectId"], "score": r["score"],
             "metadata": {k: v for k, v in r["object"].items() if k not in ("vector", "embeddingMeta")}}
            for r in results], "seconds": {"embedding": encoded-started, "search": finished-encoded,
                                           "queryToResults": finished-started}}, indent=2))


if __name__ == "__main__":
    main()
