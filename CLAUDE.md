# Full Scale — Hack the North 2026

Scan your room and any real object, then compose them together at true measured scale — on
the phone in 3D/AR, and in a Quest via WebXR at 1:1.

## Read these before doing anything

| File | What it is |
| --- | --- |
| `.claude/contracts.md` | **The authority on every interface.** Schemas, API, storage keys. If this file and any other file disagree, this file wins. |
| `.claude/sprint.md` | The 36-hour plan, four parallel swimlanes, sync points, kill criteria. |
| `.claude/workstreams/<name>.md` | Your own scope. Read yours. Skim the others so you know who to ask. |
| `BUILD_DOC.md` | The full design doc and the reasoning behind the decisions. Read once, then work from the three files above. |

## Who owns what

| Owner | Components | One-line scope |
| --- | --- | --- |
| **Thomas** | A, B | iOS capture, Expo app, backend layer, scaffolding, Docker, data schemas |
| **Justin** | D, E | WebXR/Quest runtime, glTF transforms, GLB onto the headset, fit solver |
| **Ani** | C | Baseten image-to-3D, the scale binding, all inference and compute |
| **Paul** | F, P3 | Huawei OMNI voice loop; agentic merchant retrieval end to end — vendor selection, Shopify and other listings, extraction, ranking |

A component never reads another component's internals. It reads `.claude/contracts.md`.

## The positioning, in one paragraph

IKEA Kreativ already ships LiDAR room scan, accurate dimensions, AI erase, and place-at-scale.
Do not pitch dimensional accuracy. Pitch the two things Kreativ structurally cannot do:
**ingest an object that is for sale nowhere**, and **retrieve over your own possessions**
("find something that fits the 80 cm gap beside my desk and matches its wood tone").

## Standing rules

1. **Metres everywhere.** Never centimetres, never inches, in any schema, variable, or column.
   Convert at the UI edge only.
2. **The scale binding happens exactly once, in component C.** Nothing downstream rescales a GLB.
   If two places rescale, the error squares and nobody finds it until the demo.
3. **Never let an LLM emit coordinates.** An LLM turns intent into an objective and constraints.
   A solver places things.
4. **Fail loud.** When a value cannot be determined — which room, which merchant, which model —
   raise. Never substitute a default or the first available option, even when it is correct today.
5. **Build against stubs, not against people.** Every `/v1` endpoint answers a committed fixture
   when the request carries `X-Stub: 1`. If you are blocked on a person, you are doing it wrong.
6. **Corner cuts get a comment.** Name the ceiling you are accepting and the upgrade path:
   `# ceiling: single room per user; multi-room needs a room_id on this query`.
7. **No Claude or Anthropic co-author trailer on commits.**

## File ownership

Component ownership is an abstraction. Merge conflicts happen to paths. One person writes a path;
everyone else opens a pull request against it or asks.

| Path | Writer | Notes |
| --- | --- | --- |
| `apps/mobile/**` | Thomas | Except the one subtree below |
| `apps/mobile/src/voice/**` | **Paul** | The OMNI loop. See the handoff below. |
| `apps/xr/**` | Justin | WebXR runtime |
| `workers/**` | Thomas | Every HTTP route, including `/search` and `/solve` |
| `services/fit/**` | Justin | Solver, its own HTTP service |
| `services/gen/**` | Ani | Baseten deploy, binding, embeddings |
| `services/ingest/**` | Paul | Scraper, extractor |
| `services/search/**` | Paul | Ranking, its own HTTP service |
| `fixtures/**` | Thomas | Everyone reads, nobody else writes |
| `.claude/contracts.md` | Thomas | Propose changes to him; do not edit directly |
| `.claude/workstreams/<you>.md` | you | Your own file only |
| `docker-compose.yml`, lockfiles, `app.json` | Thomas | See "shared files" below |

### The one real collision: voice

Paul's OMNI loop runs on the phone, using the native Speech framework, inside Thomas's Expo app.
That is a third Swift native module and a config-plugin entry in files Thomas owns.

Resolution, and it is Thomas's job at H1.5, not a negotiation at H12:

1. Thomas ships the Swift Speech module and its config-plugin entry with the scaffolding.
2. Thomas ships a `VoiceScreen` stub wired into the router, exporting a plain JS surface:
   start listening, stop, and a transcript callback.
3. Paul writes only JavaScript, only under `apps/mobile/src/voice/**`, from then on.

If Paul needs a change to the Swift side, he asks. He never edits it. Two people in one Xcode
project is how a weekend ends.

### Shared files nobody may edit casually

These three conflict every single time two people touch them, and the conflicts are ugly:

- **Lockfiles.** Use one workspace per component so dependency changes stay local. If you must
  add a dependency to a shared lockfile, say so first and pull immediately after.
- **`docker-compose.yml`.** Thomas registers every service, including empty placeholders for the
  fit solver, the scraper, and search, at H1.5. Nobody else adds an entry.
- **`app.json` / `app.config.js`.** Thomas only. Every native module and permission goes in at
  H1.5, including ones not used until H14.

The rule behind all three: the shared file is filled in once, early, with placeholders for work
that has not started yet. An empty placeholder costs nothing. A merge conflict at hour 20 costs
the demo.

### Generated files

`ios/` and `android/` are generated by `npx expo prebuild`. Keep them in `.gitignore`. A committed
`ios/` directory regenerates differently on every machine and conflicts on every pull.

## Repository layout

```
CLAUDE.md                  this file, loaded into every session
BUILD_DOC.md               the design doc (source for the PDF)
.claude/contracts.md       interface authority + the schema-change protocol
.claude/sprint.md          the 36-hour plan
.claude/workstreams/       one file per person
fixtures/                  the four committed fixtures
apps/mobile/               Expo app (Thomas; voice subtree is Paul's)
apps/xr/                   WebXR runtime (Justin)
workers/                   Cloudflare Workers, every HTTP route (Thomas)
services/fit/              solver (Justin)
services/gen/              Baseten, binding, embeddings (Ani)
services/ingest/           scraper, extractor (Paul)
services/search/           ranking (Paul)
```
