# Designer agent: contract

Agree on this before building. It extends the existing `/v1` API and keeps its
conventions: everything under `/v1`, `X-Stub: 1` returns committed fixtures, the headset
falls back to the built-in fixture when the server is down.

## 1. Agent endpoints (Worker, new)

All are routed to the room's `DesignerAgent` Durable Object.

| Method and path | Body | Returns |
|---|---|---|
| `POST /v1/agent/{roomId}/requests` | `{ text?, preset?, pins: [objectId], baseVersionId, source: "headset" \| "laptop" }` | `202 { requestId }` |
| `GET /v1/agent/{roomId}/requests/{requestId}` | | `{ requestId, state, log: [LogEntry], proposal?: Proposal, error? }` |
| `POST /v1/agent/{roomId}/requests/{requestId}/accept` | `{ baseVersionId }` | `200 { versionId }`, or `409 { currentVersionId }` if the room changed |
| `POST /v1/agent/{roomId}/requests/{requestId}/reject` | `{ reason? }` | `200` |
| `POST /v1/agent/{roomId}/undo` | | `200 { versionId }` (the restored one) |
| `GET /v1/agent/{roomId}/memory` | | `{ preferences: [Preference] }` |
| `DELETE /v1/agent/{roomId}/memory` | | `200` (for resetting between demos) |

`preset` values: `reading_corner`, `open_floor`, `clear_door`, `face_window`. A preset is a
request with known text; the agent treats it exactly like typed text (so it still goes
through the planner and the log).

`state`: `queued` → `reading` → `planning` → `solving` → `checking` → `proposed`, or
`failed`. Only one request per room runs at a time; a new one while another runs gets `409`.

## 2. Live events

Added to the existing `GET /v1/sync/{roomId}` SSE feed:

| Event | Data |
|---|---|
| `agent.status` | `{ requestId, state, message }`, short line for the wrist ("Solving…") |
| `agent.log` | `{ requestId, entry: LogEntry }` |
| `agent.proposal` | `{ requestId, proposal: Proposal }` |
| `agent.failed` | `{ requestId, message }` |
| `version.current` | `{ versionId, createdBy, requestId? }` after accept or undo |

**Sync is still a stub (501) today.** The headset must also poll
`GET .../requests/{requestId}` every second while a request is active. When SSE works,
polling becomes a fallback. Both paths deliver the same objects.

## 3. Shapes

```jsonc
// LogEntry: the visible reasoning. Rox judges read this.
{ "at": "2026-09-19T15:04:05Z",
  "kind": "data" | "plan" | "solve" | "fit" | "retry" | "memory" | "decision",
  "message": "Sofa scan is 2.19 m, detected box 2.00 m: using the scan (bound GLB wins).",
  "severity": "info" | "warn" }

// Proposal
{ "versionId": "ver_…",            // a Version with status "proposed"
  "baseVersionId": "ver_…",
  "summary": "Reading corner by the window",
  "explanation": "Chair beside the window facing into the room; lamp on its right.",
  "tradeoffs": ["Chair is 40 cm left of the window so the walkway stays 60 cm wide."],
  "moves": [{ "objectId": "obj_chair", "from": Placement, "to": Placement }],
  "fit": { "red": 0, "amber": 1 },   // summary of the /fit report for this layout
  "unsatisfied": [{ "ruleId": "r3", "why": "No wall space left for the storage unit." }] }

// Preference (memory)
{ "id": "pref_…", "text": "Sofa should face the window", "rule": Rule, "source": "request" | "undo", "createdAt": "…" }
```

`Placement` is exactly the Version v1 placement format; `placements.ts` already converts it
to scene coordinates. Nothing new on the headset for coordinates.

## 4. Versions

A proposal is a normal Version. Add these fields if Version v1 doesn't have them:

| Field | Values |
|---|---|
| `status` | `proposed` (not live), `current` (live), `superseded` |
| `parentVersionId` | the Version it was based on (makes undo trivial) |
| `createdBy` | `user` or `agent` |
| `requestId` | set when `createdBy` is `agent` |

