# Ani — Component C: 3D generation, the scale binding, all inference/compute

## Current hackathon scope override — 2026-09-19

Follow [the current runbook](../../services/gen/DEMO_RUNBOOK.md) and actual code;
the original sprint below is historical. B01 package, real B03 embeddings, synthetic
B04 binding, B05 search adapter and B06 local generation composition are implemented.
Paul already owns the index/ranker; Thomas owns durable jobs/storage/finalization;
Justin owns rendering/fit. Ani connects these with small adapters only.

Real SF3D and its orientation/visual binding gate remain externally blocked.
Real product search validation needs Paul's image/identity corpus. Live generation
wiring needs Thomas's durable attempt and authorized selected-object handoff.
The local provider/storage tests are explicitly fake, with actual B04 and teammate
handler execution. Indexing no longer waits for a mesh or state:ready.

Cut from this demo: quality tier, alternate models, 60–100 prebakes, generative
captions, palette/thumbnail helpers, broad benchmarks, automatic frame scoring and
duplicate background-removal/search/backend services. No new Vectorize work is needed.
Scoped local commits are authorized across remaining checkpoints; pushing is not.

This is your scope for the 36-hour build. Read `.claude/contracts.md` first if anything here
seems underspecified — it wins on any disagreement. Skim `.claude/sprint.md` for the full
four-person timeline; this file is your lane extracted from it.

## Scope

You own image-to-3D on Baseten behind two latency tiers, background removal, the scale binding
that turns a normalised mesh into a metrically true one, image embeddings for retrieval, and the
offline pre-bake of the catalog. `live` tier is Stable Fast 3D (one best clean image as input,
sub-second on an A100, ~6 GB VRAM, Stability AI Community License, UV unwrap and PBR params)
for the one on-stage generation. `quality` tier is
TRELLIS 2 or Hunyuan3D Pro for the pre-baked catalog and async upgrades. Both tiers sit behind
one `tier` parameter on the same endpoint.

**You own:**
- Baseten deployment for both tiers, one `tier: "live" | "quality"` parameter
- Background removal before generation
- The scale binding (mesh normalisation contract) — sole owner, see below
- Both input paths (phone scan, catalog product) converging on `Object v1`
- `google/siglip2-base-patch16-224` embeddings (768-dim), caption, colour palette, written on `state:"ready"`
- Pre-baking 60–100 catalog products and caching their GLBs

**You do not own:** the iOS app, backend, or schemas (Thomas); WebXR/Quest or the fit solver
(Justin); OMNI voice or catalog scraping (Paul). Search *ranking* over your embeddings is Paul's;
the `/search` endpoint itself is Thomas's (B) — you only write the vectors.

## Your three objectives

Everything below serves these three, in this order when they conflict. They are the job, not a
quality bar to reach if there is time.

| Objective | What it means concretely | How it is measured |
| --- | --- | --- |
| **Dimensional accuracy** | The binding. Mesh AABB equals `bboxMeters` to within 1 mm, origin at bottom-centre, +Y up, node scale 1. | A tape measure against the object on the table. Not a viewer, not a screenshot. |
| **Fidelity** | The mesh reads as the actual object from a metre away, in a headset, at 1:1. Texture is not a smear and the silhouette is right. | Hand it to someone who has not seen the source object and ask what it is. |
| **Latency** | Time from the last captured frame to a `glbUrl` the phone can load. | Wall clock, on the venue network, at peak. Not on your laptop at 3 am. |

Accuracy outranks fidelity. A correct box beats a beautiful object at the wrong size, because
the whole pitch is that the size is real. Fidelity outranks latency up to the point where the
judge is standing there waiting — past that, latency wins.

### Levers on fidelity

- **Route the sweep by task.** All useful frames can support SigLIP2 retrieval. Stable Fast 3D
  receives one best clean frame, not a multi-view set, so select the frame with the clearest
  silhouette and least occlusion after background removal.
- **Background removal quality feeds mesh quality.** A bad matte becomes geometry. Shoot against
  a clean surface when you can, and check the matte before sending it.
- Stable Fast 3D gives UV unwrap and PBR parameters. Use them rather than baking flat colour.
- Steer away from the known failure set: transparent, reflective, thin, and very dark objects.
  Surface a confidence signal rather than shipping a bad mesh silently.

### Levers on latency

- **Measure the real number first.** Cold start on the venue network at peak, end to end, not
  model inference time. Stable Fast 3D is sub-second on an A100; your wall clock will not be.
  The gap is upload, background removal, and download.
