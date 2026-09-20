# src/voice — the voice assistant

Talk to the room. Ask what something is, whether it fits, what would fit, and put it there.

**Start with `TOOLS.md`** — the design, the grounding rule, and what each piece owes.

```
schema/intent.js        7 actions, ref validation, assertGrounded()
schema/tools.js         tool definitions + per-action tool narrowing
agent/prompts.js        the two system prompts
agent/intentJsonSchema  structured-output schema for pass 1 (derived from schema/intent.js)
agent/anchors.js        "beside my desk" -> a real free span (find_anchor v0)
agent/toolRuntime.js    API client + the fixed pipeline per action
agent/runTurn.js        one utterance -> one spoken answer
transport/openai.js     OpenAI-backed completion (injected, so the core stays testable)
dev/                    fake API over the fixtures, scripted transport, CLI, tests
```

```
node dev/test.mjs        # 8 tests, no key / server / phone needed
node dev/cli.mjs --all
```

## State — read this before building on it

**Handed to Justin on 2026-09-19.** Written by Paul; `CLAUDE.md`'s File ownership table still
says this subtree is Paul's and now needs updating, which is a change to Thomas's table rather
than something to edit here.

What is proven: `node dev/test.mjs` — 8 tests, no key, no server, no phone. They cover the
grounding rule, the per-action tool narrowing, anchor resolution against real fixtures, and
the refusal to place a blocking object.

What has **never run**: a real OpenAI call through `transport/openai.js`, anything on a
device, and anything against Thomas's Swift `Speech` module. Every test uses
`dev/fakeTransport.js` with scripted responses. So the schema and the orchestration are
tested; the wire format and the mobile integration are not. Assume the first real call finds
something.

Three open decisions come with it:

1. **Where the API key lives.** The transport takes one and does not care where from. A key in
   the app bundle is extractable by anyone who downloads it — fine for a hackathon demo, not
   fine if this is ever shown as a product. The alternative is a Worker route that proxies,
   which is Thomas's file.
2. **Where free spans come from.** `agent/anchors.js` computes them client-side from the room
   scan. Paul had flagged a proposed `POST /gaps` to the solver instead; you own the solver
   now, so it is entirely your call whether that moves server-side.
3. **`search_objects` depends on an index nobody populates.** The Worker's ingest workflow
   writes objects to D1 and stops — nothing calls `POST /index` on `services/search`, and that
   index is in-memory with no startup load, so it is empty after every restart. Until that is
   wired, this tool returns nothing in the live path however well the agent reasons.

Two invariants worth not breaking, both from `CLAUDE.md`:

- **The LLM never emits coordinates** (rule 3). `validateIntent()` rejects any ref carrying
  geometry keys. The model names *what* and *where-ish*; `anchors.js` and the solver decide
  the numbers.
- **Nothing is spoken that a tool did not return.** `assertGrounded()` checks every numeral in
  the spoken line against the tool results for that turn. It is the difference between a
  measurement and a confident guess, and it is the whole reason to trust the demo.

## Ownership

Thomas ships the Swift `Speech` module, its config-plugin entry, and the `VoiceScreen` stub;
this subtree is JavaScript only. Never edit the Swift side — ask. Two people in one Xcode
project is how a weekend ends. See `CLAUDE.md` under File ownership.

Note `apps/mobile/package.json` is Thomas's, so nothing here adds a dependency to it. The agent
core has no npm dependencies at all, and neither does the transport — it POSTs
`/chat/completions` with `fetch`, the same way `services/agent` and `services/ingest` do.
Running the dev tools under bare `node` prints a `MODULE_TYPELESS_PACKAGE_JSON` warning —
harmless, and Metro does not care.
