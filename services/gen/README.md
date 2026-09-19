# Ani ML: current implementation

Real SigLIP2 image/text embeddings, search records, mesh binding and local generation
composition are implemented. **Live SF3D is externally blocked; no real generated
mesh has been validated.** See [the demo runbook](DEMO_RUNBOOK.md) for commands,
measured timings, fallback behavior and exact teammate dependencies.

| Piece | Evidence / limit |
| --- | --- |
| B01 SF3D package | Prepared and package-tested; GPU build/load not proven |
| B03 SigLIP2 | Real cached model, image/text and HTTP checks pass |
| B04 binder | 66 synthetic software tests; real SF3D orientation still unproved |
| B05 search handoff | Paul's existing index/ranker and HTTP input; strict local filters |
| B06 generation handoff | Real B04, fake provider tests; immutable bytes and retry-safe delivery |
| Local integration | Actual Paul and Thomas storage handlers, fake encoder/provider/R2 in tests |
| Product retrieval quality | No legitimate image/identity corpus; no quality claim |

- [Embedding setup/API](app/embedding/README.md): CPU-only pinned environment,
  cache-only load, authenticated `/embed`, `/health` and `/ready`.
- [Search handoff](SEARCH_HANDOFF.md): export/query commands, fingerprint checks,
  image manifest and caller compatibility; indexing is independent of mesh state.
- [Binding contract](BINDING.md): metres, bottom-centre, +Y up, explicit front,
  serialized bounds within 1 mm, material preservation and distortion diagnostic.
- [Generation handoff](GENERATION_HANDOFF.md): provider -> B04 -> validated artifact
  -> Thomas `glbBase64`/`glbKey`; no second jobs, storage or SSE system.
- [SF3D package](deploy/sf3d/README.md): isolated GPU candidate and bounded runner.

`app.main` serves embeddings on port 8002. `/generate` has an authenticated,
injectable composition seam; it returns 503 until provider/job authority is
configured. `/ready` reports embedding readiness only, not generation readiness.
The unused `/bind`, `/baseten`, `/bgremove` stage stubs were removed: binding is a
library and SF3D already has rembg. No caller in the inspected team code used them.

Thomas owns backend/Cloudflare, Paul owns search/ingest/ranking, Justin owns
renderer/fit. The supplied size and its physical accuracy remain the data owner's
responsibility; binding proves agreement with that size, not real-world accuracy.

Out of hackathon scope: quality tier, alternate models, 60-100 prebakes, captions,
palette/thumbnail helpers (no current required consumer), best-frame scoring,
large benchmarks, fine-tuning, extra vector databases and advanced caching.
The existing gen Docker image is embedding-only; its Linux runtime has not been
live-tested here. Use the local checkout for the CPU composition/search helpers.
