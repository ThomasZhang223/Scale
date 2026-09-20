**Contribution audit snapshot.** This report preserves the findings and verification from the original audit at the commit recorded below. Its file counts, working-tree observations and historical test results refer to that audit. Added to `docs/ANI_CONTRIBUTIONS.md` at your request on 2026-09-20.

Your contribution was Scale’s ML generation and retrieval layer, substantial backend integration, and the Shopify discovery feature. You implemented the path from images and text to product vectors, from generated geometry to a validated metre-scale asset, and from accepted generation work to a stored mesh the application can display. You also built the tests, demos, configuration and operational documentation around those paths.

This account uses **Anirudh Dabas <anirudhdabas7@gmail.com>**, the exact author identity established by all twelve supplied anchors. It attributes commit diffs rather than whole files inherited through merges. The evidence comprises **28 non-merge commits, 5 merges under that identity, and 118 source/configuration/test/documentation paths**: **86 added in your commits and 32 pre-existing paths you edited**. **41 of those paths also have teammate edits.** Two earlier versions retained in reflogs add no unique paths. Eight additional changed paths are accounted for separately as generated evidence, vendored material, an environment example or a PDF.

The mistaken placeholder folder in the repository has been removed. This report was originally generated outside the repository and was subsequently added here at your request. The Shopify feature is already committed in `2a7a94a`; there is no separate uncommitted Shopify diff at the inspected HEAD.

**1. You built the SF3D deployment wrapper and validated its real output.**

Stable Fast 3D supplies the pretrained image-to-mesh computation. Your code makes it usable by this project: a pinned Truss package, controlled model loading, a reusable runtime, bounded image input, background handling, actual GLB serialization and verifiable output. You integrated the pretrained models; you did not train or invent SF3D, DINOv2, OpenCLIP or U2NET.

In `deploy/sf3d/model/model.py`, `CudaRuntime` loads explicit revisions of primary and secondary checkpoints, checks the expected architecture, constructs the model and moves it to CUDA. A reusable rembg/U2NET session handles background removal when needed. The image must have a nonempty foreground before crop/pad and one-image BF16 inference. The result is exported as a textured GLB with settings, revisions, runtime identity, sizes and timings. `Model.load()` retains one runtime, while `Model.predict()` enforces one request at a time and releases its lock on failure.

The transport module validates image input, bounds input/output sizes, hashes the source and verifies returned GLB structure and bytes. The `b02_smoke.py` runner makes an explicit one-shot request and saves output only after validation. This establishes more than endpoint availability: the returned object is an actual artifact tied to its input and model revision.

You subsequently pinned the runtime to one L4 and fixed Truss’s file-loader import behavior without breaking ordinary package imports. Later work added a controlled 512/1024 texture-bake profiling option while retaining 1024 as the normal default.

Evidence: `ba41ae6`, `252edbc`, `cb86603`, `5355602`, `34754ac`; genuine-generation evidence in `eb8a675`.

**2. You implemented the mesh scale binder, including scene transforms and normal maps.**

This is the component that turns dimensionally arbitrary generated geometry into an asset matching a supplied width, height and depth. The renderer receives vertices in metres at scale 1.

`bind_glb` parses the scene, traverses nested transforms and mesh instances, validates positive finite dimensions, applies an explicit reviewed orientation and computes per-axis correction. Conceptually, it subtracts the oriented scene’s bottom-centre and multiplies by target dimensions divided by source extents. The resulting geometry uses +Y up, the reviewed -Z front convention and its base at y=0.

Your implementation goes well beyond multiplying three scale values:

- It handles nested matrix/TRS transforms, repeated mesh instances, multiple material primitives, nonuniform scale and mirrored geometry.
- It bakes the transformation into positions and leaves identity output-node transforms, avoiding hidden additional renderer scaling.
- It transforms normals correctly, generates missing normals and reverses triangle winding for mirrored instances.
- It preserves material assignments, UVs, colors, PBR records, samplers and embedded image bytes.
- It exports and reloads the GLB, independently compares scene bounds and checks the actual serialized dimensions and bottom-centre against a 1 mm tolerance.
- It records hashes, transforms, exact dimensions, versioned cache identities and distortion diagnostics. A binding marker rejects accidental double binding.

The normal-map work in `12a2d1e` is a separate technical contribution. `tangent_frames` reconstructs tangent bases from final geometry and UVs, uses corner-angle weighting, detects conflicting handedness and splits seam vertices when necessary while preserving each triangle corner’s attributes. This keeps normal maps usable after nonuniform scaling. The code does not claim to implement MikkTSpace.

`bind_selected` also protects product identity. Searching with object A and selecting product B must generate from B’s image and bind to B’s dimensions. It checks the image hash and refuses to mix those identities.

The demonstrated guarantee is numerical agreement with supplied dimensions. It does not establish that merchant dimensions or the sample chair’s real physical dimensions were independently measured, and it does not solve room collisions. Your evidence explicitly preserves that distinction.

Evidence: `e95d7f1`, `12a2d1e`, `eb8a675`.

**3. You built real SigLIP2 image/text inference, caching and retrieval adapters.**

`SiglipEncoder` loads the pinned `google/siglip2-base-patch16-224` checkpoint from a local cache, verifies its runtime and processor/tokenizer configuration, runs the real CPU image/text encoder and produces a 768-dimensional L2-normalized vector. Unexpected shapes, zero vectors and nonfinite values fail validation.

You made the representation reproducible. Its fingerprint includes checkpoint/processor assets, runtime versions and preprocessing policy. Images receive EXIF correction and alpha-over-white conversion, with strict format, byte, pixel and side limits. Text is normalized consistently. Each response includes the actual input hash and modality.

The FastAPI boundary accepts exactly one text, inline image or authorized image key. It authenticates internal calls, streams bounded request bodies, checks the expected fingerprint, moves blocking inference off the event loop and distinguishes health, readiness, invalid input and busy responses. A separate opt-in downloader keeps ordinary startup from silently fetching weights.

Your later SQLite cache keys results by fingerprint, modality and content hash, persists across restarts and bounds entry count. Tests prove that image authorization is still checked on cache hits, corrupt vectors are recomputed, and errors are not cached as valid answers.

`records.py` attaches validated vectors and provenance to supplied object metadata. `catalog_manifest.py` imports Paul’s already-downloaded catalog, requires actual backend identity mappings and detects changed image bytes. It preserves known merchant facts instead of inventing prices, dimensions or variant IDs.

`SearchHandoff` reuses Paul’s index and ranker. Your adapter enforces compatible fingerprint/scope and strict metre dimensions, source and budget/currency eligibility. Query images and text are not inserted into the catalog. You added a query CLI and authorized image-key reader to exercise the path.

Evidence: `0f18c06`, `324290d`, `f2b2ff8`, `37f71fe`, `f0a8acc`.

**4. You built the semantic product-retrieval browser demo.**

The independent demo in `services/gen/demo/retrieval` retains one encoder and a normalized matrix for the existing 100-product image corpus. Text/photo inputs pass through the same encoder; NumPy dot product and stable descending sorting produce real nearest neighbors. Product metadata is displayed rather than used to replace weak model rankings.

You built text input, example chips, photo selection/drag-and-drop, product cards and responsive presentation. The server exposes only allowlisted catalog images. Query photos remain in memory and do not alter the corpus. Cache reuse requires matching model fingerprint, manifest hash, ordered image hashes and a valid normalized matrix.

