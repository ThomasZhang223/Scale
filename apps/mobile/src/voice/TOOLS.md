# The OMNI voice loop — intent and tool schema

**Owner:** Paul (component F, pipeline P5). Draft, not yet a contract.

This file is the design. `schema/intent.js` and `schema/tools.js` are the machine-readable
versions. Nothing here changes `.claude/contracts.md` — every tool below maps onto an endpoint
that already exists there, except where marked NEEDS JUSTIN.

## The rule the whole design exists to enforce

> **Every number the agent speaks came out of a tool call. No number originates in the model.**

This is `CLAUDE.md` standing rule 3, tightened. The model is allowed to say "that looks like a
desk". It is never allowed to say "that's about 80 centimetres". The failure mode of a language
model doing geometry is not that it errs — it is that it errs *confidently and plausibly*, in a
product whose entire pitch is that every other tool shows you something dimensionally false.

The structure below makes this a property of the architecture rather than a prompt instruction.

## The two-pass turn

One user utterance produces two model calls, not one.

```
mic audio + 2-3 JPEG frames
        │
        ▼
 ┌──────────────────┐
 │ PASS 1 UNDERSTAND│  text out only, no speech
 │  audio + vision  │  → { ack, intent }
 └──────────────────┘
        │  intent
        ▼
 ┌──────────────────┐
 │  resolver        │  binds refs → objectId / anchorId. Coordinates are minted HERE.
 └──────────────────┘
        │
        ▼
 ┌──────────────────┐
 │  tool calls      │  measure / find_anchor / check_fit / search / place
 └──────────────────┘
        │  results
        ▼
 ┌──────────────────┐
 │ PASS 2 SPEAK     │  audio out, grounded in results
 └──────────────────┘
```

Why two passes rather than one interleaved stream:

1. **It makes the grounding rule structural.** Pass 1 has no tool results in context, so it
   cannot state a measurement. Pass 2 has them and is told to use nothing else. The model is
   never in a position where hallucinating a number is even available to it.
2. **It survives an API that cannot do tool-calling and audio-out in one response.** We are
   going through a reseller (yibuapi) and have not verified that it can. Two passes need only
   text-out on one call and audio-out on the other.
3. **`ack` covers the latency.** Pass 1 returns a short spoken filler ("let me measure that")
   that plays while tools run. That is the doc's "narration turns 15 seconds of dead air into
   15 seconds of progress", made concrete.

### Transport, and the fallback

