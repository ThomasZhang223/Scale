# Ani ML demo runbook — 2026-09-19

**Works locally:** real cached embeddings, Paul's search handoff, B04 and B06
software composition. **Real SF3D generation and saved-mesh B04: PASS.**
Product relevance evaluation and deployed generation workflow/SSE remain unproven.
No further Baseten/GPU calls are authorized; use the saved artifact below.

## Start the CPU service

Prerequisites: Python **3.11.9**, B03's platform-specific hashed dependency lock,
approved cached SigLIP2 revision `75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2`,
and `requirements-adapters.txt` for B04/B06. Never install SF3D CUDA dependencies
into this environment. Node 24 is optional for the actual Worker-handler test.

From the repository root, on this prepared Windows machine:

```powershell
$aniRoot = Join-Path $env:TEMP 'ani-siglip2-b03'
$aniPython = Join-Path $aniRoot 'venv\Scripts\python.exe'
$env:PYTHONPATH = (Resolve-Path services/gen).Path
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:EMBEDDING_CACHE_DIR = Join-Path $aniRoot 'models'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
# EMBEDDING_API_KEY must already be supplied securely; do not use a GPU credential.
& $aniPython -m uvicorn app.main:app --host 127.0.0.1 --port 8002 --workers 1 --no-proxy-headers
```

In another terminal, `Invoke-RestMethod http://127.0.0.1:8002/health` must report
`ok`. `/ready` must report `ready:true` and the expected fingerprint. Health alone
does not prove the model loaded. Load took 13.47 seconds in the measured run.
On Windows the tested fingerprint is
`fc3e942234e223f2853a3087c16ed804755419f3fe953a08be80a9441338327d`.
Other runtime fingerprints require a newly embedded corpus; do not mix them.

Optional non-secret configuration:

- `EMBEDDING_IMAGE_MANIFEST`: operator JSON image allowlist with hash/principals;
  see [search handoff](SEARCH_HANDOFF.md). It may include unindexed query photos.
- `EMBEDDING_LOCAL_SEARCH=1`, `EMBEDDING_SEARCH_FINGERPRINT=<corpus fingerprint>`:
  Paul's local no-header caller. Bind to loopback with proxy headers disabled.
  Do not tunnel this compatibility route.
- `EMBEDDING_WORKER_COMPAT=1`: authenticated Thomas caller aliases. Requires the
  fingerprint above and a separately configured CPU embedding token/origin.
- `GENERATION_API_KEY`: separate secret, only needed for a configured generation
  handler. Default `/generate` returns 503; readiness does not imply GPU access.

## Search and smoke commands

For strict dimensions/budget/source, use the export/query commands in
[SEARCH_HANDOFF.md](SEARCH_HANDOFF.md). They call Paul's actual library from the
checkout. Queries need no insertion; objects need no mesh. Unknown prices cannot
pass a budget filter. Scores are blended rank scores, not probabilities.

For Paul's current HTTP demo, open a second terminal at the repository root;
the commands below start his existing service using the CPU environment:

```powershell
$null = Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
Set-Location services/search
$env:EMBED_URL = 'http://127.0.0.1:8002/embed/search'
& "$env:TEMP\ani-siglip2-b03\venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8004 --workers 1
```

GET `http://127.0.0.1:8004/health`, then POST the validated exported JSON to
`/index`. POST `/search` with `{"text":"chair","limit":5}` or a manifest-listed
`imageKey`. Require no `X-Search-Degraded`. His HTTP route can relax fit and ignores
budget; **use the strict local handoff when those constraints matter**. Restarting
his service clears its index. Current search Docker listens on 8080 while root
compose maps 8004:8004: Thomas/Paul must align that before using compose.

Lightweight suite (repository root; set `$aniPython` as above):

```powershell
& $aniPython -m pytest services/gen/tests -q -p no:cacheprovider --basetemp (Join-Path $env:TEMP ('ani-tests-' + [guid]::NewGuid().ToString('N')))
```

Repeat the measured smoke, using the already downloaded official SF3D example:

```powershell
$aniImage = Join-Path $env:TEMP 'ani-sf3d-b02-j14jau_3\chair1.png'
$aniReport = Join-Path $env:TEMP ('ani-smoke-' + [guid]::NewGuid().ToString('N') + '.json')
& $aniPython services/gen/tests/run_local_smoke.py --real --cache-dir $env:EMBEDDING_CACHE_DIR --image $aniImage --image-provenance 'Official SF3D chair1 sample; no verified product metadata' --output $aniReport
```

The sample must exist; no silent download/substitute occurs. This uses one real
image and **synthetic metadata**, three queries, five filter checks, fake provider
and actual B04. It is plumbing only, not a product-quality test. Reports/weights/
meshes stay outside Git. [Saved sanitized evidence](evidence/local-smoke-2026-09-19.json).

## Measured demo costs

