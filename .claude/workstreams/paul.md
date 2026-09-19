# Paul — Component F, Pipeline P3

## Scope

You own the parts of the product that turn "stuff that exists" into "stuff the system can reason
about and talk about": pulling real furniture listings off the open web, extracting real
dimensions out of messy per-merchant data, ranking search results so style and fit never get
mixed, and the voice assistant. You do not touch the app, the backend, the headset, or Baseten —
you read their outputs through `.claude/contracts.md` and write to the same file.

**You own**
- Catalog ingest: Shopify `/products.json` scraping, dimension extraction, validation, confidence scoring (P3).
- Browserbase: the rendered-page pass (step 2.5) for stores whose API carries no dimensions.
- The voice assistant: speech → intent → tools → spoken answer, on the phone (P5).
- Search ranking inside `POST /search`: dense-vector style match, integer-range fit filter, relaxed-fallback (P4).
- The multi-agent design loop (scout → fit → style → budget), second-pass only, after H20.

**You do not own**
- The iOS app, backend, or any of the four schemas (Thomas, components A/B).
- WebXR/Quest runtime or the fit solver (Justin, components D/E).
- Baseten, the scale binding, image embeddings/captions/palettes (Ani, component C).
- The `/search` HTTP endpoint shape itself — Thomas owns the wire contract, you own what runs
  behind it.

> **Path note.** Your voice work lives only in `apps/mobile/src/voice/**`, which is yours.
> The rest of `apps/mobile/` is Thomas's. He ships the Swift Speech module, its config-plugin
> entry, and a `VoiceScreen` stub at H1.5, so you write JavaScript only. Need the Swift side
> changed? Ask him. Never edit it. See `CLAUDE.md` under File ownership.

## You own merchant retrieval end to end

Nobody hands you a vendor list. You choose the merchants, verify they are reachable, decide
which other listing sources are worth the time, and own the pipeline from discovery through to
a ranked result. Thomas does not approve the list and Ani does not wait on a particular vendor
— he waits on images plus dimensions, from whichever sources you picked.

**Settled.** `services/ingest/verify_merchants.py` ran against 28 candidates. Three merchants
carry it: **Poly & Bark** (250 products, 98% usable), **InStyle Home** (~57%), **Sabai Design**.
That is ~390 products with real dimensions against a pre-bake requirement of 60–100, so the
catalogue is done — the gate now counts usable *products* and category coverage, because merchant
count was never the requirement. Nine candidates were dead (404/403/430/DNS/TLS); four are
reachable with no dimensions in the endpoint, which is what step 2.5 is for.

Remaining gap: **lighting**. 2Modern and Kohara are reachable but yield two axes only.

Still yours to answer:
- Whether any non-Shopify source earns its place. Browserbase changes this calculus — it is the
  tool that would make the pitch's own example ("the couch on Marketplace") real. But getting
  past anti-bot is not the same as being allowed to: Facebook's terms prohibit automated
  collection. Merchant product pages are clearly fine, being the same public product data as
  `/products.json` only rendered. Marketplace is a deliberate call, not an accident.
- Whether the lighting gap is worth a category-prior pass (2Modern/Kohara publish height but not
  the third axis) or another merchant.

Pick vendors that make the demo easy: furniture with real dimension data, clean product photos
on plain backgrounds, and a category mix that suits a small room.

## Your interfaces

| Direction | Interface | Counterparty |
| --- | --- | --- |
| Consume | `/products.json`, `/collections/<handle>/products.json` — public, no auth | External Shopify merchants |
| Consume | `X-Stub: 1` fixture layer on every `/v1` endpoint | Thomas (B), due H1.5 |
| Produce | `POST /objects` request `{ source:"catalog", name, category, bboxMeters, measure, frameKeys[] }` → `Object v1` with `state:"measured"` | Thomas (B) |
| Produce | R2 key `catalog/{merchant}/{productId}/source.jpg` | Ani (C), reads for pre-bake |
| Consume | `Object v1` fields `bboxMeters`, `measure.confidence`, `caption`, `palette` once `state:"ready"` | Ani (C) writes on generation |
| Consume | Vectorize index `objects-v1` metadata: `objectId, source, category, w_mm, h_mm, d_mm, dominant_hex` | Ani (C) writes embeddings; you query for ranking |
| Produce | Ranking logic behind `POST /search` body `{ text?, imageKey?, fit?, source?, limit }`, where `fit` is `{ maxW, maxH, maxD }` (integer-range filter, never a vector term) | Thomas (B) hosts the endpoint |
| Produce | The search query shape you actually need | Thomas (B), due H12 |
| Consume | Claude API for intent and spoken response (`services/ingest` already pins `anthropic`) | external |
| Consume | Browserbase Fetch (`/v1/fetch`) for rendered product pages | external, `BROWSERBASE_API_KEY` |
| Consume | `GET /objects/{id}` for measured geometry the voice loop reasons against | Thomas (B) |

