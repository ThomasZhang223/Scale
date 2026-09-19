# B01: SF3D feasibility package

Owner: Ani. **Candidate packaging only. Actual image build, model load and real
generation have NOT been tested.** No deployment is created by importing these
files, running the packaging tests, or asking the runner for `--help`.

This isolated Truss generates **one raw, unscaled textured GLB** from one image.
It is not Object v1-ready: no metre binding, semantic orientation guarantee, R2,
jobs, callbacks, embeddings, retrieval or alternative model. Production artifact
transport/binding is implemented in [B06](../../GENERATION_HANDOFF.md), with
fake-provider evidence until B02 succeeds. Do not call this wrapper with `/async_predict`: its inline
base64 transfer is designed only for this synchronous B02 spike.

## Prepared files and limits

- `config.yaml`: pinned Linux CUDA devel image, one L4, one prediction at a time,
  native extension build, null HF secret declaration; no weight download in build.
- `requirements.txt`: candidate direct runtime pins; NOT a solved transitive lock.
- `model/model.py`: once-per-replica `load`, cached SF3D and rembg session,
  per-request preprocessing/inference/export, explicit raw artifact provenance.
- `model/transport.py`: JPEG/PNG + EXIF/RGBA decode and bounded artifact encoding.
- `b02_smoke.py`: one opt-in synchronous POST, no retries or redirects, retrieves
  real bytes into a **new** local directory as `mesh.glb` and `report.json`.
- `schema/`: exact Truss 0.18.30 release JSON schema and server constraints plus
  upstream MIT license. Local tests check used fields/types and candidate
  invariants; they do not run all Truss Python validators or prove a build.

Input is exactly `{"image_base64":"<one JPEG or PNG>"}`; URLs, batches, dimensions
and user-supplied generation settings are rejected. Maximum compressed image:
10 MiB, decoded pixels: 16 million, side: 8192. Prefer a <=2 MiB phone export for
the first request. RGBA alpha is retained; upstream background removal reuses
the session, and an empty/degenerate matte fails. Foreground ratio .85, texture
1024, remesh none, vertex count -1, CUDA bfloat16 autocast as in upstream.

Response: JSON with `kind: raw_sf3d_unscaled`, `glb_base64`, byte count, SHA-256,
input SHA-256, revisions, settings, structural counts and timing/runtime facts.
Limit is 16 MiB GLB / 24 MiB response. Platform/proxy body-size acceptance remains
a B02 test. No truncation: oversize fails explicitly. Runner verifies length,
hash, header/chunks, embedded textures, matching input and SF3D revisions before
saving bytes. This is **structural validation**, not geometry/quality or mesh
normalization validation. Open the saved artifact to inspect textures/silhouette.

The runner does not automatically retry after timeout: the model may still be
running and charging. Inspect dashboard request/log state before deciding on
another separately authorized request. Timeout is 180 s by default (max 300),
with HTTP I/O timeout and elapsed checks between chunks, not GPU cancellation.
It leaves its newly created output directory on failure but never writes a
success report or mesh for an invalid response. Never point it at a directory
containing earlier work. No server-side per-request files are needed.

## Compatibility decisions and remaining uncertainty

1. **Python 3.11 replaces the plan's candidate 3.10 here only.** Official PyTorch
   v2.4.0 Dockerfile defaults to 3.11. Selected image:
   `pytorch/pytorch:2.4.0-cuda12.1-cudnn9-devel`, Linux amd64 manifest digest
   `sha256:a55ff10111eb11f998884327d37361592e632899edd24fce99886b69289e33e6`.
   Registry metadata was read; image layers were not pulled. Build asserts Python,
   torch and CUDA versions. The base Python patch version remains B02 evidence.
2. **Truss CLI 0.18.30 belongs in a separate environment**, not `requirements.txt`.
   Its package requires `huggingface-hub>=0.25.0`; SF3D pins 0.23.4. The inspected
   Truss server constraints allow NumPy 1.26.4 and don't impose that CLI hub pin.
   Full transitive resolver/native build compatibility is still untested.
3. Upstream SF3D source `ff21fc491b4dc5314bf6734c7c0dabd86b5f5bb2` is cloned at
   image build. `USE_CUDA=1`, `CUDA_HOME`, and `TORCH_CUDA_ARCH_LIST=8.9` avoid
   GPU-less builders quietly selecting CPU-only baking. L4 is sm_89; do not
   change GPU without reviewing this. `USE_NATIVE_ARCH=0` avoids build-host ISA
   assumptions. Because upstream conditional flags can clear OpenMP flags when
   native-arch is disabled, CFLAGS/CXXFLAGS/LDFLAGS explicitly retain `-fopenmp`.
   Actual GPU extension dispatch and load/predict thread behavior are B02 gates.
