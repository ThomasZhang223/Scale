# The voice assistant — intent and tool schema

**Owner:** Paul (component F). Working draft; the code beside it runs.

Talk to the room: ask what something is, whether it fits, what would fit, and put it there.
The model turns speech into an intent. Code does the geometry.

> **Not an OMNI submission.** This was briefly designed for the Huawei OMNI Live track and that
> was a stretch — 40% of that rubric is real-time conversational quality, which this product
> does not want. What survives is the part that was always useful: a voice layer over measured
> geometry, on one ordinary LLM, with no three-modality contortion.

## The rule the whole design exists to enforce

> **Every number the agent speaks came out of a tool call. No number originates in the model.**

This is `CLAUDE.md` standing rule 3, tightened. The model may say "that looks like a desk". It
may never say "that's about 80 centimetres". A language model doing geometry does not fail
loudly — it fails *confidently and plausibly*, in a product whose whole claim is that other
tools show you something dimensionally false.

`assertGrounded()` in `schema/intent.js` enforces it: it scans what the agent is about to say
for numerals and checks each against the tool results for that turn, unit-aware. There is a
test that proves it catches an invented number inside the real loop.

Worth saying out loud to a judge, and it lands on the Rox honesty rubric: *we don't ask the
model to be honest about measurements, we verify that it was.*

## The two-pass turn

One utterance, two model calls.

```
transcript (+ optional camera frames)
        │
        ▼
 ┌──────────────────┐
 │ PASS 1 UNDERSTAND│  structured output, no tool results in context
 │                  │  → { ack, action, target, anchor }
 └──────────────────┘
        │
        │  ack spoken immediately — this is the latency cover, not a courtesy
        ▼
 ┌──────────────────┐
 │ FIXED PIPELINE   │  chosen by the action, in code. Coordinates minted HERE.
 └──────────────────┘
        │  results
        ▼
 ┌──────────────────┐
 │ PASS 2 SPEAK     │  every number checked against the results
 └──────────────────┘
```

Two properties worth keeping:

1. **Pass 1 has no tool results in context, so it cannot state a measurement.** The grounding
   rule is a property of the structure, not a line in a prompt the model might drift from.
2. **The action picks the pipeline, not the model.** Each action maps to one fixed sequence of
   calls (`TOOLS_BY_ACTION` in `schema/tools.js`, dispatched in `agent/toolRuntime.js`). The
   model chooses the action and describes the references; it never chooses which tools run or
   in what order. That kills a whole class of demo failure — check_fit before anything was
   measured — and makes every turn reproducible in a test.

Pass 1 uses structured outputs (`output_config.format` with a JSON schema), so the shape cannot
come back wrong and there is no JSON-parsing fallback to maintain.

## Reference resolution — where coordinates come from

The model emits *descriptions*. The resolver emits *coordinates*.

| Model may emit | Model may never emit |
| --- | --- |
| `{ kind: "in_view" }` | `{ p: [1.2, 0, 0.4] }` |
| `{ kind: "named", text: "beside my desk" }` | `{ yawDeg: 90 }` |
| `{ kind: "description", text: "narrow oak bookshelf" }` | any distance, span or dimension |

Two things enforce it: the JSON schema has no field in which a number could be expressed, and
`validateIntent()` rejects a ref carrying a geometry key anyway.

**Unresolved is a question, never a guess.** When two places are equally plausible, or the
phrase names nothing in the room, the turn asks — with a question built in code, so it carries
no numbers and cannot improvise a corner.

### `find_anchor` v0 and v1

`agent/anchors.js` resolves "beside my desk" against `RoomCapture v1`: match the category
RoomPlan already assigned, then scan along each axis for the nearest thing in the way and
return the free span. Doors and windows are referenceable too — "by the door" means the floor
*in front of* it, not two metres along the same wall.

Ceilings are commented in the file: footprints are axis-aligned (yaw ignored), spans are
scanned on the cardinal axes only, category synonyms are hand-written.

v1 is Justin's `POST /gaps` in `services/fit`. **Not in the contracts dependency table yet** —
raise it if the demo needs the system to measure a gap rather than the user speaking the
number. The tool contract is identical either way, so it is a one-function swap.

## The tools

Seven. Every one maps to an endpoint already in `.claude/contracts.md`, except `find_anchor`
v1 above. Definitions in `schema/tools.js`, JSON-Schema shaped so they drop into native
function calling if the design ever needs it.

| Tool | Wraps |
| --- | --- |
| `measure_object_in_view` | phone LiDAR → `POST /objects`. The grounding primitive: the model supplies the name, the depth sensor supplies the size. |
| `find_anchor` | client-side v0 / `POST /gaps` v1 |
| `check_fit` | `POST /fit` with `{ roomId, placements }` — a **dry run**, writes nothing |
| `search_objects` | `POST /search`. `fit` is an integer range filter, never a vector term. |
| `place_object` | `POST /rooms/{id}/versions` + `POST /push/{roomId}` |
| `start_generation` | `POST /objects/{id}/generate` — fire-and-forget, the mesh is not needed to answer |
| `suggest_arrangement` | `POST /solve`. Optional, H24, first to cut. |

**A blocking fit report stops a placement.** The pipeline refuses to write a version that
blocks the door and reports instead. Placing it anyway and mentioning it afterwards would be
the one unforgivable behaviour in this product.

## Vision is optional

The model can take the object-scan frames (`ctx.frames`, base64 JPEG) and name what it is
looking at, so nobody types "MacBook Pro 14" on a phone keyboard. That is a single-shot
classification, not video understanding, and the loop works without it.

It is worth having for one reason beyond convenience: a bounding box does not know what it is.
A chest of drawers is 40 cm deep and needs most of a metre in front of it to open. The box is
the **static** footprint; the category gives you the **functional** one. The category-priors
table from the P3 extraction validation supplies those metres — so the model names the thing
and a table supplies the number, and the grounding rule holds.

## Where this runs

The agent core is pure JS with an injected `complete()` transport, so it does not care. That
matters because of one unresolved question: **running it in the app means an API key on the
device.** Options are a Worker route (Thomas owns `workers/**`) or a small service. Until that
is decided the transport is a one-line swap and nothing else moves.

Model is `claude-opus-5` at `effort: "low"` on both passes — reference-picking and a
two-sentence spoken answer are simple tasks, and this is the latency-critical path.

## What I need from Thomas

**Nothing.** The existing `VoiceScreen` stub — `start()`, `stop()`, `onTranscript()` — is
exactly the right surface. Apple's on-device `Speech` framework does the transcription, which
is what the doc said all along and which only became a problem when OMNI required the audio
itself. That requirement is gone.

The one thing to settle eventually is where the agent runs (above), which is a deployment
question, not a native-module one.

## Running it

```
node dev/test.mjs                 # 8 regression tests, no key, no server, no phone
node dev/cli.mjs --all            # the scripted scenarios
node dev/cli.mjs "put it by the door"
node dev/cli.mjs --live "..."     # real Claude; needs ANTHROPIC_API_KEY + @anthropic-ai/sdk
```

`dev/fakeApi.js` serves the committed fixtures (`fixtures/room-demo.json`,
`object-macbook.json`, `fitreport-doorswing.json`), so the whole turn runs before Thomas's
`X-Stub: 1` layer exists. When it lands, `createApi()` replaces the fake and nothing above it
changes.