Everything you write into `bboxMeters` is metres, float, even though merchant data arrives in
inches, cm, or mixed units. Converting is your job, at ingest — never downstream.

## Hour by hour

| Hour | Task | Blocks whom |
| --- | --- | --- |
| H-4–H0 | **DONE.** Merchants verified, three viable, ~390 dimensioned products. Regex pass built and tested against their real catalogues. Search ranking built. Voice assistant built. Get `BROWSERBASE_API_KEY` working. | Yourself, at H0 |
| H0–H1.5 | Pull full catalogs from the three merchants, index locally. Curate ~100 for Ani's pre-bake — the binding constraint is his generation throughput, not catalogue size. | Ani (needs the list) |
| H1.5–H4 | Step 2.5: Browserbase rendered-page pass, warm the cache. | — |
| H4 | Report the real extraction hit rate. 15-min sync, all four. | Everyone (track viability signal) |
| H4–H10 | LLM pass on `body_html`, then the validation layer (steps 2–4). | Ani (needs images + dims by H14) |
| H4–H10 | Marketplace spike via Browserbase, hard-timeboxed to 2 hours. Drop it the moment it fights back. Check terms first. | Nobody — pure upside if it lands |
| H10 | Kill-criteria gate: demo spine, judged by you. A stranger's object reaches the headset at true scale, or the team cuts to phone-only. | Everyone |
| H10–H14 | Wire the voice assistant into Thomas's `VoiceScreen`; decide where the agent runs. | Nobody |
| H14–H16 | Point search ranking at Ani's real embeddings (`VectorizeIndex` swaps in for `BruteForceIndex`). | Thomas needs the query shape by H12 |
| H10–H16 | One rehearsed live Browserbase fetch for the demo. | Nobody |
| H16 | Stop starting new work. Get one complete path working, rehearse it once. | — |
| H16–H20 | Converge on one working path, write track submission text. | All four |
| H20 | Track lock. Fit engine and P3 must exist to select for them. P3 now carries Shopify, Rox **and** Browserbase. | All four |
| H20–H28 | If Shopify + Rox selected: agent loop, scout → fit → style → budget. If not selected: drop P3, move to search + voice depth instead. | Nobody — second-pass work |
| H28–H31 | Hardening. Freeze at H31 — nothing merges after except fixes. | All four |
| H31–H33 | Rehearsal on venue network, full 60 seconds, five times. Rehearse the voice loop's failure path out loud. | All four |
| H33–H34 | Submit. | — |

## The extraction pipeline

Six steps now. `services/ingest/EXTRACTION.md` is the detail; this is the shape.

1. **Regex pass** on numeric patterns adjacent to width/depth/height/W/D/H tokens. Built and
   tested against the three merchants' real catalogues. Handles label-first (`W 60"`) *and*
   label-last (`15.5" H x 19.75" L`) — that second one was missing at first and read Sabai as
   0%. Refuses a unitless `60 x 30` and a range (`13-24"L`) rather than inventing a number.
2. **LLM pass** over remaining `body_html`, constrained output schema, for what regex missed.
2.5. **Rendered page pass (Browserbase)** for stores whose `/products.json` carries no dimensions
   at all, because they sit in metafields the endpoint does not serve. JSON-LD first (the only
   source where the axis is unambiguous), then a labelled spec block, then page text. Cached to
   disk, with one live fetch on stage.
3. **VLM pass** on spec-sheet images, for products where dimensions never appear as text at all.
4. **Validation** — the step the Rox rubric actually rewards. Unit sanity (a sofa is not 8 cm
   wide), category priors (a dining chair is 40–50 cm), and cross-checking the claimed
   width-to-height ratio against the product photo's aspect ratio. This is genuine multi-source
   resolution, not a scrape. The category-prior table is shared: search ranking and the voice
   assistant's clearance answer both read it.
5. **Confidence score** — the difference between an agent and a scraper. Low confidence surfaces
   in the UI as "unverified fit," never a silent guess. Feed this into `measure.confidence` on
   `Object v1` (`measure.method: "extracted"`).

## The voice assistant

**Huawei OMNI Live is dropped.** 40% of that rubric is real-time conversational quality —
streaming, barge-in, multi-turn — which this product does not want, and scoring it would have
meant building a conversation for the judges rather than for the room. What stays is the useful
half: a voice layer over measured geometry, on one ordinary LLM.

Hold the phone at an object → ask "what is this, will it fit beside my desk?" → answer aloud
citing the measured `bboxMeters`. Two model calls per utterance: pass 1 turns the transcript into
a structured intent (no tool results in context, so it *cannot* state a measurement), a fixed
per-action pipeline runs the tools, pass 2 speaks — and every number it says is checked against
the tool results. The rule is `CLAUDE.md` standing rule 3, tightened: **no number originates in
the model.**