Your committed README records warm local medians of **195.65 ms for text embedding plus ranking**, **578.57 ms for photo embedding**, and **0.44 ms for ranking** on small samples. It also records a real retrieval failure: a coffee-table query ranked a dining table first. These are historical observations, not fresh benchmarks or guarantees of retrieval quality.

Evidence: `ae7bc2c`.

**5. You connected generation, binding, artifact review and delivery.**

`GenerationInput` snapshots the selected object’s identity, source, scope, image bytes/hash and dimensions. `GenerationAttempt.prepare()` calls a provider, verifies input identity, invokes the binder once and produces an immutable artifact/receipt. Repeated calls on a completed attempt reuse that artifact; ambiguous generation timeouts do not silently trigger a second paid request.

`PreparedArtifact` and `VisualReview` tie approval to the exact bound artifact hash. Numerical validity alone does not constitute visual approval. Receipts retain object/image identity, raw/bound hashes, generator revision, binding validation and separate provider/binder times.

`SF3DProvider` validates the provider endpoint and revisions, bounds reads/deadlines and suppresses transport logs that could expose credentials or signed URLs. `WorkerArtifactSink` reuses the existing upload-grant/PUT/asset interface, checks the destination and fetches stored bytes to verify their hash. Delivery can retry the same prepared bytes with a new grant without generating again.

You replaced placeholder stage routes in `app/main.py` with the embedding app and an authenticated `/generate` handler seam. Provider/job authority must be configured; missing configuration and ambiguous/rejected work return explicit failures. This in-process composition is not a substitute for durable backend job ownership.

Evidence: `76864ac`, `922cc51`, `f2b2ff8`, `287a23d`. Later standalone generation-server wiring and additional teammate changes remain separate contributions.

**6. You substantially extended Cloudflare job orchestration and embedding integration.**

Your queue work addresses a subtle concurrency problem: limiting queue delivery concurrency does not limit the number of asynchronous workflows still running. `MeshDispatcher` adds a durable global admission slot so one mesh workflow occupies that slot at a time across deliveries and alarms.

The D1 outbox persists job and dispatch payload before relying on queue delivery. The consumer reuses stable IDs and acknowledges only after durable dispatcher admission. Duplicate delivery and lost workflow-create responses reconcile to existing work. Missing provider configuration leaves accepted jobs waiting.

You added authenticated catalog intake, stable object/job identity, image and dimension validation, and catalog image staging into R2. The existing ingestion workflow can enqueue eligible products without demoting ready objects on replay.

Your changes to the existing generation workflow carry actual source metadata, disable blind retries of paid inference, reject raw unscaled SF3D output, store large GLBs before durable step checkpoints, verify storage and emit a hydrated Object v1. The dedicated CPU encoder supplies index/query vectors using a common fingerprint namespace in Vectorize.

Two follow-up commits change user-visible behavior:

- `f667ab1` immediately notifies/drains the dispatcher after durable acceptance, prioritizes queued live work, serializes concurrent drain attempts and uses completion callbacks with short terminal-status polling. Cron and alarms remain recovery paths.
- `445ce71` marks the stored mesh ready and emits its room event before embedding/indexing finishes. A valid mesh becomes available even while indexing is delayed; indexing failures are recorded separately. Tests deliberately block indexing to prove the ordering.

You also supplied the additive outbox schema, bindings/configuration, health information and verify/submit/status/deploy tooling. These extend the existing backend; its original routes, storage abstractions, SSE foundation and later teammate improvements are shared work.

Evidence: `be931f9`, `f667ab1`, `445ce71`.

**7. You packaged CPU inference and corrected service wiring.**

You configured embeddings on port 8004 with a hashed Linux CPU environment, persistent model/result caches, readiness checks and one Uvicorn worker. Search moved to 8005. Startup scripts validate the arrangement, wait for the model, start an extra tunnel and publish the embedding origin through existing configuration.

The Worker reads private R2 image bytes and sends them inline to the separately authenticated encoder. The embedding container needs neither R2 credentials nor a GPU-generation endpoint. Model fingerprints prevent incompatible runtimes’ vectors from sharing an index namespace.

Evidence: `f0a8acc` and the Worker integration in `be931f9`. Code and deployment instructions do not establish a particular cloud deployment’s present state.

**8. You instrumented generation and used measurements to choose the demo setup.**

`Timings` tracks inclusive/exclusive durations and call counts. `Hooks` wraps the pinned upstream functions and restores methods/properties after success or failure. Coarse CUDA synchronization measures completed work. Stages include startup, conditioning, DINO, transformer/triplane processing, geometry, UV work, materials/textures, transfer and export.

Your four-request experiment separated startup, first prediction and warm repeat:

| Observed condition | Client request time | Interpretation |
| --- | ---: | --- |
| Earlier baseline first prediction | 59.531 s | First-use evidence, not warm steady state. |
| New experiment first 1024 request | 28.710 s | First prediction on that replica. |
| Same-replica repeat 1024 | 1.193 s | Fastest measured total request in this small experiment. |
| Same-replica repeat 512 | 1.282 s | Smaller texture did not improve total request time over the 1024 repeat. |

You kept 1024 because 512 weakened detail without an observed request-time advantage. The evidence records identical expanded triangle geometry across the four requests and passing binding results, including maximum reported bounding-box error of 2.63e-8 metres against supplied software-test dimensions.

Separately, the dispatcher fast path removes the intentional 0–60-second cron scheduling window in tested local behavior. Its completion callback changes the normal check interval from 30 seconds to 250 ms during a bounded finishing window. These are scheduling changes, not measured deployed network latency.

The supported claim is that you implemented profiling, characterized first/warm behavior and removed avoidable orchestration waits. The evidence does not show that your changes made steady-state SF3D computation 98% faster: that percentage compares different warmup conditions. You also wrote the single-L4 judging and explicit shutdown runbook.

Evidence: `a4621a2`, `34754ac`, `f667ab1`, `445ce71`, `ed4765e`.

**9. You built Shopify discovery across the Worker and XR web application.**

The 14-file Shopify commit `2a7a94a` adds isolated read-only discovery with text, reference image and similar-product queries, merchant variants/prices, fit explanations and eligible existing-mesh previews.

`discoverShopify` uses the official Global Catalog MCP/JSON-RPC `search_catalog` and `lookup_catalog` operations. It supports JSON/event-stream responses, bounds sizes and time, and handles empty/partial/malformed/failed responses. Parsing verifies merchant hosts, product/variant IDs, URLs, availability and currency amounts. Global similarity order is preserved; independently refreshed catalog alternatives are labeled separately.

Dimensions are joined conservatively. Generated descriptions are not measurement evidence. A join requires exact canonical merchant product identity, trusted unflagged extraction with adequate confidence and an approved source. Merchant product JSON must confirm product and selected-variant membership. Multiple variants can share dimensions only if their differences are strictly cosmetic; size/configuration ambiguity remains SIZE UNVERIFIED.

The XR helper reuses the existing `fitsNeed` predicate and reports exact clearance or overshoot. It distinguishes FITS, DOESN’T FIT, SIZE UNVERIFIED and SET SPACE; respects currency minor units; selects a smallest physical miss for comparison; and preserves returned checkout URLs with a product-page fallback.