One Windows CPU run, four torch threads, cached model. These are individual
observations, **not p95**, not network/deployed latencies:

| Operation | Seconds |
| --- | ---: |
| Real image first / repeat | 0.740 / 0.473 |
| Real text first / repeat | 0.293 / 0.225 |
| Paul's ranker, one synthetic-metadata record | 0.0011–0.0012 |
| Real text -> results, repeated call | 0.173 |
| B04, synthetic textured GLB | 0.023 |
| Real text -> selection -> fake provider -> B04 -> inline completion | 0.249 |

The saved SF3D generation receipt is separate evidence, not a cold/warm benchmark.
The fast fake-provider path does not estimate SF3D latency. Corpus has **zero verified products**, zero
held-out photos; Recall@K is not meaningful. Five synthetic hard-filter checks
had zero violations. Unit fixtures also prove ranking changes with query vectors.

## Remaining dependencies and honest fallback

- **Paul:** supply 5–10 real images with verified object/product/variant identity,
  names/source, metre dimensions and measurement provenance/confidence, and actual
  cents/currency where used. Current 11 merchant sample files contain title/text
  only. The newly visible `0888470` commit adds `build_prebake.py` and image URL
  capture, but no real downloaded corpus. Ask Paul for its downloaded manifest
  with 5–10 items; Ani's [manifest importer](SEARCH_HANDOFF.md#new-paul-image-manifest-0888470)
  accepts that current shape, with Thomas's supplied backend object IDs.
  Thomas's seed catalog uses `example.com` merchants; Justin's GLBs are renderer
  assets, not verified product/photo pairs. None count as retrieval evidence.
- **Thomas:** connect CPU embed origin/token and the flat Paul search payload;
  hydrate source/authorized image/scope and durable attempt identity for generation;
  stop blind timeout resubmission; retain artifact validation and emit Object v1
  at finalization. Exact paths/gaps: [GENERATION_HANDOFF.md](GENERATION_HANDOFF.md).
  Actual upload/PUT/asset handlers pass with local R2/KV doubles; no deployed
  backend, durable workflow or SSE success is claimed. Justin's Object v1 adapter
  requires `state:ready`, `glbUrl`, `schemaVersion:1`, metre box and scale 1.
- **Saved SF3D / B04:** real generation succeeded. The existing deployment's saved
  shutdown receipt says `INACTIVE`, zero replicas. This completion run makes no
  Baseten, inference, model-download or GPU calls. There is no deployed workflow claim.

## Saved real mesh software proof

[Sanitized evidence](evidence/real-sf3d-binding-2026-09-19.json) records raw and bound
hashes, source AABB, exact target and validation. Source extents are
`[0.49763214588165283, 0.9512068629264832, 0.5229946970939636]`.
Multipliers `[1.08, 1.00, 0.96]` yield target W/H/D
`[0.5374427175521851, 0.9512068629264832, 0.502074909210205]` metres;
distortion is **1.125**. This is a moderate nonuniform software test target.
The real chair's physical dimensions were **not independently measured**.

Local root: `C:\Users\hp\AppData\Local\Temp\ani-sf3d-team26-7a0c56f9`.
Open `bound\chair-bound.glb` in Blender. Previews are
`bound\bound-six-views.png` and `bound\raw-vs-bound.png`.
The preview uses Blender Cycles **CPU**, embedded base color and normal map, and
explicit exported tangent/bitangent/normal attributes. No GPU render is used.
Raw preview placement is centred on the floor for comparison; raw bytes are unchanged.
The chair remains upright, with -Z front, visible wood/upholstery and no obvious
new tangent shading or shape damage. Uneven individual feet are inherited from
SF3D; bottom-centre/minY is exactly zero. This is not a physical accuracy review.

Reproduce numeric evidence using only the saved raw artifact (new output directory):

```powershell
& $aniPython services/gen/tests/run_saved_sf3d_binding.py --raw "$env:TEMP\ani-sf3d-team26-7a0c56f9\raw\mesh.glb" --output "$env:TEMP\ani-sf3d-binding-recheck"
```

The script requires the reviewed raw SHA; it refuses other artifacts or an
output directory inside Git. It never regenerates SF3D. Normal maps use final
geometry tangents, with five duplicated seam vertices and unchanged UV corners,
material records and embedded image hashes. Dimensions reload with errors
`[2.622604367e-8, 0, 1.192092891e-8]` metres and zero origin error.
Current full lightweight tests: **210 passed, 3 skipped** (opt-in real-model checks).

Cut: quality tier, bulk prebake, model comparisons, captions, palette/thumbnail,
best-frame scoring, new search/vector DB/backend, broad benchmarks and tuning.
The SF3D rembg path is sufficient; a second background-removal service is cut.

Integration authorization now includes normal merges of latest `origin/main`
into `ani/ml`, branch push, then a normal merge into main and push after tests.
No rebase, squash, reset or force push. The Git history records the completed sync.