Apple's on-device `Speech` framework does the transcription, so Thomas's existing `onTranscript`
stub is the right surface and nothing is owed on the Swift side. In-headset voice stays a stretch
goal — Quest browser speech support is inconsistent. Narration also covers generation latency:
15 seconds of dead air becomes 15 seconds of progress.

Built and tested at `apps/mobile/src/voice/` — see `TOOLS.md` there. Runs with no key, no server
and no phone: `node dev/test.mjs`. **Open: where the agent runs.** In-app means an API key on the
device; the transport is injected so a Worker route or a small service is a one-line swap.

## Done when

- ~~Merchant catalogs verified~~ **done**: three merchants, ~390 dimensioned products.
- The pipeline runs end to end and every catalog object carries a `measure.confidence`;
  low-confidence items show as "unverified fit," never a silent number.
- Step 2.5 pulls dimensions from a rendered page for at least one store whose API has none, and
  one live Browserbase fetch is rehearsed for the stage.
- The voice assistant runs on the phone — point, ask, hear an answer that cites the measured
  geometry — and no number it speaks came from anywhere but a tool call.
- "Find something that fits the 80 cm gap beside my desk and matches its wood tone" returns
  results where the fit filter is a true `w_mm`/`h_mm`/`d_mm` range check, never a vector term.
- An empty result set never reaches the stage: the fit filter relaxes by 10% and results are
  labelled "relaxed" instead.

## Cut list, in order

1. **Facebook Marketplace spike.** No sponsor track names it. Drop at the 2-hour mark without
   regret.
2. **The multi-agent design loop** (scout → fit → style → budget). Huawei openJiuwen dies with it;
   nothing else is affected. A single LLM call does the same job on stage.
3. **In-headset voice.** Nothing dies. Keep the phone-only voice complete and drop this first if
   the headset is behind.
4. **Step 2.5.** Costs Browserbase. The three viable merchants already cover the pre-bake without
   it, so this is a track, not a dependency.
5. **The rest of P3** (catalog ingest, extraction, validation). Shopify, Rox **and** Browserbase
   die together — one bet on this pipeline, now carrying three tracks rather than two. It was
   written up as the most cuttable piece in the build; it is no longer.
6. **Search ranking**, last resort. Costs the Cloudflare "Best Agent with a Brain" retrieval claim
   and the second pitch differentiator. Keep the voice assistant even if everything else is gone.

## Traps

- A merchant that serves `/products.json` perfectly can still carry no dimensions in it. The
  number that decides a merchant is `usable`, never `ok` — four of eleven reachable stores were
  green on reachability and worth nothing.
- There is no standard Shopify dimensions field. Expect the answer to live in metafields,
  `body_html` free text in mixed units, variant titles (`60" x 30"`), a spec image, or nowhere —
  don't build the pipeline around one canonical source.
- Expressing fit as a vector term instead of an integer range filter on `w_mm/h_mm/d_mm` returns
  results that look right and do not fit. This is the exact failure the product exists to prevent.
- Returning an empty result set on stage instead of relaxing the fit filter by 10% and labelling
  it — an empty screen is worse than a slightly-off result.
- Letting the model state a measurement. It will not fail loudly — it will say "about 45
  centimetres" confidently and be wrong, in a product whose whole claim is that other tools are
  dimensionally false. `assertGrounded()` checks every spoken number against the tool results.
- Trusting the Web Speech API to be present in the Quest browser. If headset voice ships, it's
  push-to-talk streaming to a server, never a bare browser API call.
- Testing the logic and not the entrypoint. Three real bugs this build shipped past unit tests
  and died at the HTTP or CLI boundary: a gate that failed a successful probe, snake_case output
  the crawler could not read, and a degraded-search header containing an em dash — HTTP headers
  are latin-1, so it returned a 500 instead of results.
- Silently guessing a dimension instead of surfacing low confidence as "unverified fit" — this is
  the line between an agent and a scraper, per the Rox rubric.
- Storing or comparing anything in centimetres or inches. Convert at ingest; every schema field is
  metres.

## Who to ask

| Person | They owe you | Due | You owe them | Due |
| --- | --- | --- | --- | --- |
| Thomas (A, B) | Fixtures and the `X-Stub: 1` layer; `/search` live and answering, ranking stubbed | H1.5; H16 | The search query shape you need — **`palette` and `likeObjectId` are proposed, see `services/search/README.md`** | H12 |
| Ani (C) | Captions, palettes, and embeddings to rank over | H14 | Product images plus extracted dimensions for the pre-bake | H14 |
| Justin (D, E) | `/solve` answering, so your agent loop has an optimiser | H24 | Nothing | — |
| Justin (D, E) | **Asked, not in contracts yet:** a `POST /gaps` free-span helper, if the demo has the system measure a gap rather than the user speaking the number. `find_anchor` v0 is client-side meanwhile. | H10 | Nothing | — |

Every edge above comes from the dependency table in `.claude/contracts.md`, which is the
authority. If you are going to miss one, say so at the previous sync point, not at the due hour.