- Keep the endpoint warm. A cold start during the demo is the failure people remember.
- **`state:"measured"` already covers perceived latency.** The phone shows a true measured box in
  under a second while you generate. Your budget is real seconds, not the user's patience.
- Pre-bake the catalog on the `quality` tier, unattended. Exactly one live generation happens on
  stage, on the `live` tier, on an object a judge names.
- Set the real target on Friday after the twenty-object test, and write it here. A guessed
  target is worse than none.

## Your interfaces

You never read another component's internals — only `.claude/contracts.md`.

| Direction | What | Real name | Counterparty |
| --- | --- | --- | --- |
| Consume | Presigned upload target | `POST /uploads` → `{ key, putUrl }` | Thomas (B), due H5 |
| Consume | Job creation / status | `POST /objects/{id}/generate` → `{ jobId }`; `GET /jobs/{id}` → `{ state, progressPct, objectId, error }` | Thomas (B) |
| Consume | Measured object, pre-generation | `Object v1` with `state:"measured"`, real `bboxMeters`, `measure` | Thomas (A→B) |
| Consume | Uploaded frames | R2 `objects/{objectId}/frames/{n}.jpg` | Thomas (A, presigned) |
| Consume | Catalog source images + extracted dims | R2 `catalog/{merchant}/{productId}/source.jpg` + dims for `POST /objects` | Paul (P3), due H14 |
| Consume | Fixtures + stub layer | `fixtures/object-macbook.json`, `fixtures/mesh-macbook.glb`, `X-Stub: 1` | Thomas, due H1.5 |
| Produce | Bound mesh | R2 `objects/{objectId}/mesh.glb`, satisfies the mesh normalisation contract | Justin (D), due H8 |
| Produce | Thumbnail | R2 `objects/{objectId}/thumb.jpg` | Justin (D), Thomas (A) |
| Produce | Object ready state | `Object v1` → `state:"ready"`, `glbUrl`, `caption`, `palette` (written into `objects` D1 table via B) | all |
| Produce | Job progress | `jobs` D1 table rows behind `GET /jobs/{id}` | Thomas (A) |
| Produce | Image embeddings | Vectorize index `objects-v1`, 768-dim `google/siglip2-base-patch16-224`, cosine, metadata `objectId, source, category, w_mm, h_mm, d_mm, dominant_hex` | Paul (F) ranks, Thomas (B) owns `/search` |
| Produce | SSE trigger | `event: object data: Object v1` on `GET /sync/{roomId}` fires when your write flips `state` to `ready` | Justin (D) via B's Durable Object |

## The binding

This is the technical thesis, not a feature. Generated meshes come back normalised, roughly −1
to 1 per axis. You rescale the generated bounding box to the measured box. About ten lines of
code. Say it to a judge as: *the generative model gives shape, the depth sensor gives size, and
we bind them.* Metric-scale reconstruction from single-view RGB-D has no reliable general
solution — every consumer image-to-3D tool ships dimensionally meaningless output. This project
does not solve that problem. It sidesteps it with a depth sensor.

You are the **sole owner** of this binding. If any downstream component (D, E, the phone
renderer) applies its own scale factor, that is a bug, not a preference — the error squares and
nobody finds it until the demo.

Four clauses, all four required on every GLB you publish:

- [ ] **1. AABB match.** The mesh axis-aligned bounding box equals `bboxMeters` to within 1 mm.
      Verify: measure the physical object with a tape measure, compute the exported mesh's AABB
      in a script or viewer, diff against `bboxMeters` — under 1 mm on all three axes.
- [ ] **2. Origin at bottom-centre.** Placement `y = 0` means "on the floor."
      Verify: min Y of the AABB is 0; (min+max)/2 in X and Z is 0.
- [ ] **3. +Y up, −Z front.** Matches the global axis convention.
      Verify: load the GLB in a viewer, confirm the object stands upright and its front face
      points toward −Z.
- [ ] **4. Units in metres, node scale = 1.** No consumer should ever need to rescale.
      Verify: inspect the glTF node — scale is `[1,1,1]`, no wrapping transform.

Do not tell anyone the binding works until you have a tape measure on the physical object and on
the numbers in `Object v1`, and they agree. This is also the H6 kill criterion (judged by
Thomas): if a generated mesh fails to measure true, fall back to a textured box at the measured
dimensions immediately — don't debug the binding live at H10.

## Hour by hour

