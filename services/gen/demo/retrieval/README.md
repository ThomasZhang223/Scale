# FULL SCALE local retrieval demo

From the repository root, in PowerShell:

```powershell
& "$env:TEMP\ani-siglip2-b03\venv\Scripts\python.exe" -B services/gen/demo/retrieval/server.py
```

Open **http://127.0.0.1:8765**. Stop with Ctrl+C. Uses the already prepared
B03 Python 3.11.9 environment and downloaded checkpoint; startup is offline.
No new dependencies. See [B03 setup](../../app/embedding/README.md) for a fresh machine.

One process retains the unchanged `SiglipEncoder` and normalized image matrix.
Every query runs the existing text or image encoder followed by NumPy dot product
and descending stable sort. Product metadata is display only. The top five are
always the actual nearest neighbors, with no prompt exceptions or reranking.
Cosine similarity is not confidence or probability. The sole weak-match rule is
best cosine <= 0; this is not a calibrated relevance threshold.

The manifest and images are read directly from `services/ingest/prebake`.
Image routes accept only catalog row indices, never client file paths. Dimensions
come directly from `bboxMeters` and are displayed in centimeters, without
independent verification. Uploaded query photos stay in memory, use B03's JPEG/PNG
validation, and never enter the catalog or cache. No backend object IDs are needed.

The existing `%TEMP%\ani-siglip2-b03\catalog-eval` cache is reused only when its
model fingerprint, manifest SHA-256, and ordered image hashes all match and its
float32 matrix has the expected shape and finite unit vectors. Otherwise, images
are embedded once in batches. Cache output must remain outside the repository.
`--manifest`, `--model-cache`, and `--cache-dir` override these local paths.
The server binds only to loopback on port 8765; this is a demo, not a deployment.

## Verified locally, 2026-09-19

Started from main `cae01fe`. All 100 real product images; existing cache matched.
Model initialization: **26.044 s** including imports within encoder initialization.
Warm CPU measurements (small local samples, excluding browser/network time):

| Measurement | Median |
| --- | ---: |
| Text embedding, 5 warm queries | 195.20 ms |
| Text embedding + ranking, 5 warm queries | 195.65 ms |
| Photo embedding, 3 warm queries | 578.57 ms |
| Cosine ranking, 8 warm text/photo queries | 0.44 ms |

Live text checks, with unmodified rankings:

| Query | First result | Cosine |
| --- | --- | ---: |
| soft beige armchair | Sink Down Lounge Chair | 0.153054 |
| minimal wooden coffee table | Preston 96" Dining Table, Walnut | 0.128005 |
| cozy chair for reading beside a fireplace | Tube Lounge Chair | 0.078232 |
| dark walnut chair with white cushion | Tube Lounge Chair | 0.075305 |
| red Formula One car | Preston 96" Dining Table, Walnut | -0.009625 |

The coffee-table result illustrates a real retrieval failure; the model is not
guaranteed to satisfy all attributes. The car query displays the weak-match notice.
Photo selection and drag/drop of an existing catalog image both returned that
product first, cosine approximately 1.0; this checks the path, not general photo
retrieval accuracy. The catalog remained at 100 products.

Playwright with the locally installed Chromium verified image rendering, Enter,
example chips, photo selection/drop, all 100 image routes, and a 390px responsive
layout. No browser JavaScript errors. The 1440x900 screenshot was visually inspected.
Screenshot and full real-model timing evidence remain outside Git at:

```text
%TEMP%\ani-siglip2-b03\retrieval-demo\soft-beige-armchair.png
%TEMP%\ani-siglip2-b03\retrieval-demo\verification.json
```

Relevant regression suite: **43 passed** (one existing Starlette deprecation warning).
Tests check cache invalidation, metadata-independent ranking, unchanged catalog on
photo queries, input validation, and image path boundaries. Unit tests use synthetic
data; the browser verification above used the real model and real catalog.

```powershell
& "$env:TEMP\ani-siglip2-b03\venv\Scripts\python.exe" -B -m pytest services/gen/demo/retrieval/test_demo.py services/gen/tests/test_embedding_preprocess.py services/gen/tests/test_embedding_contract.py -q -p no:cacheprovider --basetemp "$env:TEMP\ani-siglip2-b03\retrieval-demo\pytest"
```

Checkpoint: [google/siglip2-base-patch16-224](https://huggingface.co/google/siglip2-base-patch16-224),
Apache-2.0, pinned to B03's existing revision and preprocessing policy.