Your UI loads references, resizes a reference image in browser memory, issues bounded requests, renders merchant/variant/evidence cards and re-evaluates fit when constraints change. You supplied HTML/CSS, the Vite entry and additive links from existing listings. Preview requires an exact ready catalog mesh and live XR mode and opens the existing object path without generating a mesh.

The committed 50 cm demonstration records a 45.72 cm table with 4.28 cm clearance and a 50.8 cm table exceeding the limit by 0.8 cm. This is an entered-gap check, not a complete doorway/collision/room-placement guarantee. You implemented discovery and commerce links, not payment processing or a new fit solver.

**10. You wrote the regression coverage, fixtures and handoff documentation.**

The inventory includes 23 test files plus fixture generators and explicit smoke/handoff runners. Coverage includes API/preprocessing contracts, real-model opt-in checks, fingerprints, caches, object/image isolation, scene/material preservation, tangent seams, generation retry rules, actual teammate-handler compatibility, durable admission, storage/publication ordering and Shopify identity/provenance/failure cases.

Committed historical evidence reports 229 generation/binding tests passing with 3 opt-in skips and 24 Worker tests passing at the latency checkpoint; the retrieval-demo checkpoint reports 43 relevant regressions passing. Those are overlapping snapshots, not counts to add. Shopify documentation records additional Worker/XR/build/browser checks, with missing ortools blocking full solver-suite collection and no physical Quest session available. This summary did not rerun models, paid inference, tests or deployments.

Your plan, contracts, runbooks and evidence also clarify who supplies dimensions/identity, what is safe to publish, how services are configured and how results can be reproduced.

A contribution description you can reuse:

> I implemented Scale’s ML generation and retrieval layer: a pinned SF3D deployment wrapper, a mesh binder that validates metre-scale geometry while preserving materials, and a real SigLIP2 image/text embedding service with caching and search adapters. I extended the Cloudflare pipeline with durable single-workflow admission, retry-safe dispatch and mesh publication before indexing, instrumented generation latency, and built the retrieval demo. I also implemented Shopify Global Catalog discovery with conservative variant-level dimension verification, fit explanations and existing-mesh previews, along with tests, configuration and technical handoffs.

This does not claim authorship of the pretrained models, Paul’s core scraper/ranker, the mobile capture implementation, the existing XR renderer/fit engine or the entire Cloudflare backend. Your contributions connect and extend those systems in the specific ways above.

The file-by-file account below identifies every confirmed path. “Added” means your commit introduced the path; “edited” means it already existed. “Shared” means another author has non-merge edits in its history, including files you originally added. Listed commits isolate your contribution from later teammate changes. Links open current files, which may include those later changes.


The following files cover **planning and documentation**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [.claude/contracts.md](../.claude/contracts.md) | Corrected the shared vector contract from CLIP ViT-L/14 to the selected 768-dimensional SigLIP2 representation so embedding producers and retrieval consumers agree. | Edited; shared with Thomas Zhang | `a74ad58` |
| [.claude/workstreams/ani.md](../.claude/workstreams/ani.md) | Updated your workstream to implemented B01-B06 scope, real evidence, integration status and explicit cuts. The older sprint beneath it is historical planning, not a list of completed features. | Edited; shared with Thomas Zhang | `6987004`, `a8375a4`, `a74ad58` |
| [.claude/workstreams/paul.md](../.claude/workstreams/paul.md) | Clarified the SigLIP2 interface, query photos without database insertion, and dimensions/price/source as metadata constraints. | Edited; shared with Paul, Thomas Zhang | `a74ad58` |
| [BUILD_DOC.md](../BUILD_DOC.md) | Corrected SF3D licensing and single-image input descriptions and clarified query embedding, indexing, ranking and ownership boundaries. | Edited; shared with Thomas Zhang | `a74ad58` |
| [docs/ANI_ML_EXECUTION_PLAN.md](../docs/ANI_ML_EXECUTION_PLAN.md) | Created and maintained the ML audit, B01-B06 implementation plan, version/environment choices, interfaces, measured evidence, handoffs and incomplete checks. | Added; no other non-merge author found for this path | `287a23d`, `eb8a675`, `37f71fe`, `a8375a4`, `e95d7f1`, `0f18c06`, `e3d783f`, `ba41ae6` |
| [services/gen/DEMO_RUNBOOK.md](../services/gen/DEMO_RUNBOOK.md) | Documented how to exercise retrieval/generation/binding, distinguish real from simulated evidence, handle integration gaps and later judge first-request versus warm latency. | Added; no other non-merge author found for this path | `ed4765e`, `287a23d`, `eb8a675`, `37f71fe`, `a8375a4` |
| [services/gen/README.md](../services/gen/README.md) | Updated the service overview from placeholders to implemented components, setup, evidence and handoff links. | Edited; shared with Thomas Zhang | `f0a8acc`, `eb8a675`, `a8375a4`, `0f18c06`, `a74ad58` |

The following files cover **shopify ui**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [apps/xr/index.html](../apps/xr/index.html) | Added the Listings navigation link to the isolated Shopify page; this is a small addition to the existing XR page. | Edited; shared with Thomas Zhang, Tingxuan Wang | `2a7a94a` |
| [apps/xr/shopify.html](../apps/xr/shopify.html) | Created the discovery form, reference/mode selectors, dimension inputs, status/comparison regions and results container. | Added; no other non-merge author found for this path | `2a7a94a` |
| [apps/xr/src/main.ts](../apps/xr/src/main.ts) | Added Find similar on Shopify to listing actions, passing the product reference, category/query and room. The pre-existing XR application is shared code. | Edited; shared with Thomas Zhang, Tingxuan Wang | `2a7a94a` |
| [apps/xr/src/shopify-fit.test.ts](../apps/xr/src/shopify-fit.test.ts) | Tested exact fit/overshoot reasons, invalid dimensions/space, currency minor units, checkout fallback, smallest-miss comparison and live-only preview links preserving room context. | Added; no other non-merge author found for this path | `2a7a94a` |
| [apps/xr/src/shopify-fit.ts](../apps/xr/src/shopify-fit.ts) | Implemented assessShopify, commerceAction, previewUrl, closestSizeMiss and formatPrice; reused fitsNeed to explain clearance/overshoot and preserve real commerce and preview identity. | Added; no other non-merge author found for this path | `2a7a94a` |
| [apps/xr/src/shopify-page.ts](../apps/xr/src/shopify-page.ts) | Implemented reference loading, text/image discovery, in-memory image resizing, bounded requests, safe DOM cards, live constraint updates, comparison and failure/preview states. | Added; no other non-merge author found for this path | `2a7a94a` |
| [apps/xr/src/shopify.css](../apps/xr/src/shopify.css) | Created responsive discovery forms, product cards and visual states for fit, unknown dimensions and failures. | Added; no other non-merge author found for this path | `2a7a94a` |
| [apps/xr/vite.config.ts](../apps/xr/vite.config.ts) | Registered the Shopify HTML page as an additional build entry in the existing XR application. | Edited; shared with Thomas Zhang, Tingxuan Wang | `2a7a94a` |

