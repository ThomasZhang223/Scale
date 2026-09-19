# B03: independent SigLIP2 embeddings

One image **or** text becomes a real 768-dimension, finite, L2-normalized float32
vector. This module does not generate captions/meshes, combine modalities, fetch
arbitrary URLs, or write/search an index. Cosine similarity is not a probability.

Checkpoint: `google/siglip2-base-patch16-224` at
`75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2`. This fixed-resolution checkpoint resolves
to **SiglipModel**, **SiglipImageProcessor**, **GemmaTokenizerFast**, assembled in
**SiglipProcessor**. Config/class mismatches fail; there is no alternate encoder.
The public checkpoint is Apache-2.0; preserve its model-card/license attribution.

## Input and output contract

`POST /embed`, JSON, internal service Bearer authentication. Exactly one:

```json
{"text": "a wooden chair"}
```

```json
{"imageBase64": "<base64 encoded JPEG or PNG bytes>"}
```

An injected storage adapter also supports `{"imageKey":"objects/id/frames/0.jpg"}`.
It is **disabled by default** (503). `ImageReader.read_authorized(key, principal,
max_bytes)` must authorize that principal/key before returning bytes and enforce
the limit while streaming. Thomas supplies real storage/scope integration;
`Principal` comes from the injected authenticator, never request-body user IDs.
The default service token represents a trusted internal caller, not an end user.
This is Ani's internal service boundary, not a change to the shared Worker API.

Optional `expectedFingerprint` rejects an incompatible model with HTTP 409.
Unknown fields, image+text, two image inputs and interactive batches are rejected.
Output fields are exactly:

```text
values: float32 values serialized as 768 JSON numbers
dimension: 768
fingerprint: 64-character lowercase SHA-256
inputHash: 64-character lowercase SHA-256
modality: image | text
```

Image hash covers original compressed bytes. Text hash covers UTF-8 after explicit
trim/lowercase. The fingerprint hashes canonical JSON of checkpoint/revisions,
resolved classes, processor/tokenizer asset digests, numerical runtime versions,
platform/Python, attention/thread settings and the preprocessing policy. It is
stable for an unchanged runtime/config; different platform/runtime fingerprints
must not be mixed in one index without explicit compatibility validation.

Images: still JPEG/PNG, <=10 MiB, <=16 million pixels, <=8192 per side. Decode,
EXIF transpose, composite alpha over white, RGB, full frame/no crop. The actual
checkpoint processor does 224x224 bilinear resize, 1/255 rescale and .5/.5 mean/std.
Square resizing may distort aspect ratios; this is the checkpoint baseline.

Text: <=4096 UTF-8 bytes, trim/lowercase, nonempty, no prompt decoration, no BOS,
EOS enabled, right padding to exactly 64 tokens, truncation. Pass padded input IDs
to `get_text_features` without attention_mask, matching the checkpoint reference.
Image features use `get_image_features`. Both run CPU float32, `.eval()`,
`torch.inference_mode()` and explicit L2 normalization; zero/nonfinite rows fail.
The local Python `embed_images`/`embed_texts` methods support batches 1..8, with
no averaging or cross-modality mixing. HTTP accepts one input only.

## Local setup and serving

Use **Python 3.11.9**, separate from global Python and the generation environment.
`requirements.txt` pins direct dependencies; `requirements-embedding-win-py311.txt`
locks the tested Windows runtime plus tests with hashes. The separate Linux CPU
lock is resolver-checked only until its Docker build is actually run. All wheels
come from PyPI or the official PyTorch CPU index. There is no CUDA/torchvision
dependency here. Do not install the generation stack in this environment.

From repo root, using the existing prepared Windows environment:

```powershell
$aniRoot = Join-Path $env:TEMP 'ani-siglip2-b03'
$aniPython = Join-Path $aniRoot 'venv\Scripts\python.exe'
$env:PYTHONPATH = (Resolve-Path services/gen).Path
$env:PYTHONDONTWRITEBYTECODE='1'
$env:EMBEDDING_CACHE_DIR = Join-Path $aniRoot 'models'
```

For a new environment, install the matching lock with `pip install --require-hashes
-r services/gen/requirements-embedding-win-py311.txt` using that environment's
interpreter. The tested bootstrap used uv 0.6.17 to install managed Python 3.11.9
and `uv pip sync --require-hashes --index-strategy unsafe-best-match` against the
hashed lock. The two explicitly trusted indexes are needed for `torch==2.6.0+cpu`.

Weight acquisition is a separate, explicit action (already performed for B03):

```powershell
& $aniPython -m app.embedding.download --allow-download --cache-dir $env:EMBEDDING_CACHE_DIR
```

Normal startup is **cache-only**; missing weights leave `/ready` at 503 while
`/health` stays live. Configure a distinct internal-service token securely via
`EMBEDDING_API_KEY`; never reuse a provider credential or write it to Git. Then:

```powershell
& $aniPython -m uvicorn app.main:app --host 127.0.0.1 --port 8002 --workers 1
```

Docker uses the Linux lock and port 8002, matching existing compose. Mount a
pre-downloaded model cache and inject the service token; no weights are bundled
into the image. One worker keeps one model resident. Concurrent feature work is
rejected with 429 rather than starting another model; there are no automatic
retries. HTTP 401 is bad auth, 413 oversized input, 415 wrong content type,
422 malformed input, 409 fingerprint mismatch, 503 unavailable model/adapter/auth,
and 500 invalid model output. Storage failures map to 403/404/502/504.

## Honest checks

Ordinary tests do not download/load weights. HTTP unit tests use an explicitly
fake encoder, and the preprocessing/tensor tests use synthetic inputs.

```powershell
$aniTests = Join-Path $aniRoot ('unit-' + [guid]::NewGuid().ToString('N'))
& $aniPython -m pytest services/gen/tests/test_embedding_preprocess.py services/gen/tests/test_embedding_contract.py -q -p no:cacheprovider --basetemp $aniTests
```

Explicit real checkpoint tests, using the existing official example, not a phone
photo or a labeled retrieval benchmark:

```powershell
$env:HF_HUB_OFFLINE='1'
$env:TRANSFORMERS_OFFLINE='1'
$env:ANI_EMBEDDING_REAL='1'
$env:EMBEDDING_TEST_IMAGE='C:\Users\hp\AppData\Local\Temp\ani-sf3d-b02-j14jau_3\chair1.png'
$env:EMBEDDING_TEST_REPORT=Join-Path $aniRoot ('real-' + [guid]::NewGuid().ToString('N') + '.json')
$aniTests = Join-Path $aniRoot ('real-tests-' + [guid]::NewGuid().ToString('N'))
& $aniPython -m pytest services/gen/tests/test_embedding_real.py -q -s -p no:cacheprovider --basetemp $aniTests
```

This loads the real checkpoint once and tests image/text shape, finiteness, norms,
repeat stability, differing inputs, actual token padding/EOS, and in-process
HTTP responses using that real encoder. Reports omit vectors/credentials and live
outside the repository. `/embed` HTTP timings use ASGI TestClient, not a network
deployment. First/repeat calls are small-sample observations, not p50/p95 latency
claims. Different outputs prove input dependence, not retrieval quality. See the
B03 evidence in the execution plan for measured results and remaining limits.
