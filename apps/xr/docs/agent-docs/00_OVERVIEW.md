# Designer agent: overview

One feature, three prize tracks. Read this first; the other documents are the build specs.

| Doc | For |
|---|---|
| `00_OVERVIEW.md` | Everyone: what we're building, who builds what, in what order, what to cut |
| `01_CONTRACT.md` | Everyone: endpoints, events, the constraint plan format, stubs |
| `02_LAYOUT_SOLVER.md` | Whoever owns `services/` (Python): the OR-Tools solver |
| `03_WORKER_AGENT.md` | Thomas (Worker): the agent loop, tools, memory, OpenAI calls |
| `04_HEADSET.md` | Headset owner: wrist tiles, preview ghosts, accept/undo, animation |
| `05_TRACKS_AND_DEMO.md` | Everyone: what each track's judges must see, demo script, submission text |
| `06_CLAUDE_PROMPTS.md` | Prompts to hand each piece to Claude |
| `07_CLOUDFLARE_HOSTING.md` | Where everything runs: agent on Cloudflare, OR-Tools on a team computer via Cloudflare Tunnel |
| `08_PROTOCOL.md` | **The pipeline in detail:** every message between LLM, Worker, OR-Tools and Quest, with real numbers |
| `09_END_TO_END_TESTS.md` | Golden fixtures, shared conversion vectors, per-hop and whole-chain tests, Quest rehearsal |
| `10_LAPTOP_RUNBOOK.md` | Demo day: what runs on the laptop, start-up order, what to do when something breaks |
| `CODEX_LOG.md` | Running log of Codex's help, for the OpenAI judges |

**Start here:** read `08_PROTOCOL.md` for how a request becomes moving furniture, then the
spec for your piece.

## What it does, in the headset

You're standing in the scanned room. On your left wrist there's a new row of **Designer**
tiles: *Reading corner*, *Open up the floor*, *Clear the door*, *Face the window*, plus
anything typed on the laptop.

1. Pull a tile. A small status line on the wrist shows the agent working:
   "Reading room… sofa scan is 19 cm longer than the detected box, using the scan…
   solving… checking fit…"
2. **Ghost outlines** appear on the floor where things will go, with the fit ribbons for
   the proposed layout (red/amber, from your existing `/fit` engine).
3. The wrist shows the agent's short explanation and any trade-off: "Couldn't keep the
   chair by the window without blocking the walkway; put it 40 cm left instead."
4. Pull **Accept**: furniture glides into place through physics (same drag targets as
   grabbing, so it still stops at walls). Pull **Undo** any time: previous Version.
5. Whatever you're holding, or placed in the last minute, is **pinned**: the agent
   arranges around your choice.

## Why this design

- **LLMs can't do geometry; solvers can't understand "cozy".** The OpenAI model turns the
  request into a *constraint plan* (JSON). OR-Tools CP-SAT turns the plan into exact
  positions with no overlaps, clear doors and walkways. Your `/fit` engine then checks the
  result independently. Pitch line: *the AI decides what you want; the solver guarantees it
  physically works; the fit engine double-checks.*
- **Prototype result:** "Reading corner by the window" on the sample room (sofa, chair,
  table, storage; walls, door keep-out, 60 cm walkways, 90° rotations) solves to optimal in
  **69 ms on one core** with OR-Tools 9.15: the sofa slides east to free the window, the chair
  goes beside it facing into the room. Speed is not a risk. Details in `08`.
- **Everything goes through Versions.** A proposal is a Version. Accept makes it current,
  Undo restores the previous one. No new storage model, free undo, and live sync
  (`/sync` SSE) carries it to every headset.

## Architecture

```
Quest (Vite page)                 Thomas's Worker (/v1)                      Solver laptop (via Cloudflare Tunnel)
wrist tile / laptop text ──POST /v1/agent/{roomId}/requests──▶ DesignerAgent (Durable Object, 1 per room)
                                   │  memory: preferences, pins, history (DO SQLite)
                                   │  1. read room + objects + current Version
                                   │  2. clean the data (sizes, confidence, bad fixtures)   ← Rox
                                   │  3. OpenAI via AI Gateway: request → constraint plan    ← OpenAI
                                   │  4. POST /solve ─────────────────────────────────────▶ layout solver (OR-Tools)
                                   │  5. POST /fit (existing) ────────────────────────────▶ fit validator
                                   │  6. red issues? adjust plan, re-solve (max 3 rounds)
                                   │  7. save proposal as a Version (status: proposed)
◀── SSE /v1/sync/{roomId}: agent.status, agent.proposal, version.current ──┘
ghosts + ribbons → Accept → POST .../accept → physics glides objects to targets
```

The agent and everything around it run on Cloudflare (details in `07`): a Durable Object
per room (Agents SDK), OpenAI calls through AI Gateway. Only the OR-Tools solver runs on a
team computer, which the agent calls as a tool through a **Cloudflare Tunnel**.

## Who builds what

| Piece | Suggested owner | Depends on |
|---|---|---|
| Contract + stubs (`01`) | Thomas, first, 1 hour | nothing |
| Layout solver (`02`) | whoever owns `services/fit` | contract |
| Worker agent (`03`) | Thomas | contract; solver can be stubbed |
| Headset (`04`) | headset owner | contract stubs only |
| Demo + submission (`05`) | everyone, last | all |

Stubs first: with `X-Stub: 1` the agent endpoints return a committed fixture proposal, so
the headset work never waits on the solver or the LLM, the same way the rest of `/v1` works today.

## Build order and cut lines (deadline: Sunday 8:00 AM EDT)

1. **Contract + stub fixtures + the golden fixtures and conversion vectors from `09`**
   (all unblocked after this).
2. **Solver** with the hard constraints (no overlap, walls, door, walkways, pins) and the
   minimal-movement objective, plus 4 rule types: `against_wall`, `near`, `facing`, `keep_clear`.
3. **Agent loop without the LLM:** preset tiles map to hand-written plans. This alone is a
   complete demo (solver + fit + Versions + animation).
4. **OpenAI planner** for typed requests and preset tiles.
5. **Rox messiness handling** + the visible decision log.
6. **Memory** (preferences across requests) for Cloudflare.
7. Stretch: voice input, more rule types.

**If time runs short, cut from the bottom.** Steps 1–3 are a working feature; 4 makes it
an agent; 5 wins Rox; 6 strengthens Cloudflare.

Reminder: sponsor prizes must be selected on Devpost before **2:00 PM EDT Saturday**.