Accept = the proposed Version becomes `current`, the old one `superseded`. If the current
Version changed since the proposal was made (someone moved something), accept returns
`409` and the headset offers to ask again; the agent re-solves from the new Version.

## 5. The constraint plan (what the model outputs)

The OpenAI model never outputs coordinates. It outputs this, validated by the Worker
against a strict JSON schema before anything is solved:

```jsonc
{ "summary": "Reading corner by the window",
  "movable": ["obj_chair", "obj_lamp"],   // optional; default: every object not pinned
  "rules": [
    { "id": "r1", "type": "near", "a": "obj_chair", "b": "window:win1", "maxCm": 100,
      "priority": "must", "why": "Reading needs daylight" },
    { "id": "r2", "type": "facing", "a": "obj_chair", "target": "center",
      "priority": "should", "weight": 5, "why": "Faces into the room, not the wall" } ] }
```

Rule types (v1). Targets are object ids or room features written as `door:{id}`,
`window:{id}`, `wall:{id}`, or `center`; ids come from the room JSON.

| type | fields | meaning |
|---|---|---|
| `pin` | `a` | don't move `a` |
| `against_wall` | `a`, `wall` (`wall:{id}` or `any`) | back of `a` flush to a wall, facing into the room |
| `near` | `a`, `b`, `maxCm` | center distance at most `maxCm` |
| `far_from` | `a`, `b`, `minCm` | center distance at least `minCm` |
| `facing` | `a`, `target` | `a`'s front points at `target` (nearest of the 4 rotations) |
| `keep_clear` | `zone` (`door:{id}`, `window:{id}`, `walkway`), `marginCm` | nothing inside that zone |

`priority: "must"` is a hard constraint. `"should"` is soft with `weight` 1–10; the solver
may break it and must report that it did. Door and walkway clearance are **always** hard,
whatever the plan says.

Unknown types or ids are rejected by the Worker and sent back to the model once with the
error. A second failure fails the request with a clear message.

## 6. Solver API (Python service, new)

`POST /solve` on the services host (next to `/fit`). The Worker does all coordinate
conversion; the solver only sees integer centimeters in a frame where the room's main
walls are axis-aligned.

```jsonc
// request
{ "room": { "boundsCm": { "minX": -205, "maxX": 205, "minZ": -175, "maxZ": 175 },
            "doors":   [{ "id": "d1", "keepOut": { "minX": 35, "maxX": 125, "minZ": 85, "maxZ": 175 } }],
            "windows": [{ "id": "win1", "xCm": -50, "zCm": -175, "widthCm": 120, "side": "north" }],
            "walls":   [{ "id": "n1", "side": "north" }] },
  "objects": [{ "id": "obj_sofa", "widthCm": 219, "depthCm": 102, "xCm": 0, "zCm": -120,
                "rotDeg": 0, "movable": true }],
  "rules": [ /* resolved rules: targets as { "object": id } or { "point": [x, z] }, see 08 ③ */ ],
  "settings": { "walkwayCm": 60, "timeLimitMs": 2000 } }

// response
{ "status": "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "TIMEOUT",
  "placements": [{ "id": "obj_sofa", "xCm": 0, "zCm": -124, "rotDeg": 0 }],
  "satisfied": ["r1"], "violated": [{ "ruleId": "r2", "amountCm": 35 }],
  "conflicts": ["r1", "r4"],     // when INFEASIBLE: a small set of must-rules that can't all hold
  "movedCm": 52, "solveMs": 267 }
```

Width is the object's left-right size facing forward at `rotDeg = 0`, depth front-back.
Front faces +Z at 0° in the solver frame (the Worker converts).

## 7. Stubs

- `X-Stub: 1` on `POST .../requests` returns `requestId: "stub-req-1"`. Polling it walks
  through a fixture timeline (`fixtures/agent-request-demo.json`): a few log entries
  including one "messy data" decision, then a proposal that moves the chair and sofa.
- `STUB=1` on the solver returns `fixtures/solve-demo.json` without solving.
- The headset ships its own copy of the proposal fixture, like the room fixture, for when
  the server is down.

Commit the fixtures in the first hour: the headset builds entirely against them.
