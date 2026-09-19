# Tracks, demo script, submission

Select all three on Devpost **before 2:00 PM EDT Saturday**.

## What each track's judges need to see

### Rox: Best AI Agent ($10K / $2K)
They reward agents that act on messy, incomplete or conflicting data, and judge "how well
the system handles real-world messiness", not clean demos.

| They look for | Where we show it |
|---|---|
| Data cleaning and validation | The data step's log: wrong-sized boxes, zero sizes, objects inside walls |
| Multi-source resolution | Phone scan (RoomPlan box) vs object scan (GLB) sizes, resolved and explained |
| Intelligent error handling | Mirrored door fixture corrected for the solve; solver timeout and planner-offline fallbacks |
| Decisions under uncertainty | Low-confidence detections kept clear of; infeasible requests relaxed, with the reason |
| Meaningful actions | It actually rearranges the room, checked by an independent fit engine |

**Make the log visible.** The laptop log is the evidence. Point at it during the demo.

### Cloudflare: Best Agent with a Brain
To qualify, Workers must be the agent's real runtime, not just hosting. They ask to see the
agent **plan, remember, call tools and complete tasks** during the demo.

| They look for | Where we show it |
|---|---|
| Workers as runtime | The agent loop runs in the Worker; the headset only sends a request |
| State | One Durable Object per room: request state, log, Version history |
| Memory | Preferences stored in the Durable Object's SQLite, learned from requests and undos |
| Tools | OR-Tools solver on our compute node via **Cloudflare Tunnel**, fit engine (`/fit`), Versions, room and object data |
| LLM calls | OpenAI through **AI Gateway** (logged, cached, retried) |
| Completes tasks | The accepted layout becomes the current Version and syncs |

Mention the Agents SDK, Durable Objects, AI Gateway and Cloudflare Tunnel by name. Showing the AI
Gateway log on the laptop for a few seconds is an easy, concrete proof.

### OpenAI API prize
They score both how the API powers the experience and **one concrete way Codex helped**.

| They look for | Where we show it |
|---|---|
| API powering the experience | Fuzzy request → strict constraint plan (structured outputs); choosing what to relax; the explanation text |
| Creative, effective use | The model never outputs coordinates; it decides *what*, the solver decides *where* |
| Codex's role | Keep `CODEX_LOG.md` from now on: date, task, what Codex did, what it saved. Pick the best one for the demo |

Good Codex story shapes: "Codex wrote the 12 solver tests from the spec, and one caught a
wall-bounds bug before we ran it on the headset", or "Codex converted the contract into
fixtures and a typed client in one pass".

## Demo script (about 3 minutes)

Before the judges arrive: reset memory (`DELETE .../memory`), reset the room, Quest on USB,
laptop log visible on the big screen.

1. **The room** (15 s). Judge in the headset: scanned room at 1:1, the chair drops onto
   its detected spot. "This room came from a phone scan; everything is at real size."
2. **A problem** (20 s). Pull the sofa from the wrist and drop it in front of the door.
   Red ribbon: door swing blocked.
3. **Ask the agent** (45 s). Pull *Clear the door*. On the big screen, read two log lines
   aloud: the sofa size conflict and the mirrored door fixture. Ghosts appear; Accept;
   furniture glides out of the way, stopping at walls.
4. **A hard request** (40 s). Type on the laptop: "Reading corner by the window, and keep
   the sofa exactly where it is." If it's impossible, the log shows which wishes clash and
   what the agent gave up; the wrist shows the tradeoff.
5. **Memory** (30 s). Undo the last change. Ask again: the log shows "Remembered: …" and the
   agent leaves that object alone.
6. **How it works** (20 s). "The model decides what you want; OR-Tools guarantees it
   physically fits; our fit engine double-checks; the agent runs in a Cloudflare Durable
   Object and remembers you. And here's how Codex helped: …"

**Solver laptop:** on power, sleep off, on your hotspot, `cloudflared` running.

**Fallbacks:** server down → the headset shows fixtures and says so. OpenAI down → presets
use built-in plans (the log says so). Solver down → the request fails with a clear message;
switch to the stub proposal for the demo.

## Submission text (fill in the blanks)

**What it does:** Scan a room with a phone and objects with Object Capture; stand in the
room at 1:1 on a Quest; place scanned furniture with physics; ask a designer agent to
rearrange it, and watch it happen.

**How we built it:** three.js WebXR on the Quest; Rapier physics; the agent runs entirely on
Cloudflare: a Durable Object per room (Agents SDK) with SQLite memory and OpenAI through AI
Gateway for planning with structured outputs. It calls Google OR-Tools CP-SAT on our own
compute node through a Cloudflare Tunnel for layout; a Python fit engine double-checks.

**Challenges:** real scans disagree with detected sizes; door fixtures arrive mirrored;
some requests are impossible. The agent handles each, visibly: ___

**Numbers worth quoting:** solve time (prototype: ~70 ms on one core, optimal), tests passing (___),
average request time (___ s), messy-data checks (___).
