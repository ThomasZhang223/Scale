# Paul — Component F, Pipeline P3

## Scope

You own the parts of the product that turn "stuff that exists" into "stuff the system can reason
about and talk about": pulling real furniture listings off the open web, extracting real
dimensions out of messy per-merchant data, ranking search results so style and fit never get
mixed, and the one-loop voice interaction that satisfies Huawei OMNI Live. You do not touch the
app, the backend, the headset, or Baseten — you read their outputs through `.claude/contracts.md`
and write to the same file.

**You own**
- Catalog ingest: Shopify `/products.json` scraping, dimension extraction, validation, confidence scoring (P3).
- Huawei OMNI Live voice loop: vision + speech + language, one unbroken loop, on the phone (P5).
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

That means these are yours to answer, before H0 where possible:

- Which 15 to 25 furniture merchants, and does `/products.json` actually reach them. Some stores
  disable it. This is the one item that decides whether P3 exists at all, and with it the
  Shopify and Rox tracks.
- Whether any non-Shopify source earns its place. Facebook Marketplace and similar have no
  public catalog endpoint, listings are inconsistent, and dimensions are often absent entirely.
  Timebox any such spike and drop it if it fights back. Use publicly reachable data only, and
  respect each site's terms and rate limits.
- What "good enough" extraction looks like per vendor, since merchants differ wildly in how they
  record dimensions.

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
| Consume | OMNI Live API / cloud API access for the voice loop | Huawei (external, explicitly permitted) |
| Consume | `GET /objects/{id}` for measured geometry the voice loop reasons against | Thomas (B) |

Everything you write into `bboxMeters` is metres, float, even though merchant data arrives in
inches, cm, or mixed units. Converting is your job, at ingest — never downstream.

## Hour by hour

| Hour | Task | Blocks whom |
| --- | --- | --- |
| H-4–H0 | Verify `/products.json` on 15–25 real furniture merchants. This is the single most important row in this file — it decides whether P3 exists at all. Get OMNI API key working. | Yourself, at H0 |
| H0–H1.5 | Pull catalogs from the verified merchants, index locally. Zero dependency on anyone. | — |
| H1.5–H4 | Regex dimension pass over the pulled catalog (step 1 of the extraction pipeline). | — |
| H4 | Report the real extraction hit rate. 15-min sync, all four. | Everyone (track viability signal) |
| H4–H10 | LLM pass on `body_html`, then the validation layer (steps 2–4). | Ani (needs images + dims by H14) |
| H4–H10 | Facebook Marketplace ingest spike, hard-timeboxed to 2 hours. Drop it the moment it fights back. Publicly-reachable data only, respect terms and rate limits. | Nobody — pure upside if it lands |
| H10 | Kill-criteria gate: demo spine, judged by you. A stranger's object reaches the headset at true scale, or the team cuts to phone-only. | Everyone |
| H10–H16 | OMNI voice loop on the phone: vision + speech + language, one loop. | Nobody blocked, but this is what earns Huawei OMNI Live |
| H10–H16 | Search ranking over Ani's embeddings (style vector + fit range filter). | Thomas needs the query shape by H12 |
| H16 | Stop starting new work. Get one complete path working, rehearse it once. | — |
| H16–H20 | Converge on one working path, write track submission text. | All four |
| H20 | Track lock. Fit engine / P3 / three-modality voice loop must exist to select for them. | All four |
| H20–H28 | If Shopify + Rox selected: agent loop, scout → fit → style → budget. If not selected: drop P3, move to search + voice depth instead. | Nobody — second-pass work |
| H28–H31 | Hardening. Freeze at H31 — nothing merges after except fixes. | All four |
| H31–H33 | Rehearsal on venue network, full 60 seconds, five times. Rehearse the voice loop's failure path out loud. | All four |
| H33–H34 | Submit. | — |

## The extraction pipeline

Five steps, run in order, over each merchant's product data.

1. **Regex pass** on numeric patterns adjacent to width/depth/height/W/D/H tokens. Catches ~60%
   for almost no cost.
2. **LLM pass** over remaining `body_html`, constrained output schema, for what regex missed.
3. **VLM pass** on spec-sheet images, for products where dimensions never appear as text at all.
4. **Validation** — the step the Rox rubric actually rewards. Unit sanity (a sofa is not 8 cm
   wide), category priors (a dining chair is 40–50 cm), and cross-checking the claimed
   width-to-height ratio against the product photo's aspect ratio. This is genuine multi-source
   resolution, not a scrape.
