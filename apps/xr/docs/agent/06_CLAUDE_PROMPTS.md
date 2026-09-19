# Prompts for Claude

Put this folder in the repo as `docs/agent/`. Open Claude Code in the repo and paste the
prompt for your piece. Each one stops after a plan so you can check it first.

## Contract and stubs (do first, 1 hour)

```markdown
Read docs/agent/00_OVERVIEW.md and docs/agent/01_CONTRACT.md, plus the existing /v1 Worker
code and fixtures. Add the designer agent's contract with stubs only:
- the /v1/agent/... routes returning fixture data when X-Stub: 1 is set, following how the
  other /v1 stubs work,
- every golden fixture and conversion-vectors.json listed in 09_END_TO_END_TESTS.md,
  under fixtures/pipeline/, with the numbers from 08_PROTOCOL.md,
- fixtures/agent-request-demo.json (a timeline of log entries including one messy-data
  decision, then a proposal moving the chair and sofa), fixtures/solve-demo.json,
  fixtures/preset-plans.json (one hand-written plan per preset),
- the Version fields in 01 §4 if missing.
No agent logic yet. Plan first, wait for my OK, then build and show curl output for every endpoint.
```

## Layout solver

```markdown
Read docs/agent/00_OVERVIEW.md, 01_CONTRACT.md (§5–6), 02_LAYOUT_SOLVER.md, 08_PROTOCOL.md
(hops ④–⑤) and 09_END_TO_END_TESTS.md (solver tests), and the
existing services/fit code. Build services/layout with POST /solve exactly as specified,
using OR-Tools CP-SAT (pin ortools==9.15.*), following services/fit's framework and layout.
Implement hard constraints first, then the rules in the order listed, then infeasibility
conflicts. Write all 10 tests in 02 plus S1–S4 in 09 and show their output; don't weaken a failing test.
Then add GET /health and the credential check (X-Solver-Key or Access service token) from
docs/agent/07_CLOUDFLARE_HOSTING.md; it will run on a laptop behind a Cloudflare Tunnel.
Plan first and wait for my OK.
```

## Worker agent

```markdown
Read everything in docs/agent/, and the existing /v1 Worker. Implement the DesignerAgent
Durable Object with the Cloudflare Agents SDK as specified in 03_WORKER_AGENT.md. The solver
runs on a team laptop reached through a Cloudflare Tunnel at SOLVER_URL, and OpenAI calls go
through AI Gateway, as in 07_CLOUDFLARE_HOSTING.md, including the health check and offline
fallback. Check the current Agents SDK, Tunnel and AI Gateway docs for exact APIs instead of guessing. Build in this order: loop with
the preset fallback plans and the real solver → /fit check loop → data-cleaning checks with
log entries → OpenAI planning with structured outputs (model from OPENAI_MODEL) →
explanation → memory. Follow 08_PROTOCOL.md exactly for every message and conversion;
the Worker is the only place solver ↔ Version conversion happens. Implement tests W1–W10 and
E1–E6 from 09. Keep the X-Stub fixtures working. Show test output for each stage.
Plan first and wait for my OK.
```

## Headset

```markdown
Read docs/agent/00_OVERVIEW.md, 01_CONTRACT.md and 04_HEADSET.md, and the existing headset
code (palette.ts, halo.ts, fit.ts, physics.ts, interaction.ts, api.ts, placements.ts).
Build agent.ts and the headset changes against the stub fixtures only. Reuse existing
modules; don't duplicate drag, coordinate or fit logic. Check placements.ts against
fixtures/pipeline/conversion-vectors.json (08_PROTOCOL.md conventions). Write the 8 Node
tests in 04 plus H1–H3 in 09 and show their output. Finish with the Quest checklist, marking what you couldn't verify.
Plan first and wait for my OK.
```

## Whole-chain integration (last, once the pieces pass their own tests)

```markdown
Read docs/agent/08_PROTOCOL.md, 09_END_TO_END_TESTS.md and 10_LAPTOP_RUNBOOK.md. Wire the
real pieces together: Worker → real solver behind the Cloudflare Tunnel, with the planner
stubbed to fixtures/pipeline/plan.json. Run E1–E6 from 09 and show the results. Then run each
preset once with the real OpenAI planner through AI Gateway and report plan validity, timing
and anything surprising. Don't change contracts to make a test pass; tell me instead.
```