The following files cover **cpu deployment**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [docker-compose.yml](../docker-compose.yml) | Configured the real CPU embedding service on 8004 with persistent model/result volumes and readiness checks; moved search to 8005 and selected Linux amd64 for the lockfile. | Edited; shared with Thomas Zhang | `f0a8acc` |
| [infra/README.md](../infra/README.md) | Updated the local-edge runbook for embeddings, changed ports, startup and deployment handoff. | Edited; shared with Thomas Zhang | `f0a8acc` |
| [infra/cloudflare/set-upstreams.sh](../infra/cloudflare/set-upstreams.sh) | Added an optional fourth upstream URL and published the embedding origin through the existing Worker configuration mechanism. | Edited; shared with Thomas Zhang | `f0a8acc` |
| [infra/tunnel/config.yml](../infra/tunnel/config.yml) | Changed the search tunnel example to port 8005 after assigning 8004 to embeddings. | Edited; shared with Thomas Zhang | `f0a8acc` |
| [infra/up.sh](../infra/up.sh) | Added embedding configuration checks, readiness waiting, tunnel startup/cleanup and upstream publication, including a guard against stale search-port configuration. | Edited; shared with Thomas Zhang | `f0a8acc` |
| [services/gen/.dockerignore](../services/gen/.dockerignore) | Restricted the build context to application code and the Linux embedding lock, excluding Python caches and unrelated assets. | Added; shared with Thomas Zhang | `f0a8acc` |
| [services/gen/Dockerfile](../services/gen/Dockerfile) | Installed the hashed CPU environment, configured model/result caches and launched one Uvicorn worker on 8004. | Edited; shared with Thomas Zhang | `f0a8acc`, `0f18c06` |
| [services/gen/EMBEDDING_DEPLOY.md](../services/gen/EMBEDDING_DEPLOY.md) | Wrote container/credential/fingerprint/Cloudflare deployment instructions. Some workflow sequencing reflects an earlier stage and is superseded by your later performance commits. | Added; no other non-merge author found for this path | `f0a8acc` |

The following files cover **shopify documentation**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [docs/SHOPIFY.md](../docs/SHOPIFY.md) | Documented discovery, exact variant/dimension evidence, fit semantics, live examples, failure isolation, demo instructions, tests and hardware/solver verification limits. | Added; no other non-merge author found for this path | `2a7a94a` |

The following files cover **binding documentation**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/BINDING.md](../services/gen/BINDING.md) | Documented the implemented binding API, scene/material preservation, dimensional/origin checks, orientation review, distortion, cache identity and test evidence. | Edited; shared with Thomas Zhang | `eb8a675`, `a8375a4`, `e95d7f1` |
| [services/gen/app/binding/README.md](../services/gen/app/binding/README.md) | Documented the package entry points and validation contract, including normal-map support and saved-artifact evidence. | Edited; shared with Thomas Zhang | `eb8a675`, `e95d7f1` |

The following files cover **generation documentation**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/GENERATION_HANDOFF.md](../services/gen/GENERATION_HANDOFF.md) | Specified provider-to-binder-to-Worker contracts, immutable artifacts and reviews, retry boundaries, authenticated generate integration and local-versus-deployed validation limits. | Added; no other non-merge author found for this path | `eb8a675`, `f2b2ff8`, `76864ac` |
| [services/gen/app/baseten/README.md](../services/gen/app/baseten/README.md) | Clarified actual SF3D provider packaging, single-image input and the boundary between implemented live generation and deferred quality-model alternatives. | Edited; shared with Thomas Zhang | `a8375a4`, `ba41ae6` |
| [services/gen/app/bgremove/README.md](../services/gen/app/bgremove/README.md) | Documented background removal inside the SF3D runtime rather than claiming a separate new service. | Edited; shared with Thomas Zhang | `a8375a4` |

The following files cover **retrieval documentation**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/SEARCH_HANDOFF.md](../services/gen/SEARCH_HANDOFF.md) | Documented record export, strict query constraints, indexing before mesh readiness, loopback compatibility, authorized images, catalog conversion and Worker embedding integration. | Added; no other non-merge author found for this path | `f0a8acc`, `287a23d`, `37f71fe`, `f2b2ff8`, `324290d` |
| [services/gen/app/embedding/README.md](../services/gen/app/embedding/README.md) | Documented pinned inference, preprocessing, fingerprints, authorization, model acquisition, environments, API behavior and local measured results. | Edited; shared with Thomas Zhang | `f0a8acc`, `a8375a4`, `0f18c06`, `a74ad58` |
| [services/search/RANKING.md](../services/search/RANKING.md) | Clarified the model, uninserted photo-query behavior and hard metadata constraints; a documentation change, not ownership of Paul's ranker implementation. | Edited; shared with Thomas Zhang | `a74ad58` |
| [services/search/README.md](../services/search/README.md) | Updated service handoff/deployment guidance for the CPU embedding connection and changed local arrangement. | Edited; shared with Paul, Thomas Zhang | `f0a8acc` |

The following files cover **latency work**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/SF3D_JUDGING.md](../services/gen/SF3D_JUDGING.md) | Created the single-L4 activation/readiness, queue-drain, judging and explicit shutdown procedure; separated ACTIVE status from a genuinely warm repeat request. | Added; shared with Thomas Zhang | `ed4765e` |
| [services/gen/SF3D_LATENCY_RESULTS.md](../services/gen/SF3D_LATENCY_RESULTS.md) | Recorded four-request 1024/512 measurements, stage/startup timings, geometry checks, the decision to keep 1024, orchestration improvements and limits on latency claims. | Added; no other non-merge author found for this path | `ed4765e` |

The following files cover **binding implementation**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/app/binding/__init__.py](../services/gen/app/binding/__init__.py) | Exposed the implemented binder's public functions, types and errors through a stable package boundary. | Added; no other non-merge author found for this path | `e95d7f1` |
| [services/gen/app/binding/core.py](../services/gen/app/binding/core.py) | Implemented dimensions, OrientationProfile, raw_key, bound_key, bind_glb and bind_selected: scene-instance traversal, explicit orientation, one-time scaling, bottom-centre origin, preservation, reload validation and provenance. | Added; no other non-merge author found for this path | `12a2d1e`, `e95d7f1` |
| [services/gen/app/binding/glb.py](../services/gen/app/binding/glb.py) | Implemented strict GLB serialization/parsing, buffer/accessor handling, node/world transforms, instance traversal, primitive extraction and supported-feature validation while preserving visual data. | Added; no other non-merge author found for this path | `12a2d1e`, `e95d7f1` |
| [services/gen/app/binding/tangents.py](../services/gen/app/binding/tangents.py) | Implemented angle-weighted tangent reconstruction on final geometry, corrected handedness and duplicated conflicting seam vertices while preserving triangle-corner attributes. | Added; no other non-merge author found for this path | `12a2d1e` |