| Hour | Task | Blocks whom |
| --- | --- | --- |
| H−4–H0 | Baseten account, Stable Fast 3D deployed, 20 test objects run through it | — |
| H0–H1.5 | Baseten endpoint live, cold start timed on venue network | — |
| H1.5–H4 | Fixture image → mesh, round trip timed | — |
| H4 | Report real end-to-end generation latency at sync | all (sync point) |
| H4–H8 | Build the scale binding; background removal; the job worker | Justin waits on this for H8 |
| H8 | **Deliver a real bound GLB to Justin** — satisfies all four clauses above | Justin (D), named dependency |
| H8–H10 | Verify the binding with a tape measure before telling anyone it works | demo spine (H10 exit) |
| H10 | Sync: a stranger's object reaches the headset at true scale | all (kill criterion, judged by Paul) |
| H10–H14 | Start `quality` tier; background removal hardening | — |
| H14 | Receive product images + extracted dimensions from Paul | pre-bake start |
| H14–H16 | Pre-bake catalog unattended; image embeddings written on `state:"ready"` | Paul (search needs vectors) |
| H16 | Stop starting new work. Get one complete generation path solid. | all (sync point) |
| H16–H20 | Converge on the demo candidate; write your submission text | all (track lock at H20) |
| H20–H28 | Inference hardening, pre-bake more catalog (toward 60–100), latency tuning | — |
| H28–H31 | Bug fixes, demo data, rehearsal only — no new features past H31 | all (feature freeze) |
| H31–H33 | Full 60-second rehearsal, five runs, venue network, different phone-holder each time; rehearse the failure narration (generation takes 20s, bad mesh) out loud | all |
| H33–H34 | Buffer, submit at H34 | — |

Sync points: H4, H10, H16, H20, H26, H31 — fifteen minutes, standing, all four.

## Done when

- A photographed object returns a GLB whose AABB matches `bboxMeters` to within 1 mm, confirmed
  with a tape measure on the physical object, not just in code.
- The GLB satisfies all four binding clauses — bottom-centre origin, +Y up, −Z front, node
  scale 1 — checked in a viewer, not assumed.
- Justin has a real bound GLB by H8 and confirms 1:1 in the headset with his own tape measure.
- 60–100 catalog products are pre-baked and cached as GLBs before H20.
- Every object at `state:"ready"` has a 768-dim SigLIP2 embedding, caption, and palette in
  `objects-v1`.
- Cold start and generation latency are measured on the venue network, not at home, and reported
  at the H4 sync.

## Cut list, in order

1. The `quality` tier. Run everything on Stable Fast 3D.
2. Background removal. Shoot against a clean surface instead.
3. Generation itself. Fall back to a textured box at the measured dimensions — ugly, still
   dimensionally true, and the fit engine does not care.

## Traps

- **Known failure set.** Single-image generation degrades badly on transparent, reflective,
  thin, and very dark objects. A MacBook is a good demo object — matte, rectangular, solid. A
  water bottle is the adversarial case. Test 20 random objects on Friday so the boundary is
  known in advance, not discovered on stage.
- **Multi-view beats single-image.** A phone sweep gives four good frames for free — use them
  when you have them instead of forcing single-image generation.
- **Surface a confidence signal, don't get caught.** If a generation is likely to be bad (object
  in the known failure set, low frame count), say so in the response rather than silently
  returning a bad mesh and hoping nobody notices.
- **Measure latency on the venue network.** Cold start and generation time at home on a good
  connection is not the number that matters. Re-measure at the venue before H4.
- **The catalog path's dimensions are extracted, not measured.** Paul's product dimensions come
  from merchant data, not LiDAR. Set `measure.method: "extracted"` (or `"declared"`) and a
  correspondingly lower `measure.confidence` — never claim LiDAR-grade confidence for a number
  nobody measured.

## Who to ask

| Person | They owe you | Due | You owe them | Due |
| --- | --- | --- | --- | --- |
| Thomas (A, B) | Fixtures and the `X-Stub: 1` layer; `/uploads` presign and the job record shape | H1.5; H5 | Embeddings written into `objects-v1`, so `/search` has rows to return | H14 |
| Justin (D, E) | Nothing. He is a pure consumer of your GLBs. | — | A real GLB that satisfies the mesh normalisation contract | H8 |
| Paul (F, P3) | Product images plus extracted dimensions for the pre-bake | H14 | Captions, palettes, and embeddings to rank over | H14 |

Every edge above comes from the dependency table in `.claude/contracts.md`, which is the
authority. If you are going to miss one, say so at the previous sync point, not at the due hour.
