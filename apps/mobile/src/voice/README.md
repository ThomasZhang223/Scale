# src/voice — Paul's voice assistant

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
transport/anthropic.js  Claude-backed completion (injected, so the core stays testable)
dev/                    fake API over the fixtures, scripted transport, CLI, tests
```

```
node dev/test.mjs        # 8 tests, no key / server / phone needed
node dev/cli.mjs --all
```

## Ownership

This subtree is Paul's. Thomas ships the Swift `Speech` module, its config-plugin entry, and
the `VoiceScreen` stub; Paul writes JavaScript only, here. Paul never edits the Swift side — he
asks. See `CLAUDE.md` under File ownership.

Note `apps/mobile/package.json` is Thomas's, so nothing here adds a dependency to it. The agent
core has no npm dependencies at all; `@anthropic-ai/sdk` is needed only by
`transport/anthropic.js` and only when actually calling Claude. Running the dev tools under
bare `node` prints a `MODULE_TYPELESS_PACKAGE_JSON` warning — harmless, and Metro does not care.