4. Keep upstream `rembg[gpu]` dependency, pin ONNX Runtime GPU **1.19.2** (official
   1.19.x PyPI build: CUDA 12/cuDNN 9), but explicitly select **CPUExecutionProvider** for the
   first matte session. This removes provider fallback ambiguity and preserves
   GPU capacity for SF3D; it is a baseline decision, not a latency optimization.
   Record its measured cost before changing it. Both native libraries still build.
   The initial 1.18.1 candidate was rejected during B01 review: the official table
   also lists 1.18.x PyPI builds as CUDA 11.8/cuDNN 8, so a plain PyPI pin did not
   establish the intended CUDA-12 variant. No such package was installed.
5. Weight selection happens only in `load`, not in `predict`:

   | Input | Pinned identity |
   | --- | --- |
   | SF3D | `stabilityai/stable-fast-3d@f0c9a8ffd62cb1bbc8a7a53c9f87a0be1b6be778`, config + safetensors |
   | DINOv2 | `facebook/dinov2-large@47b73eefe95e8d44ec3623f8890bd894b6ea2d6c`, config + safetensors |
   | OpenCLIP | `laion/CLIP-ViT-B-32-laion2B-s34B-b79K@1a25a446712ba5ee05982a381eed697ef9b435cf`, `open_clip_pytorch_model.bin` (loader in open_clip 2.24) |
   | U2NET | rembg 2.0.57 official release URL/checksum, MD5 `60024c5c889badc19c04ad937298a77b`; runtime records SHA-256 |

   These secondary models are SF3D internals, not additional product encoders.
   SF3D's public source calls DINOv2 `from_pretrained` and OpenCLIP's pretrained
   alias during construction. Wrapper substitutes pinned local paths in config,
   then uses the exact upstream `SF3D(cfg); load_model(...)` sequence. It checks
   class/architecture assumptions and fails rather than downloading another
   alias. The gated SF3D config was **not read** in B01; first authorized load
   must establish those assumptions, conditioning resolution, and checkpoints'
   joint compatibility. U2NET's upstream MD5 is integrity metadata, not a modern
   authenticity proof; record/review the resulting SHA-256 in B02. HF token is a
   Baseten runtime secret; no token or signed URL belongs in logs/source.
6. Pinning OpenCV 4.10 avoids recent OpenCV's NumPy-2 requirement conflicting
   with upstream 1.26.4. Full transitive versions/`pip freeze`, `pip check`,
   library load and actual GLB quality remain B02 evidence. The `.bin` OpenCLIP
   checkpoint is trusted only at the explicit official repository revision;
   never accept arbitrary checkpoint URLs from requests.

## Local B01 checks (no network, weights or GPU)

