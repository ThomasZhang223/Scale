# app — route notes

## The four checks `/fit` owes

1. Clearance corridors (90 cm default walkway width).
2. Door swing arcs.
3. Window occlusion.
4. Wall adjacency.

## `FitReport v1` geometry types

Three, and only three: `arc`, `polyline`, `rect`. This list belongs to Justin (component E).
Adding a fourth type is a contract change — announce it before pushing (see
`.claude/contracts.md`).
