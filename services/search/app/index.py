"""Where candidates come from. Two implementations behind one port.

Ani writes embeddings into Vectorize (`objects-v1`); this service reads them. But RANKING.md
names the fallback explicitly — "Cut Vectorize. Fall back to a brute-force cosine scan over the
objects table. At a few hundred objects that is fast enough" — so the port exists from the
start and the ranking never learns which side it is talking to.

BruteForceIndex is the one that runs today and the one under test. VectorizeIndex is the
adapter for when Ani's rows land at H14.
"""

from __future__ import annotations

from typing import Protocol

from .ranking import Candidate


class Index(Protocol):
    def query(self, vector: list[float] | None, *, bounds: dict | None, limit: int) -> list[Candidate]:
        """Candidates for ranking. May over-return: ranking applies the fit filter itself, so an
        index that cannot express a metadata filter is still correct, only slower."""
        ...

    def get(self, object_id: str) -> Candidate | None:
        """One row by id. Needed to answer "matches ITS wood tone" — the reference object's
        palette and vector come from here, not from a similarity query."""
        ...


class BruteForceIndex:
    """Every object in memory. Correct, obvious, and fast enough at the scale of this project —
    a few hundred catalogue items plus whatever the user scanned.

    ceiling: O(n) per query and the whole set in memory. Past a few thousand objects this wants
    Vectorize, which is why the port exists.
    """

    def __init__(self, candidates: list[Candidate] | None = None):
        self._rows: list[Candidate] = list(candidates or [])

    def upsert(self, candidates: list[Candidate]) -> None:
        by_id = {c.object_id: c for c in self._rows}
        for c in candidates:
            by_id[c.object_id] = c
        self._rows = list(by_id.values())

    def __len__(self) -> int:
        return len(self._rows)

    def query(self, vector: list[float] | None, *, bounds: dict | None, limit: int) -> list[Candidate]:
        # Hand everything to ranking: it owns the fit filter and the relaxed fallback, and
        # pre-filtering here would make the fallback impossible to implement.
        return list(self._rows)

    def get(self, object_id: str) -> Candidate | None:
        return next((c for c in self._rows if c.object_id == object_id), None)


def candidate_from_object_v1(obj: dict, vector: list[float] | None = None) -> Candidate:
    """Object v1 (.claude/contracts.md) -> a ranking candidate.

    bboxMeters is metres; the index metadata is integer millimetres. Rounding happens here and
    nowhere else.
    """
    bbox = obj.get("bboxMeters")
    if not bbox:
        raise ValueError(f"object {obj.get('objectId')!r} has no bboxMeters — it cannot be ranked")
    missing = [k for k in ("w", "h", "d") if bbox.get(k) is None]
    if missing:
        raise ValueError(f"object {obj.get('objectId')!r} bboxMeters is missing {missing}")

    palette = obj.get("palette") or []
    return Candidate(
        object_id=obj["objectId"],
        w_mm=int(round(bbox["w"] * 1000)),
        h_mm=int(round(bbox["h"] * 1000)),
        d_mm=int(round(bbox["d"] * 1000)),
        source=obj.get("source", "catalog"),
        category=obj.get("category"),
        dominant_hex=palette[0] if palette else None,
        measure_confidence=float((obj.get("measure") or {}).get("confidence", 0.5)),
        vector=vector,
        object=obj,
    )


class VectorizeIndex:
    """Adapter for Cloudflare Vectorize index `objects-v1` (768-dim, cosine).

    Not exercised yet: Ani writes the rows at H14, and this service cannot reach Cloudflare
    from a dev machine without credentials. Metadata filtering is applied server-side where
    available as an optimisation only — ranking still applies the fit filter itself, so a
    difference between the two can never silently change a result.
    """

    def __init__(self, query_fn):
        if query_fn is None:
            raise ValueError("VectorizeIndex needs a query function")  # standing rule 4
        self._query_fn = query_fn

    def get(self, object_id: str) -> Candidate | None:
        rows = self._query_fn(vector=None, top_k=1, filter={"objectId": {"$eq": object_id}})
        if not rows:
            return None
        m = rows[0]
        return Candidate(
            object_id=m["objectId"],
            w_mm=int(m["w_mm"]), h_mm=int(m["h_mm"]), d_mm=int(m["d_mm"]),
            source=m.get("source", "catalog"),
            dominant_hex=m.get("dominant_hex"),
            measure_confidence=float(m.get("measure_confidence", 0.5)),
            vector=m.get("vector"),
            object=m.get("object", {"objectId": m["objectId"]}),
        )

    def query(self, vector: list[float] | None, *, bounds: dict | None, limit: int) -> list[Candidate]:
        if vector is None:
            raise ValueError("Vectorize cannot answer a query with no vector; use BruteForceIndex")
        # Over-fetch: ranking may relax the fit filter, and a tight top-k would leave it nothing
        # to relax into.
        raw = self._query_fn(vector=vector, top_k=max(limit * 5, 50), filter=_metadata_filter(bounds))
        return [
            Candidate(
                object_id=m["objectId"],
                w_mm=int(m["w_mm"]), h_mm=int(m["h_mm"]), d_mm=int(m["d_mm"]),
                source=m.get("source", "catalog"),
                category=m.get("category"),
                dominant_hex=m.get("dominant_hex"),
                measure_confidence=float(m.get("measure_confidence", 0.5)),
                vector=m.get("vector"),
                object=m.get("object", {"objectId": m["objectId"]}),
            )
            for m in raw
        ]


def _metadata_filter(bounds: dict | None) -> dict | None:
    """Integer range filter, never a vector term (RANKING.md)."""
    if not bounds:
        return None
    # Relaxed by the same factor ranking may apply, so relaxation stays possible server-side.
    from .ranking import RELAX_FACTOR
    return {axis: {"$lte": int(round(ceiling * (1 + RELAX_FACTOR)))} for axis, ceiling in bounds.items()}