5. **Confidence score** — the difference between an agent and a scraper. Low confidence surfaces
   in the UI as "unverified fit," never a silent guess. Feed this into `measure.confidence` on
   `Object v1` (`measure.method: "extracted"`).

## The voice loop

One unbroken loop, not three scattered features: hold the phone at an object → ask "what is
this, will it fit beside my desk?" → identify from live video, reason against the measured
`bboxMeters`, answer aloud. Huawei OMNI Live requires vision, speech, and language together on an
edge device — a loop satisfies that filter, three separate demos of vision/speech/language do not,
and two of three does not qualify at all.

Build it on the phone first: the native Speech framework is on-device, zero-latency, reliable,
and the phone is already in the demo. In-headset voice is a stretch goal only — Quest browser
speech support is inconsistent, and if it ships it must be push-to-talk on the controller
streaming audio to a server, never a bare Web Speech API call. The loop also covers generation
latency: narrate progress instead of leaving 15 seconds of dead air.

## Done when

- 15–25 merchant catalogs are verified live and indexed before any extraction work starts.
- The five-step pipeline runs end to end and every catalog object carries a `measure.confidence`;
  low-confidence items show as "unverified fit," never a silent number.
- The voice loop runs as one sequence on the phone — point, ask, hear an answer that cites the
  measured geometry — with no separate vision/speech/language demos standing in for it.
- "Find something that fits the 80 cm gap beside my desk and matches its wood tone" returns
  results where the fit filter is a true `w_mm`/`h_mm`/`d_mm` range check, never a vector term.
- An empty result set never reaches the stage: the fit filter relaxes by 10% and results are
  labelled "relaxed" instead.

## Cut list, in order

1. **Facebook Marketplace spike.** No sponsor track names it. Drop at the 2-hour mark without
   regret.
2. **The multi-agent design loop** (scout → fit → style → budget). Huawei openJiuwen dies with it;
   Shopify, Rox, and OMNI Live are unaffected. A single LLM call does the same job on stage.
3. **In-headset voice.** Nothing dies — OMNI Live only needs the phone loop. Keep the phone-only
   voice complete and drop this first if the headset is behind.
4. **All of P3** (catalog ingest, extraction, validation). Shopify and Rox die together — they are
   one bet on this pipeline, not two independent tracks. Not a comment on P3's value: it is
   structurally the most cuttable piece in the whole build, and the team knows this going in.
5. **Search ranking**, last resort. Costs the Cloudflare "Best Agent with a Brain" retrieval claim
   and the second pitch differentiator. Keep the voice loop even if everything else here is gone.

## Traps

- Verify `/products.json` on every candidate merchant **before H0**. Finding out at H2 that a
  merchant blocks it costs the whole pipeline's runway, not just that merchant.
- There is no standard Shopify dimensions field. Expect the answer to live in metafields,
  `body_html` free text in mixed units, variant titles (`60" x 30"`), a spec image, or nowhere —
  don't build the pipeline around one canonical source.
- Expressing fit as a vector term instead of an integer range filter on `w_mm/h_mm/d_mm` returns
  results that look right and do not fit. This is the exact failure the product exists to prevent.
- Returning an empty result set on stage instead of relaxing the fit filter by 10% and labelling
  it — an empty screen is worse than a slightly-off result.
- Building vision, speech, and language as three separate demoable features instead of one loop
  fails Huawei OMNI Live's hard three-modality filter outright.
- Trusting the Web Speech API to be present in the Quest browser. If headset voice ships, it's
  push-to-talk streaming to a server, never a bare browser API call.
- Silently guessing a dimension instead of surfacing low confidence as "unverified fit" — this is
  the line between an agent and a scraper, per the Rox rubric.
- Storing or comparing anything in centimetres or inches. Convert at ingest; every schema field is
  metres.

## Who to ask

| Person | They owe you | Due | You owe them | Due |
| --- | --- | --- | --- | --- |
| Thomas (A, B) | Fixtures and the `X-Stub: 1` layer; `/search` live and answering, ranking stubbed | H1.5; H16 | The search query shape you actually need | H12 |
| Ani (C) | Captions, palettes, and embeddings to rank over | H14 | Product images plus extracted dimensions for the pre-bake | H14 |
| Justin (D, E) | `/solve` answering, so your agent loop has an optimiser | H24 | Nothing | — |

Every edge above comes from the dependency table in `.claude/contracts.md`, which is the
authority. If you are going to miss one, say so at the previous sync point, not at the due hour.
