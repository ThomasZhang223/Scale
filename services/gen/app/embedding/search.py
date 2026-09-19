"""Thin in-process handoff to Paul's unchanged index/ranker, not another engine.

The current HTTP /search cannot take precomputed vectors and ignores budgets.
This local demo adapter calls its actual library and guards supplied constraints.
"""
import importlib
import sys
from pathlib import Path
from types import ModuleType

from .records import bbox, finite, index_payload, require, validate_embedding


def paul_module(name):
    namespace = "full_scale_paul_search"
    if namespace not in sys.modules:
        package = ModuleType(namespace)
        package.__path__ = [str(Path(__file__).resolve().parents[3] / "search" / "app")]
        sys.modules[namespace] = package
    return importlib.import_module(f"{namespace}.{name}")


class SearchHandoff:
    """One corpus/scope/fingerprint per instance. All scoring/indexing is Paul's."""
    def __init__(self, records, *, fingerprint, scope):
        payload = index_payload(records, expected_fingerprint=fingerprint, scope=scope)
        library = paul_module("index")
        self.index = library.BruteForceIndex()
        self.index.upsert([library.candidate_from_object_v1(o, o["vector"]) for o in payload["objects"]])
        self.fingerprint, self.scope = fingerprint, scope

    def query(self, embedding, *, fit=None, source=None, budget=None, limit=10):
        vector = validate_embedding(embedding, self.fingerprint)["values"]
        require(type(limit) is int and 1 <= limit <= 50, "Limit must be 1..50")
        require(source is None or source in ("scan", "catalog", "primitive"), "Invalid source")
        fit = {} if fit is None else fit
        require(isinstance(fit, dict) and set(fit) <= {"maxW", "maxH", "maxD"}
                and all(finite(v, positive=True) for v in fit.values()), "Invalid fit bounds in metres")
        if budget is not None:
            require(isinstance(budget, dict) and set(budget) == {"cents", "currency"}
                    and type(budget["cents"]) is int and budget["cents"] >= 0
                    and isinstance(budget["currency"], str) and len(budget["currency"]) == 3
                    and budget["currency"].isalpha() and budget["currency"].isupper(), "Invalid budget")
        candidates = self.index.query(vector, bounds=None, limit=limit)
        eligible = []
        for candidate in candidates:
            obj = candidate.object
            require(obj["embeddingMeta"]["fingerprint"] == self.fingerprint
                    and obj["embeddingMeta"]["scope"] == self.scope, "Incompatible index record")
            box = bbox(obj["bboxMeters"])
            # Strict guard before Paul's scoring: exact metres avoid his nearest-mm rounding
            # admitting an item just over the limit. Never invoke his 10% relaxation.
            if any(box[axis] > fit[key] for key, axis in (("maxW", "w"), ("maxH", "h"), ("maxD", "d")) if key in fit):
                continue
            if source is not None and obj["source"] != source:
                continue
            price = obj.get("price")
            if budget is not None and (price is None or price["currency"] != budget["currency"]
                                       or price["cents"] > budget["cents"]):
                continue
            eligible.append(candidate)
        results, relaxed = paul_module("ranking").rank(eligible, query_vector=vector, limit=limit)
        require(not relaxed, "Unexpected constraint relaxation")
        return [{"objectId": r.object_id, "score": r.score, "object": r.object} for r in results]
