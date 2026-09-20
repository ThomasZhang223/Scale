# services/fit — fit engine and solver

**Owner:** Justin (component E)

## Scope

Two HTTP endpoints, two different jobs:

- **`POST /fit` is a VALIDATOR.** Checks a layout against clearance corridors (90 cm default),
  door swing arcs, window occlusion, and wall adjacency. Returns `FitReport v1`.
- **`POST /solve` is an OPTIMISER.** Discretises the floor to a grid and runs OR-Tools or
  `scipy.optimize` over it. Returns `{ placements, objective, infeasible? }`.

**Hard rule:** an LLM translates intent into an objective function and constraints. A solver
places things. An LLM never emits coordinates.

The infeasible case is the demo beat, not an edge case to skip. When `/solve` can't find an
arrangement, it returns a human-readable reason plus suggestions — never just a bare failure.
E.g.: "no arrangement of these three pieces keeps a 90 cm walkway to the door — drop the
ottoman, or go 20 cm narrower on the couch."

## How this runs

This is a **standalone HTTP service in Docker**, reached from Cloudflare through a quick
tunnel — see `infra/README.md` for the laptop side of that hop. The service is stateless: it
receives everything it needs in the request body and never fetches a room itself.

The tunnel hop means there are **two shapes, not one.** The public surface in
`.claude/contracts.md` is what the phone and headset call:

```
POST /v1/fit    { roomId, versionId }
POST /v1/solve  { roomId, intent, budgetCents?, fixed[] }
```

The `RoomAgent` Durable Object hydrates that into what this service actually receives over the
tunnel, headers `X-Upstream-Token`:

```
POST /fit    { schemaVersion, room: <RoomCapture v1>, placements: [<Placement v1>],
               objects: { <objectId>: { w, h, d } } }
POST /solve  { schemaVersion, room: <RoomCapture v1>, candidates: [<Object v1>],
               fixed: [<Placement v1>], plan: <ConstraintPlan v1> }
```

`candidates` carries `bboxMeters` and nothing else — that field is all this service reads. See
`infra/README.md` for the full hop and the `ConstraintPlan v1` shape.

`POST /solve` accepts **two bodies** and picks by shape (`app/main.py`):

| Body | Detected by | Sent by |
| --- | --- | --- |
| Solver frame: `{ room, objects: [...], rules, settings }` | `objects` is a list and `rules` is present | the designer agent (`services/agent`), which builds the frame itself |
| Hydrated: `{ schemaVersion, room, candidates, fixed, plan }` (above) | `room` is an object and `plan` is present | the `RoomAgent` Worker |

Anything else is a 422 `unrecognised body`; a body that matches but is unsolvable is a 422
`unsolvable input`. The solver frame is checked first, so a body carrying both `rules` and `plan`
is treated as a solver frame.

## Run

```
cd services/fit
docker build -t fit-service .
docker run -p 8000:8000 fit-service
```

See `app/main.py` for the route stubs and `app/README.md` for the validator checks and
`FitReport` geometry types this service owns.