From repository root, using already installed pytest, Pillow, httpx, PyYAML and
packaging:

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
python -m pytest services/gen/tests/test_sf3d_config.py -q -p no:cacheprovider
python services/gen/deploy/sf3d/b02_smoke.py --help
```

Tests use a synthetic textured triangle, in-memory images, a fake inference
runtime and httpx MockTransport. They exercise useful boundaries and **do not
prove** checkpoint loading, native compilation, real networking or generation.

## Manual prerequisites before B02

- Ani reviews applicable SF3D license/attribution requirements and personally
  obtains HF access. Check read access to the pinned revision, not just HF login.
  Review secondary checkpoint licenses too. No one accepted terms in B01.
- Workspace owner/booth confirms **custom Truss inference** enabled, available
  L4/4 CPU/16 GiB capacity and region, actual rate, whether event credits apply,
  maximum spend, allowed build/download/request time and shutdown owner/time.
  Training H100 access or a hosted LLM API key alone is insufficient.
- Explicit authorization covers CLI environment setup, image/native build,
  downloading all model weights (potentially several GB), deployment and the
  single request. Nothing in this README automatically authorizes those actions.
- Configure the Baseten runtime secret named `hf_access_token`; keep
  `BASETEN_API_KEY` in the calling process's environment/credential store. Set
  `SF3D_PREDICT_URL` to the dashboard's **deployment-specific synchronous
  /predict URL**. Use a dedicated feasibility model, never an existing teammate
  production model. Choose a consented image and a new output directory.
- Preserve SF3D LICENSE/NOTICE from the cloned source and provide required
  “Powered by Stability AI” attribution for sharing the model/service. Coordinate
  any product UI attribution with Thomas rather than editing his files.

## Exact B02 setup and first request (NOT run in B01)

After the above authorization, in a separate deploy-CLI environment (not the
SF3D runtime), install **truss==0.18.30**. Example for an approved Linux machine:

```sh
python3.11 -m venv /tmp/ani-sf3d-deploy-cli
/tmp/ani-sf3d-deploy-cli/bin/python -m pip install truss==0.18.30
/tmp/ani-sf3d-deploy-cli/bin/python -c "from pathlib import Path; from truss.base.truss_config import TrussConfig; TrussConfig.from_yaml(Path('services/gen/deploy/sf3d/config.yaml')); print('Truss config parsed; no build performed')"
/tmp/ani-sf3d-deploy-cli/bin/truss login
```

Set secrets in the authorized workspace, then approve this concrete deployment:

```sh
/tmp/ani-sf3d-deploy-cli/bin/truss push services/gen/deploy/sf3d --wait --deploy-timeout-minutes 30
```

Truss 0.18.30 publishes by default; no `--watch` warm loop, no `--promote`, and
no production environment switch is requested here. Build/import/load failure
means stop and inspect redacted logs; B02 permits one focused rebuild in its
90-minute time box. Do not bypass dependency failures with `--no-deps` for runtime
requirements. The native-extension-only `--no-deps` in build is intentional.

Once the deployment is Ready, **one request** from the Windows checkout:

```powershell
python services/gen/deploy/sf3d/b02_smoke.py --allow-paid-request --endpoint $env:SF3D_PREDICT_URL --image 'C:\path\consented-object.png' --output-dir "$env:TEMP\ani-sf3d-b02-001" --timeout 180
```

The environment variable supplies the real endpoint without hard-coding account
IDs here. The image path is the one required local substitution. Runner has no
deployment or account-write API. It prints only the receipt, not base64 or tokens.
Confirm `mesh.glb` opens locally with textures; record actual load/build logs,
request/deployment IDs, runtime/versions, artifact SHA-256 and visual verdict in
the plan. This first cold request is not a latency benchmark. A repeat warm
request requires remaining approved budget and a fresh `...-002` output path.
Stop/deactivate with the approved owner/action and inspect billing/queues.

## Sources checked for B01 (2026-09-19)

- [Truss 0.18.30 release metadata](https://pypi.org/pypi/truss/0.18.30/json).
  Inspected wheel SHA-256: `aa920f41d56af9d799d6d180485e61b9bbcbea9ed930bedde249e93a9628d99e`.
  Vendored schema/constraints/license extracted from this wheel without installation.
- [Baseten Model class](https://docs.baseten.co/development/model/model-class),
  [configuration](https://docs.baseten.co/reference/truss-configuration),
  [dependencies](https://docs.baseten.co/development/model/dependencies),
  [synchronous call](https://docs.baseten.co/inference/calling-your-model).
  JSON-serializable return values and Bearer authorization documented; platform
  payload limits and exact workspace behavior still require live verification.
- [Official PyTorch Dockerfile v2.4.0](https://github.com/pytorch/pytorch/blob/v2.4.0/Dockerfile),
  [image manifest metadata](https://registry-1.docker.io/v2/pytorch/pytorch/manifests/2.4.0-cuda12.1-cudnn9-devel).
- [ONNX Runtime CUDA/cuDNN compatibility](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements).
- [Pinned SF3D source](https://github.com/Stability-AI/stable-fast-3d/tree/ff21fc491b4dc5314bf6734c7c0dabd86b5f5bb2),
  specifically requirements, system, image tokenizer, CLIP estimator, utils,
  texture_baker/uv_unwrapper setup. Gated config/weights remain untested.
- [rembg 2.0.57 U2NET](https://github.com/danielgatis/rembg/blob/v2.0.57/rembg/sessions/u2net.py),
  [session factory](https://github.com/danielgatis/rembg/blob/v2.0.57/rembg/session_factory.py).
- [DINOv2 revision metadata](https://huggingface.co/api/models/facebook/dinov2-large),
  [OpenCLIP revision metadata](https://huggingface.co/api/models/laion/CLIP-ViT-B-32-laion2B-s34B-b79K),
  [OpenCLIP 2.24 loader](https://github.com/mlfoundations/open_clip/blob/v2.24.0/src/open_clip/factory.py).

Missing access blocks **live B02**, not this package. If live feasibility fails,
record failure and retain the plan's honestly labeled proxy fallback; do not
implement that fallback, B02, or any later step as part of B01.
