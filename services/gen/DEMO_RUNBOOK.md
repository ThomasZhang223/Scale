# Ani ML demo runbook — 2026-09-19

**Works locally:** real cached embeddings, Paul's search handoff, B04 and B06
software composition. **Not live:** SF3D, product relevance evaluation, deployed
generation workflow/SSE. Keep those claims separate.

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

No real generation/build/load/cold/warm GPU times exist. The fast fake-provider
path does not estimate SF3D latency. Corpus has **zero verified products**, zero
held-out photos; Recall@K is not meaningful. Five synthetic hard-filter checks
had zero violations. Unit fixtures also prove ranking changes with query vectors.

## Remaining dependencies and honest fallback

- **Paul:** supply 5–10 real images with verified object/product/variant identity,
  names/source, metre dimensions and measurement provenance/confidence, and actual
  cents/currency where used. Current 11 merchant sample files contain title/text
  only; newer ingest branch adds extraction fixes, no image/identity dataset.
  Thomas's seed catalog uses `example.com` merchants; Justin's GLBs are renderer
  assets, not verified product/photo pairs. None count as retrieval evidence.
- **Thomas:** connect CPU embed origin/token and the flat Paul search payload;
  hydrate source/authorized image/scope and durable attempt identity for generation;
  stop blind timeout resubmission; retain artifact validation and emit Object v1
  at finalization. Exact paths/gaps: [GENERATION_HANDOFF.md](GENERATION_HANDOFF.md).
  Actual upload/PUT/asset handlers pass with local R2/KV doubles; no deployed
  backend, durable workflow or SSE success is claimed. Justin's Object v1 adapter
  requires `state:ready`, `glbUrl`, `schemaVersion:1`, metre box and scale 1.
- **Account owner / Baseten:** one preflight found no session/user environment
  Baseten API key, deployment URL or standard Truss credentials. Custom deployment
  entitlement and usable credits could not be verified. **BLOCKED_EXTERNAL**.
  No account/deploy/inference requests were made, $0 spent, no compute created.
  Restore credentials securely and verify applicable credit/build coverage for
  the authorized <=US$3 run before the existing B02 runner is used. Do not add a
  payment method or make a speculative deployment. A real GLB then needs Ani's
  orientation/material/distortion review and binding check.

If Baseten is unavailable, keep the existing measured box in the product demo.
There is currently no verified cached SF3D artifact to claim as a fallback. Fake
providers are tests only; the default HTTP service never substitutes them.

Cut: quality tier, bulk prebake, model comparisons, captions, palette/thumbnail,
best-frame scoring, new search/vector DB/backend, broad benchmarks and tuning.
The SF3D rembg path is sufficient; a second background-removal service is cut.