The following files cover **embedding implementation**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/app/embedding/__init__.py](../services/gen/app/embedding/__init__.py) | Created the embedding package boundary for the encoder, HTTP service and adapters. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/app/embedding/api.py](../services/gen/app/embedding/api.py) | Implemented authenticated /embed, one-input validation, bounded request streaming, authorized image reads, response/fingerprint checks, health/readiness, off-thread inference, typed failures, compatibility adapters and caching. | Added; no other non-merge author found for this path | `f0a8acc`, `f2b2ff8`, `324290d`, `0f18c06` |
| [services/gen/app/embedding/cache.py](../services/gen/app/embedding/cache.py) | Implemented bounded SQLite/WAL vector storage keyed by fingerprint/modality/input hash with recency updates and eviction; raw inputs are not stored in the cache. | Added; no other non-merge author found for this path | `f0a8acc` |
| [services/gen/app/embedding/catalog_manifest.py](../services/gen/app/embedding/catalog_manifest.py) | Converted Paul's downloaded catalog into embedding inputs using supplied backend identities, corpus-contained paths, verified image bytes and preserved merchant/measurement facts. | Added; no other non-merge author found for this path | `37f71fe` |
| [services/gen/app/embedding/config.py](../services/gen/app/embedding/config.py) | Pinned checkpoint/revision, runtime versions, 768-dimensional output, input/batch limits and shared preprocessing policy. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/app/embedding/download.py](../services/gen/app/embedding/download.py) | Added an explicit opt-in checkpoint downloader with pinned revision and allowlisted files, keeping regular startup cache-only. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/app/embedding/encoder.py](../services/gen/app/embedding/encoder.py) | Implemented SiglipEncoder and normalize_features: cached model/runtime validation, provenance fingerprinting, real CPU image/text inference, concurrency guard and finite normalized outputs with input hashes. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/app/embedding/images.py](../services/gen/app/embedding/images.py) | Implemented ManifestImageReader with trusted key-to-file mappings, explicit permitted principals, bounded reads and expected-content hashes. | Added; no other non-merge author found for this path | `f2b2ff8` |
| [services/gen/app/embedding/preprocess.py](../services/gen/app/embedding/preprocess.py) | Implemented JPEG/PNG/base64 validation, byte/pixel/side bounds, EXIF correction, transparency over white, text normalization/UTF-8 bounds and hashing. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/app/embedding/query.py](../services/gen/app/embedding/query.py) | Built a text/photo query CLI over exported records with the same encoder, explicit fingerprint/scope and optional fit/source/budget constraints. | Added; no other non-merge author found for this path | `f2b2ff8` |
| [services/gen/app/embedding/records.py](../services/gen/app/embedding/records.py) | Implemented validated metadata-preserving record creation/export, binding vectors to actual image hashes and supplied facts; rejects incompatible or duplicate index records and missing required fields. | Added; no other non-merge author found for this path | `37f71fe`, `f2b2ff8`, `324290d` |
| [services/gen/app/embedding/search.py](../services/gen/app/embedding/search.py) | Implemented SearchHandoff over Paul's existing index/ranker with fingerprint/scope checks and strict metre/source/budget eligibility; does not insert queries or use relaxed-size fallback. | Added; no other non-merge author found for this path | `324290d` |

The following files cover **generation integration**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/app/generation.py](../services/gen/app/generation.py) | Implemented GenerationInput, GenerationAttempt, PreparedArtifact, VisualReview, deliver and worker_request; protects selected-object identity, runs provider/binding once and separates delivery retries from ambiguous paid inference. | Added; shared with Thomas Zhang | `76864ac` |
| [services/gen/app/generation_io.py](../services/gen/app/generation_io.py) | Implemented SF3DProvider, WorkerArtifactSink, bounded/deadlined response reading and context-scoped transport-log suppression; validates endpoint/revision/hash identity and verifies stored artifacts. | Added; no other non-merge author found for this path | `922cc51`, `76864ac` |
| [services/gen/app/main.py](../services/gen/app/main.py) | Replaced placeholder stage routes with the embedding app and an authenticated injected /generate handler; reports missing authority, ambiguity and rejection explicitly. | Edited; shared with Thomas Zhang | `f2b2ff8`, `0f18c06`, `a74ad58` |

The following files cover **retrieval demo**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/demo/retrieval/README.md](../services/gen/demo/retrieval/README.md) | Recorded startup, the actual 100-image corpus, unchanged cosine ranking, warm timing samples, poor matches, browser verification and cache rules. | Added; no other non-merge author found for this path | `ae7bc2c` |
| [services/gen/demo/retrieval/index.html](../services/gen/demo/retrieval/index.html) | Created text prompts/chips, photo selection/drop, nearest-neighbor product cards and responsive demo presentation. | Added; no other non-merge author found for this path | `ae7bc2c` |
| [services/gen/demo/retrieval/server.py](../services/gen/demo/retrieval/server.py) | Implemented catalog loading, fingerprint/manifest/image-hash matrix caching, real cosine ranking, one resident encoder, constrained image routes and query handling. | Added; no other non-merge author found for this path | `ae7bc2c` |
| [services/gen/demo/retrieval/test_demo.py](../services/gen/demo/retrieval/test_demo.py) | Tested cache invalidation, valid normalized matrices, metadata-independent ranking, no query insertion, catalog path containment and HTTP/image boundaries. | Added; no other non-merge author found for this path | `ae7bc2c` |

The following files cover **sf3d packaging**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/deploy/sf3d/README.md](../services/gen/deploy/sf3d/README.md) | Created the feasibility/deployment runbook covering pins, native builds, one-image inference, transport limits, execution controls, compatibility choices and demonstrated versus unverified behavior. | Added; no other non-merge author found for this path | `ed4765e`, `eb8a675`, `a8375a4`, `ba41ae6` |
| [services/gen/deploy/sf3d/b02_smoke.py](../services/gen/deploy/sf3d/b02_smoke.py) | Implemented explicit one-shot provider testing with endpoint/input validation, bounded no-retry transport, GLB/hash/provenance verification, fresh output directories and restricted bake profiling. | Added; no other non-merge author found for this path | `34754ac`, `ba41ae6` |
| [services/gen/deploy/sf3d/config.yaml](../services/gen/deploy/sf3d/config.yaml) | Defined the pinned Linux/CUDA Truss build, native extension setup, secret declaration and single-L4 runtime; subsequently fixed accelerator selection to one explicit L4. | Added; no other non-merge author found for this path | `252edbc`, `ba41ae6` |

The following files cover **sf3d implementation**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/deploy/sf3d/model/__init__.py](../services/gen/deploy/sf3d/model/__init__.py) | Added the model package marker for consistent wrapper/helper imports. | Added; no other non-merge author found for this path | `ba41ae6` |
| [services/gen/deploy/sf3d/model/model.py](../services/gen/deploy/sf3d/model/model.py) | Implemented CudaRuntime and Truss load/predict, pinned primary/secondary weights, reusable rembg, foreground validation, BF16 inference, GLB export, request lock, import fixes, diagnostics and gated bake profiling. | Added; no other non-merge author found for this path | `34754ac`, `a4621a2`, `5355602`, `cb86603`, `ba41ae6` |
| [services/gen/deploy/sf3d/model/telemetry.py](../services/gen/deploy/sf3d/model/telemetry.py) | Implemented nested completed-work timers and reversible upstream hooks/properties, including inclusive/exclusive durations, call counts and failure cleanup. | Added; no other non-merge author found for this path | `a4621a2` |
| [services/gen/deploy/sf3d/model/transport.py](../services/gen/deploy/sf3d/model/transport.py) | Implemented bounded image/request decoding, artifact response encoding and real GLB/byte/hash verification, with decode diagnostics for profiling. | Added; no other non-merge author found for this path | `a4621a2`, `ba41ae6` |

