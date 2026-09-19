# B06: generation -> B04 -> Thomas artifact result

Software integration is implemented. **No real SF3D generation is proven.**
Tests use a labelled fake provider and actual B04 serialization/reload validation.
Nothing deploys or makes paid calls on import. CPU dependencies stay separate from
`deploy/sf3d/requirements.txt`; install `requirements-adapters.txt` into B03's environment.

```python
from app.generation import GenerationInput, GenerationAttempt, VisualReview, deliver
from app.generation_io import WorkerArtifactSink

# selected_object is B, including B's box; authorized_image_bytes must also be B.
# For an owned object, pass its scan record directly; no search is required.
request = GenerationInput.from_object(selected_object, authorized_image_bytes,
    image_sha256=expected_image_hash, image_ref=actual_image_key, scope=authorized_scope)
attempt = GenerationAttempt(request, provider, reviewed_orientation_profile)
artifact = attempt.prepare()  # provider once, existing B04 once
# Inspect artifact.glb; do not invent SF3D orientation or approval.
review = VisualReview(artifact.receipt['boundSha256'], reviewer_id, 'manual_review')
result = artifact.worker_result(review)  # glbBase64 + artifact validation receipt
# OR use Thomas's existing upload grant, PUT, and asset GET (verified hash):
result = deliver(artifact, WorkerArtifactSink(trusted_worker_origin), review)
```

Provider injection is explicit. `SF3DProvider` implements the prepared B01 synchronous
Baseten transport and requires `allow_paid=True` plus a configured token/endpoint.
That flag is not budget authorization: the operator must first verify the permitted
credit budget. Default is disabled. No real orientation profile is shipped yet.

`prepare()` returns the same artifact on repeat calls to the same attempt. It never
automatically retries generation, including ambiguous request failures/timeouts.
Retry **deliver** with that artifact to retry storage. It mints a new single-use
upload grant, sends the same bytes and checks the fetched hash before returning
`glbKey`. Transport logging is suppressed for these calls, including signed URLs.
There are no scratch files: generation, binding and delivery use bounded bytes.

Receipts retain selected ID/source/scope, image reference/hash, raw/bound hashes,
generator revision/request ID, B04 validation/distortion report, separate provider
and binding timings, evidence label, and renderer scale 1. A matching human review
is required for real/cached real output; synthetic tests require `synthetic_test`.
No captions, palette, confidence or merchant facts are fabricated.

## Current backend compatibility and exact gaps

Inspected `origin/thomas/cloudflare-verify` at `5a3ce5f`:
`workers/src/workflows/generate-mesh.ts`, `workers/src/routes/index.ts`.
Current main still has stub backend routes. Do not enable `X-Stub` for live claims.

- Result: compatible with `BasetenResult.glbBase64` / `glbKey`. Extra `artifact`
  receipt is currently ignored by Thomas; he must preserve it and gate readiness
  on validated/reviewed results. His storage step accepts these exact GLB bytes.
- Input: `worker_request` maps current snake_case request names. Thomas must add
  real `source` from the hydrated selected Object, authorized scope/image hash and
  a durable attempt ID. The mapper takes the actual authorized image reference;
  it never trusts `upload_url` or silently fetches arbitrary `image_url` values.
- Workflow currently calls the raw B01 endpoint as though it returned a bound
  `BasetenResult`. Thomas must route to the Ani composition seam, with credentials
  for that service, not send his snake_case body to raw SF3D's `image_base64` API.
- His `baseten-generate` step retries three times. Disable blind resubmission after
  ambiguous inference outcomes; keep/reconcile a durable attempt and persist the
  completed artifact separately from delivery. This library's in-process guard is
  not a replacement for his durable workflow authority.
- Finalize currently emits a raw DB row. Thomas must emit Object v1 (schemaVersion,
  bboxMeters, state, glbUrl) for Justin's renderer. Renderer scale stays 1.

Full HTTP/job readiness is therefore **partial**, not a live end-to-end success.
No second backend, job store, queue, SSE or public API is implemented here.

## Test

From the repository, in B03's CPU environment plus `requirements-adapters.txt`:

```text
python -m pytest services/gen/tests/test_generation_adapter.py services/gen/tests/test_mesh_contract.py services/gen/tests/test_mesh_cache.py services/gen/tests/test_selection_binding.py -q -p no:cacheprovider --basetemp <new-scratch-directory>
```

These prove owned/selected paths, image/box isolation, real B04 invocation once,
serialized bounds, honest failures, timeout ambiguity, matching review, immutable
receipts, upload retry without regeneration, HTTP transport boundaries, and no
temporary file leaks. Mock HTTP tests prove protocol behavior, not Cloudflare access.