The canonical wire form is a JSON `intent` object. If the API supports native function calling,
the tool definitions in `schema/tools.js` are already in that shape and map 1:1. If it does not,
pass 1 emits a fenced ```json block and we parse it.

One schema, two transports. Decide which after the H−4 transport probe, not before.

## Frame policy

Vision is the expensive modality and we have a $40 CAD cap.

- Two frames at speech onset, one at speech end. JPEG, longest edge 768 px.
- VAD-gated: **frames are only captured while someone is actually speaking.** No idle streaming.
- `ceiling: fixed 3-frame policy; a sweep-based multi-frame capture would reduce
  misidentification on ambiguous objects but costs tokens per turn.`

## Reference resolution — where coordinates come from

The model emits *descriptions*. The resolver emits *coordinates*. This is the seam that keeps
standing rule 3 true.

| Model may emit | Model may never emit |
| --- | --- |
| `{ kind: "in_view" }` | `{ p: [1.2, 0, 0.4] }` |
| `{ kind: "named", text: "beside my desk" }` | `{ yawDeg: 90 }` |
| `{ kind: "description", text: "narrow oak bookshelf" }` | any distance, span, or dimension |

`schema/intent.js` asserts this: a ref carrying numeric geometry is rejected, loudly, per
standing rule 4.

### The `find_anchor` dependency

"beside my desk" has to become a real location with a real free span. Two versions:

- **v0, ships now, zero dependencies.** Client-side over `RoomCapture v1.objects`: match the
  category label RoomPlan already assigned, take the adjacent free span along the wall.
  `ceiling: axis-aligned spans beside a single named object; no multi-object gaps, no diagonal
  clearance. Upgrade path is the /gaps helper below.`
- **v1, NEEDS JUSTIN.** A `POST /gaps` (or an anchor query on `/fit`) returning candidate free
  spans with dimensions, computed properly in `services/fit`. Not in the contracts dependency
  table yet — raise at the next sync. Only needed if the demo has the *system* measure the gap
  rather than the user speaking the number.

The tool contract is identical either way, so v0 → v1 is a swap behind `find_anchor` and
nothing above it changes.

## The tools

Seven, and that is the ceiling. Every one maps to an existing endpoint.

| Tool | Wraps | Notes |
| --- | --- | --- |
| `measure_object_in_view` | phone LiDAR → `POST /objects` | **The grounding primitive.** Returns `Object v1` with `state:"measured"` in under 1 s. The model supplies the *name*; the depth sensor supplies the *size*. |
| `find_anchor` | client-side v0 / `POST /gaps` v1 | Description → anchor with a free span in metres. |
| `check_fit` | `POST /fit` with `{ roomId, placements }` | A **dry run**: validates a hypothetical placement without writing a version. This is why the contract accepts `placements` and not only `versionId`. |
| `search_objects` | `POST /search` | `fit` is an integer range filter, never a vector term. |
| `place_object` | `POST /rooms/{id}/versions` + `POST /push/{roomId}` | Writes a version and pushes it to the headset. |
| `start_generation` | `POST /objects/{id}/generate` + `GET /jobs/{id}` | Returns a `jobId` so pass 2 can narrate the wait. |
| `suggest_arrangement` | `POST /solve` | **Optional, H24, first to cut.** The agent supplies an objective and constraints. The solver supplies coordinates. |

Note there is no `identify_object` tool. Identification is the model's own vision capability —
that is the point of using an Omni model. Only *measurement* is delegated.

## Intent actions

Seven, discriminated on `action`. See `schema/intent.js`.

| Action | Utterance it comes from | Tools it drives |
| --- | --- | --- |
| `measure_and_fit` | "what is this, will it fit beside my desk?" | measure → find_anchor → check_fit |
| `find_object` | "find something for that gap that matches the wood tone" | find_anchor → search_objects |
| `place_object` | "put it there" | find_anchor → place_object → check_fit |
| `check_placement` | "will that block the door?" | check_fit |
| `describe` | "what am I looking at?" | none — vision only, no numbers permitted |
| `clarify` | ambiguous reference | none — ask one question, keep the turn open |
| `unsupported` | out of scope | none — decline in one sentence |

`measure_and_fit` is the marquee beat and the only one that must never break. It is also the
only one that exercises all three modalities in a single utterance, which is what Huawei OMNI
Live's hard three-modality filter actually tests.

## Grounding assertion

`assertGrounded()` in `schema/intent.js` scans pass 2's spoken text for numerals and verifies
each appears in the tool results for that turn, unit-aware. A violation is a loud failure in
dev and a swallowed log in the demo build.

This is cheap, and it is worth saying out loud to a judge: we do not ask the model to be honest
about measurements, we verify that it was. It reads on the Rox rubric as honest handling of
ambiguity and on OMNI's rubric 5 as safety-aware design.

`ceiling: numeral matching with a 1 cm rounding tolerance and cm/m awareness; spelled-out
numbers ("thirty centimetres") are not caught.`

## What I need from Thomas

The `VoiceScreen` stub currently exports `onTranscript`. With raw audio confirmed, the surface
needs to be:

```js
start({ onAudioFrame, onVideoFrame, onSpeechStart, onSpeechEnd })
stop()
interrupt()          // barge-in: cancel in-flight playback
play(pcmChunk)       // speak pass 2's audio out
```

- `onAudioFrame` — PCM chunks, 16 kHz mono is enough. **Raw audio, not a transcript**: if Apple
  does the speech-to-text, OMNI receives only two of three modalities and the track is not
  winnable at any effort level.
- `onVideoFrame` — JPEG, on demand, gated by the frame policy above.
- Apple's `Speech` framework stays useful for the instant on-screen caption, VAD, and as the
  offline fallback. It is a UX garnish, not the speech pipeline.