The following files cover **dependencies**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/deploy/sf3d/requirements.txt](../services/gen/deploy/sf3d/requirements.txt) | Pinned the GPU-runtime dependencies separately from the Truss CLI and CPU inference environments to avoid incompatible dependency combinations. | Added; no other non-merge author found for this path | `ba41ae6` |
| [services/gen/requirements-adapters.txt](../services/gen/requirements-adapters.txt) | Declared the extra trimesh dependency for generation/binding composition on the CPU embedding environment. | Added; no other non-merge author found for this path | `76864ac` |
| [services/gen/requirements-binding.txt](../services/gen/requirements-binding.txt) | Defined the isolated pinned numerical, mesh, image and test dependencies for binding validation. | Added; no other non-merge author found for this path | `e95d7f1` |
| [services/gen/requirements-embedding-linux-py311.txt](../services/gen/requirements-embedding-linux-py311.txt) | Deliberately generated and committed the hashed Linux CPU dependency lock consumed by Docker; reproducibility configuration, not handwritten package implementation. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/requirements-embedding-test.txt](../services/gen/requirements-embedding-test.txt) | Added the embedding test overlay on the runtime requirements. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/requirements-embedding-win-py311.txt](../services/gen/requirements-embedding-win-py311.txt) | Deliberately generated and committed the hashed Windows Python 3.11 CPU environment used for local real-model verification; generated entries are not handwritten implementation. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/requirements.txt](../services/gen/requirements.txt) | Pinned direct CPU embedding/API dependencies to the chosen model and processor/runtime policy. | Edited; shared with Thomas Zhang | `0f18c06` |

The following files cover **binding tests and fixtures**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/tests/data/mesh/README.md](../services/gen/tests/data/mesh/README.md) | Explained that fixture meshes are deterministic synthetic test assets rather than real scans or generated products. | Added; no other non-merge author found for this path | `e95d7f1` |
| [services/gen/tests/data/mesh/synthetic.py](../services/gen/tests/data/mesh/synthetic.py) | Generated small in-memory textured/instanced GLB fixtures with clear axes/front labels and material primitives for repeatable non-GPU validation. | Added; no other non-merge author found for this path | `e95d7f1` |
| [services/gen/tests/test_mesh_cache.py](../services/gen/tests/test_mesh_cache.py) | Tested double-binding refusal, independent target boxes and exact dimension/scope/version/orientation/raw-setting cache identity. | Added; no other non-merge author found for this path | `e95d7f1` |
| [services/gen/tests/test_mesh_contract.py](../services/gen/tests/test_mesh_contract.py) | Tested serialized/reloaded dimensions/origin, visual preservation, malformed/unsupported scenes, degenerate geometry, orientation, distortion, matrix transforms, generated normals and float32 precision. | Added; no other non-merge author found for this path | `12a2d1e`, `e95d7f1` |
| [services/gen/tests/test_mesh_tangents.py](../services/gen/tests/test_mesh_tangents.py) | Tested nonuniform normal-map export, opposite-handedness seam splitting with preserved corners and rejection of unconstructible UV bases. | Added; no other non-merge author found for this path | `12a2d1e` |
| [services/gen/tests/test_selection_binding.py](../services/gen/tests/test_selection_binding.py) | Proved that selecting B after querying A uses B's image and dimensions, preventing query-object scale leakage. | Added; no other non-merge author found for this path | `e95d7f1` |

The following files cover **integration runners and tests**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/tests/run_local_smoke.py](../services/gen/tests/run_local_smoke.py) | Added an opt-in cached real-SigLIP/ranker/binder timing smoke with an explicitly fake generation provider and synthetic object metadata. | Added; no other non-merge author found for this path | `f2b2ff8` |
| [services/gen/tests/run_saved_sf3d_binding.py](../services/gen/tests/run_saved_sf3d_binding.py) | Added offline reproduction using the saved reviewed SF3D chair, producing serialized binding evidence without another model call; target dimensions are a software exercise. | Added; no other non-merge author found for this path | `eb8a675` |
| [services/gen/tests/test_ml_integration.py](../services/gen/tests/test_ml_integration.py) | Exercised existing search HTTP handlers, authorized image reads, auth/fingerprint compatibility, selected-result generation and existing Worker upload/asset handlers with fake R2/KV; aligned checks with main. | Added; no other non-merge author found for this path | `287a23d`, `f2b2ff8` |
| [services/gen/tests/worker_handoff.mjs](../services/gen/tests/worker_handoff.mjs) | Loaded Thomas's existing tracked upload/asset handlers into a Node harness with in-memory R2/KV, verifying single-use grants and byte-preserving retrieval without deployment. | Added; no other non-merge author found for this path | `f2b2ff8` |

The following files cover **embedding tests**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/tests/test_catalog_manifest.py](../services/gen/tests/test_catalog_manifest.py) | Tested catalog conversion/export, metadata/hash preservation, invalid manifest rejection and required backend identities/downloaded images. | Added; no other non-merge author found for this path | `37f71fe` |
| [services/gen/tests/test_embedding_cache.py](../services/gen/tests/test_embedding_cache.py) | Tested normalized cache hits/restart persistence, fingerprint invalidation, authorization before reuse, corrupt entries, capacity eviction and uncached errors/busy responses. | Added; no other non-merge author found for this path | `f0a8acc` |
| [services/gen/tests/test_embedding_contract.py](../services/gen/tests/test_embedding_contract.py) | Tested image/text API contracts, auth/readiness, body limits, fingerprints, storage authorization, model-output validation and busy/batch guards. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/tests/test_embedding_preprocess.py](../services/gen/tests/test_embedding_preprocess.py) | Tested EXIF/full-frame handling, alpha and image modes, corrupt/truncated/animated formats, decompression/size limits and base64/text policy. | Added; no other non-merge author found for this path | `0f18c06` |
| [services/gen/tests/test_embedding_real.py](../services/gen/tests/test_embedding_real.py) | Added opt-in actual-checkpoint image/text and HTTP tests, including tokenizer/output behavior. | Added; no other non-merge author found for this path | `0f18c06` |

The following files cover **generation tests**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/tests/test_generation_adapter.py](../services/gen/tests/test_generation_adapter.py) | Tested selected-object isolation, one provider/binder call, timeout ambiguity, immutable delivery retries, matching review, paid-call defaults, stream bounds, secret-log suppression and transport contracts. | Added; shared with Thomas Zhang | `922cc51`, `76864ac` |

The following files cover **retrieval tests**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/tests/test_index_records.py](../services/gen/tests/test_index_records.py) | Tested deterministic records, invalid metadata/vectors, unknown facts, actual index-handler acceptance, uninserted queries, strict constraints and scope; later corrected a text mock's input hash. | Added; no other non-merge author found for this path | `29c9d4b`, `287a23d`, `f2b2ff8`, `324290d` |
| [services/gen/tests/test_index_records_real.py](../services/gen/tests/test_index_records_real.py) | Added an opt-in real-image export and uninserted real-text query integration check. | Added; no other non-merge author found for this path | `324290d` |

The following files cover **sf3d tests**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [services/gen/tests/test_sf3d_bake.py](../services/gen/tests/test_sf3d_bake.py) | Tested the 512/1024 allowlist, profiling-only override, requested/effective provenance and production rejection of the internal override. | Added; no other non-merge author found for this path | `34754ac` |
| [services/gen/tests/test_sf3d_config.py](../services/gen/tests/test_sf3d_config.py) | Tested config/schema/dependency constraints, image and byte/hash limits, reusable load/session behavior, fixed inference settings, secret prerequisites and safe one-shot runner behavior. | Added; no other non-merge author found for this path | `252edbc`, `ba41ae6` |
| [services/gen/tests/test_sf3d_runtime_import.py](../services/gen/tests/test_sf3d_runtime_import.py) | Reproduced ordinary package loading and Truss file-loader loading to catch deployment-only import failures. | Added; no other non-merge author found for this path | `5355602`, `cb86603` |
| [services/gen/tests/test_sf3d_telemetry.py](../services/gen/tests/test_sf3d_telemetry.py) | Tested nested timers, synchronization boundaries, reversible method/property hooks, failure restoration and unchanged input/artifact identity. | Added; no other non-merge author found for this path | `a4621a2` |

