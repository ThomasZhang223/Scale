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

This is a **standalone HTTP service in Docker**. Thomas's Cloudflare Worker proxies `/v1/fit`
and `/v1/solve` to it verbatim. The service is stateless: it receives everything it needs in
the request body and never fetches a room itself.

This means the internal contract here is identical to the public one in
`.claude/contracts.md` — there is only one shape to agree on, not two.

## Run

```
cd services/fit
docker build -t fit-service .
docker run -p 8000:8000 fit-service
```

See `app/main.py` for the route stubs and `app/README.md` for the validator checks and
`FitReport` geometry types this service owns.
