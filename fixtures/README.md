# fixtures — the contract-proof files

Owner: **Thomas**. Everyone reads these; nobody else writes here.

These four files are the committed proof that `.claude/contracts.md` is real: every `/v1`
endpoint answers one of them when the request carries `X-Stub: 1` (see `workers/README.md`).

- `room-demo.json` — a `RoomCapture v1` fixture.
- `object-macbook.json` — an `Object v1` fixture, `state: "ready"`.
- `fitreport-doorswing.json` — a `FitReport v1` fixture with one blocking `door_swing` violation.
- `mesh-macbook.glb` — pending from Ani; see `mesh-macbook.README.md` for what it must satisfy.

**A schema change is not complete until the matching fixture here changes too.** See
`.claude/contracts.md` "The ritual, every time" — a contract change without a fixture change is
a surprise, not a contract change.