The following files cover **worker operations**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [workers/MESH_QUEUE.md](../workers/MESH_QUEUE.md) | Wrote the durable queue/deployment handoff: admission, concurrency, provider contract, setup, verification, operations and recovery. | Added; no other non-merge author found for this path | `be931f9` |
| [workers/README.md](../workers/README.md) | Linked and documented the new mesh pipeline in the existing Worker guide. | Edited; shared with Thomas Zhang | `be931f9` |
| [workers/package.json](../workers/package.json) | Added mesh deployment/check, verification, submission and status script wiring to the existing package. | Edited; shared with Thomas Zhang, Tingxuan Wang | `be931f9` |
| [workers/scripts/catalog-queue.mjs](../workers/scripts/catalog-queue.mjs) | Created verify/submit/status tooling: check pipeline readiness, submit manifest batches, retain job receipts, poll jobs and verify returned GLBs. Later teammate-added modes are separate. | Added; shared with Thomas Zhang | `be931f9` |
| [workers/scripts/deploy-mesh.mjs](../workers/scripts/deploy-mesh.mjs) | Created the types/typecheck/test/dry-run helper followed by additive schema deployment and Worker/queue inspection; later teammate expansion is shared. | Added; shared with Thomas Zhang | `be931f9` |

The following files cover **worker orchestration**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [workers/src/agents/mesh-dispatcher.ts](../workers/src/agents/mesh-dispatcher.ts) | Created durable pending/seen/active state and one global workflow slot; later added serialized immediate draining, live priority and terminal-status reconciliation. | Added; no other non-merge author found for this path | `f667ab1`, `be931f9` |
| [workers/src/lib/catalog-ingest.ts](../workers/src/lib/catalog-ingest.ts) | Implemented catalog normalization, stable identities, dimension/HTTPS-image checks, authenticated batch intake, idempotent object creation and durable admission. | Added; shared with Thomas Zhang, Tingxuan Wang | `be931f9` |
| [workers/src/lib/mesh-dispatch.ts](../workers/src/lib/mesh-dispatch.ts) | Implemented transactional D1 job/outbox acceptance, recovery relay, later immediate best-effort notification and completion callbacks. | Added; no other non-merge author found for this path | `f667ab1`, `be931f9` |
| [workers/src/lib/queue.ts](../workers/src/lib/queue.ts) | Implemented at-least-once consumption with stable/reused job IDs, idempotent insertion, durable admission, acknowledgement after handoff and failure retries. | Added; no other non-merge author found for this path | `be931f9` |
| [workers/src/mesh-schema.sql](../workers/src/mesh-schema.sql) | Added the replay-safe mesh_outbox table and delivery index to preserve accepted jobs until dispatch acknowledgement. | Added; no other non-merge author found for this path | `be931f9` |
| [workers/src/workflows/generate-mesh.ts](../workers/src/workflows/generate-mesh.ts) | Extended catalog staging, source identity, no-blind-inference-retry behavior, raw-output rejection, large-GLB persistence and embedding/indexing; later moved ready/SSE ahead of indexing and notified dispatcher completion. | Edited; shared with Thomas Zhang | `445ce71`, `f667ab1`, `be931f9` |
| [workers/src/workflows/ingest-merchant.ts](../workers/src/workflows/ingest-merchant.ts) | Queued eligible existing extraction results, normalized stable identity, preserved ready objects on replay, counted missing images and safely changed durable crawl serialization. | Edited; shared with Paul, Thomas Zhang | `be931f9` |

The following files cover **worker routing**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [workers/src/index.ts](../workers/src/index.ts) | Wired catalog intake, queue consumer, recovery schedule and dispatcher export, then added Shopify dispatch to the existing entry point. | Edited; shared with Thomas Zhang, Tingxuan Wang | `2a7a94a`, `be931f9` |
| [workers/src/lib/config.ts](../workers/src/lib/config.ts) | Extended the existing upstream-service type to include embeddings. | Edited; shared with Thomas Zhang | `be931f9` |
| [workers/src/routes/index.ts](../workers/src/routes/index.ts) | Changed generation to durable admission, integrated CPU query embeddings and fingerprint namespaces, avoided unrelated empty local indexes and exposed embedding/pipeline health. | Edited; shared with Thomas Zhang, Tingxuan Wang | `be931f9` |
| [workers/src/types.d.ts](../workers/src/types.d.ts) | Declared the dedicated optional embedding-service token separately from the GPU provider credential. | Edited; shared with Thomas Zhang | `be931f9` |

The following files cover **worker embedding**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [workers/src/lib/embedding.ts](../workers/src/lib/embedding.ts) | Implemented private R2-image/text transport to the authenticated CPU encoder and vector/modality/fingerprint validation; later teammate extensions are not claimed here. | Added; shared with Thomas Zhang | `be931f9` |

The following files cover **shopify worker**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [workers/src/lib/shopify-route.ts](../workers/src/lib/shopify-route.ts) | Added bounded/no-store reference and search routes plus optional one-second SELECT-only exact ready-mesh lookup; no catalog writes or generation. | Added; no other non-merge author found for this path | `2a7a94a` |
| [workers/src/lib/shopify.ts](../workers/src/lib/shopify.ts) | Implemented Global Catalog JSON-RPC search/lookup, bounded JSON/SSE transport, merchant/product/variant/price validation, partial failures and conservative extraction-plus-merchant-JSON dimension joins. | Added; no other non-merge author found for this path | `2a7a94a` |

The following files cover **worker tests**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [workers/tests/embedding.test.mjs](../workers/tests/embedding.test.mjs) | Tested encoder transport/auth/R2/vector identity, namespace-aware search, admission, large-GLB persistence, raw-output rejection, index outages and readiness while indexing is blocked. | Added; shared with Thomas Zhang | `445ce71`, `be931f9` |
| [workers/tests/mesh-queue.test.mjs](../workers/tests/mesh-queue.test.mjs) | Tested single active workflow, duplicate deliveries, lost-create-response reconciliation, missing-provider waiting, atomic outbox, recovery, intake auth, immediate dispatch, priority and safe completion. | Added; no other non-merge author found for this path | `f667ab1`, `be931f9` |

The following files cover **shopify tests**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [workers/tests/shopify-route.test.mjs](../workers/tests/shopify-route.test.mjs) | Tested existing routes offline, real reference data, invalid input without service calls, no fabricated Shopify stubs and exact read-only ready-mesh lookup. | Added; no other non-merge author found for this path | `2a7a94a` |
| [workers/tests/shopify.test.mjs](../workers/tests/shopify.test.mjs) | Tested success/timeouts/network/HTTP/JSON-RPC/SSE, exact variant identity, trustworthy dimension evidence, cosmetic versus size variants, empty/partial results, image schemas and commerce fallback. | Added; no other non-merge author found for this path | `2a7a94a` |

The following files cover **worker configuration**.

| File | Your code/change and its purpose | History | Your commits |
| --- | --- | --- | --- |
| [workers/wrangler.toml](../workers/wrangler.toml) | Updated model-related configuration and registered the durable dispatcher binding/migration and recovery scheduling on the shared Worker foundation. | Edited; shared with Thomas Zhang | `be931f9`, `a74ad58` |

Your **28 non-merge commits** appear below in chronological author-date order. File attribution above uses parent diffs, not neighboring commits.

| Commit | Date | Subject |
| --- | --- | --- |
| `a74ad58` | 2026-09-19T02:56:44-04:00 | Update ML retrieval and Baseten pipeline docs |
| `ba41ae6` | 2026-09-19T06:42:56-04:00 | feat(ml): add SF3D feasibility package and smoke tests |
| `e3d783f` | 2026-09-19T07:41:31-04:00 | docs(ml): record B02 preparation and credits-only gate |
| `0f18c06` | 2026-09-19T08:25:30-04:00 | feat(ml): implement SigLIP2 embedding service |
| `e95d7f1` | 2026-09-19T08:42:31-04:00 | feat(ml): add validated mesh scale binding |
| `324290d` | 2026-09-19T14:34:39-04:00 | feat(ml): export SigLIP2 records for existing search |
| `76864ac` | 2026-09-19T14:40:50-04:00 | feat(ml): connect generation artifacts to mesh binding |
| `f2b2ff8` | 2026-09-19T14:48:00-04:00 | test(ml): verify generation and retrieval integration |
| `922cc51` | 2026-09-19T14:52:55-04:00 | fix(ml): bound provider reads and suppress transport secrets |
| `a8375a4` | 2026-09-19T14:54:02-04:00 | docs(ml): add demo runbook and measured ML timings |
| `37f71fe` | 2026-09-19T14:57:30-04:00 | feat(ml): accept current ingestion image manifests |
| `252edbc` | 2026-09-19T16:06:34-04:00 | fix(ml): pin SF3D deployment to one L4 |
| `cb86603` | 2026-09-19T16:09:22-04:00 | fix(ml): make SF3D Truss model imports runtime-safe |
| `12a2d1e` | 2026-09-19T16:59:12-04:00 | fix(ml): support normal-mapped mesh binding |
| `5355602` | 2026-09-19T16:59:18-04:00 | fix(ml): preserve local and Truss SF3D imports |
| `eb8a675` | 2026-09-19T16:59:23-04:00 | test(ml): verify real SF3D generation and binding |
| `287a23d` | 2026-09-19T17:01:26-04:00 | test(ml): align integration checks with latest main |
| `6987004` | 2026-09-19T17:02:35-04:00 | docs(ml): finalize Ani workstream status |
| `ae7bc2c` | 2026-09-19T17:59:33-04:00 | feat(ml): add live semantic product retrieval demo |
| `be931f9` | 2026-09-19T18:43:23-04:00 | feat(workers): serialize catalogue mesh jobs and add deployment handoff |
| `f0a8acc` | 2026-09-19T18:56:32-04:00 | feat: containerize embeddings and integrate cached Cloudflare indexing |
| `a4621a2` | 2026-09-19T20:07:39-04:00 | feat(gen): add stage-level SF3D latency telemetry |
| `34754ac` | 2026-09-19T20:11:55-04:00 | feat(gen): add bounded SF3D bake-resolution setting |
| `f667ab1` | 2026-09-19T20:16:05-04:00 | perf(workers): dispatch live mesh jobs immediately |
| `445ce71` | 2026-09-19T20:18:08-04:00 | perf(workers): publish validated meshes before indexing |
| `29c9d4b` | 2026-09-19T20:24:37-04:00 | test(gen): align text fixture with embedding identity validation |
| `ed4765e` | 2026-09-19T20:46:02-04:00 | docs(demo): define warm SF3D judging procedure |
| `2a7a94a` | 2026-09-20T05:14:41-04:00 | feat(shopify): add isolated discovery with verified dimensions and fit explanations |

The five confirmed-author merges are `8156fee`, `38bd60b`, `5030b27`, `2b6f5c5` and `ab8f962`. They add no independent original paths to this account. Full combined hunks for the last merge combine your Shopify navigation from `2a7a94a` with existing upstream XR edits. Other merge files are inherited from parents.

The GitHub noreply identity on `5a24db5` is contextually associated with you but not established by the supplied anchors; it appears on a merge with no independent source contribution. Reflog-only `3ad4464` and `cb530c7` are earlier versions of your recorded work and add no unique paths.

Eight additional paths were touched in your commits. They are separate from the 118 code/configuration/test/documentation inventory, but still belong in a complete account:

| Path | What changed and why it is separate | Your commits |
| --- | --- | --- |
| `Full Scale — Hack the North 2026 Build Doc.pdf` | Changed the binary build-document export alongside the architectural text. The text-source changes are described under BUILD_DOC.md; the PDF is not implementation source. | `a74ad58` |
| `infra/.env.example` | Updated the tracked embedding credential/port template. A configuration-template contribution, excluded from the placeholder inventory because you requested no .env-family files. | `f0a8acc` |
| `services/gen/deploy/sf3d/schema/TRUSS-LICENSE` | Selected and committed upstream Truss schema, server constraints or license for validation. The contents are vendored third-party work, not your authored implementation. | `ba41ae6` |
| `services/gen/deploy/sf3d/schema/server-constraints.txt` | Selected and committed upstream Truss schema, server constraints or license for validation. The contents are vendored third-party work, not your authored implementation. | `ba41ae6` |
| `services/gen/deploy/sf3d/schema/truss-0.18.30.json` | Selected and committed upstream Truss schema, server constraints or license for validation. The contents are vendored third-party work, not your authored implementation. | `ba41ae6` |
| `services/gen/evidence/local-smoke-2026-09-19.json` | Committed generated local model/integration timing evidence, documenting a run rather than adding implementation code. | `a8375a4` |
| `services/gen/evidence/real-sf3d-binding-2026-09-19.json` | Committed evidence for a genuine generated artifact and saved-mesh binding/visual review. Numerical target dimensions are software-test inputs, not independent physical measurements. | `eb8a675` |
| `services/gen/evidence/sf3d-latency-2026-09-19.json` | Committed stage timings, artifact provenance and binding results from the four-request latency experiment; generated evidence supporting the measured-results documentation. | `ed4765e` |

For a technical walkthrough, begin with `app/binding/core.py` and `tangents.py` for geometry, `app/embedding/encoder.py` and `api.py` for inference, `app/generation.py` for artifact identity/retries, `workers/src/agents/mesh-dispatcher.ts` and your workflow diffs for orchestration, and `workers/src/lib/shopify.ts` plus `apps/xr/src/shopify-fit.ts` for commerce discovery. The file tables link to current files; the listed commits isolate your edits from later teammate work.

Verification: the exact 119-file placeholder folder mistakenly added to the repository was removed after confirming its contents. `git status --short` is empty. All 649 previously snapshotted tracked/non-ignored file contents and the Git index match the earlier baseline. Current HEAD is unchanged. No source edit, staging, commit, push or external-service operation was performed for this summary. Background remote-ref updates observed during the earlier audit are outside this task.

Report created 2026-09-20T05:36:30.787965-04:00; inspected HEAD `ab8f962208679a96af2516419f2f7b60d376e6a8`.
