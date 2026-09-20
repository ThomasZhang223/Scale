# Resident SF3D judging procedure

Use only Hack the North, **L4:4x16 (one NVIDIA L4)**. Never activate a second
deployment before the first is INACTIVE with zero replicas. The latency
experiment is separate from a deployed phone-to-XR integration. Its raw SF3D
endpoint must sit behind the configured B04 generation adapter; never put a raw
unscaled mesh into the Worker's ready state.

**Live deployment, 2026-09-20: model `3mzlyd6w` (`ani-sf3d-feasibility`),
deployment `qe95lkp`, team `HTN2026`, `L4:4x16`.** Use the deployment id, not
the mutable `/production` alias. `BASETEN_PREDICT_URL` in
`~/.config/full-scale/secrets.env` points at it.

The deployment this file described before — model `wdlgzjk3`, deployment
`w604592`, `full-scale-team26-latency-20260919`, team "26" — no longer exists
for our API key: `GET /v1/models/wdlgzjk3` answers 404 "No Oracle matches the
given query". It is not inactive, it is not in this workspace. The measured
results below were taken on it and still describe this model and this SKU.
[Measured results](SF3D_LATENCY_RESULTS.md) retain all four receipts.

**Keep texture resolution 1024.** There is no startup prewarm: merely reaching
ACTIVE does not remove the first-prediction penalty. Budget about **29 seconds
for the first request**, versus **1.2 seconds for a repeat on the same replica**,
plus B04 and the unmeasured capture/upload/storage/notification/render path.
Do not assume the repeat latency for the first judge request.

## Before judging

1. Activate the reviewed deployment **7–10 minutes before** the expected demo.
   Record its exact model/deployment IDs from the latency evidence, not a mutable
   production alias. Check the model belongs to team `HTN2026`.
2. Verify `instance_type_name` starts with `L4:4x16`, `max_replica=1`,
   `concurrency_target=1`, and never more than one active replica. For a resident
   judging window set min/max replicas to 1/1 in that deployment's autoscaling
   settings. This is an operator action for the judging window, not permission
   to leave compute running after the experiment.
3. Wait for `SF3D load complete` in deployment logs, including any verified
   startup cache initialization, and management status ACTIVE with one replica.
   Do not use a dummy prediction as a health check. Verify the CPU adapter's
   health/readiness and generation configuration separately.
4. Stop catalog submissions before activation. Check the Worker's D1 jobs and
   outbox plus dispatcher slot: no queued/running live or catalog generation.
   A catalog prediction already in flight cannot safely be preempted. Wait for
   its terminal result; do not blindly retry a timed-out request.
5. Verify uploads, Object v1, the measured proxy, room SSE, GLB fetching, and the
   B04 adapter separately. The mobile capture currently uploads frames before
   creating the object; its comment about subsecond readiness is not a measured
   capture-to-proxy guarantee. XR only loads `state:ready` with a valid GLB URL.

## During judging

Keep exactly one resident replica and one generation workflow at a time.
The local Worker change attempts dispatch after durable acceptance, gives live
jobs priority over queued catalog work, and publishes the stored validated mesh
before embedding/indexing. Cron and alarms remain crash recovery mechanisms.
Deploy/review these Worker commits separately before relying on that behavior.

Show the measured box while generation runs. Capture/upload, backend storage,
SSE, download and rendering add to the independently measured SF3D request.
Any full capture-to-mesh budget remains a projection until measured end to end.
On ambiguity inspect the existing job/provider result; never resubmit blindly.

## Explicit shutdown

Use an already configured credential in the environment; never paste it into
source, logs or command arguments. Set the exact reviewed IDs first.

```powershell
$sf3dModel = '3mzlyd6w'
$sf3dDeployment = 'qe95lkp'
$sf3dBase = "https://api.baseten.co/v1/models/$sf3dModel/deployments/$sf3dDeployment"
$sf3dHeaders = @{ Authorization = "Api-Key $env:BASETEN_API_KEY" }
# Pre-judging activation (after verifying team HTN2026 / exact SKU / max replica):
Invoke-RestMethod -Method Post -Uri "$sf3dBase/activate" -Headers $sf3dHeaders -ContentType 'application/json' -Body '{}'
# After judging, explicitly deactivate:
Invoke-RestMethod -Method Post -Uri "$sf3dBase/deactivate" -Headers $sf3dHeaders -ContentType 'application/json' -Body '{}'
do {
  Start-Sleep -Seconds 3
  $sf3dState = Invoke-RestMethod -Uri $sf3dBase -Headers $sf3dHeaders
  $sf3dState | Select-Object status, active_replica_count
} until ($sf3dState.status -eq 'INACTIVE' -and $sf3dState.active_replica_count -eq 0)
```

Keep the shutdown receipt and inspect usage afterward. Scale-to-zero is
insufficient: the observed idle delay is 900 seconds. Stop catalog intake too,
so a later request cannot accidentally restart a paid generation session.

## The generation adapter — decided, not an open question

The binding runs in a **separate CPU adapter service**, `app/generate_server.py`,
outside the Baseten deployment. Worker -> adapter `/generate` -> raw SF3D on
Baseten -> B04 dimension binding -> `BasetenResult` back to the Worker, which
stores the bytes. The Worker's `BASETEN_URL` names the ADAPTER, never Baseten.

Three reasons this is not a preference. The binding needs `trimesh` and NumPy and
nothing else; putting it in the Truss would pin a CPU library to a GPU image and
make every rebinding a GPU redeploy. `GenerateMeshWorkflow` rejects a raw response
outright (`kind: "raw_sf3d_unscaled"` or a bare `glb_base64` is a
`NonRetryableError`), so the adapter is what makes any mesh publishable at all.
And the scale binding must happen exactly once (standing rule 2); one service
owning it is how that stays true when the endpoint moves.

The Worker secret named `BASETEN_API_KEY` is the adapter's `GENERATION_API_KEY`.
It authenticates the Worker TO the adapter. The real Baseten credential never
leaves the laptop.

### The provider is OFF. Re-enabling it, exactly

Thomas turned it off at 07:25 UTC on 2026-09-20: `BASETEN_URL` is deleted from the Worker.
`MeshDispatcher.drain()` returns early without it, so queued jobs PARK and none fail.
`BASETEN_API_KEY` is still set, so re-enabling is one command.

```bash
# 1. Is the adapter still up, and is the tunnel URL still the one it was?
cat infra/.run/gen.url && curl -s "$(cat infra/.run/gen.url)/health"
#    Expect {"ok":true,"provider":true,"auth":true}. If cloudflared has restarted, the URL has
#    changed: re-run `bash infra/gen-up.sh` and use the URL it prints.

# 2. Warm the GPU with ONE real paid prediction. Never let the first real job pay for the
#    170 s cold wake — it is measured at 170.9 s against the adapter's 180 s provider timeout.
#    See step 2 of "Run it" below for the exact call.

# 3. Turn it on.
cd workers && npx wrangler secret put BASETEN_URL    # paste: <tunnel>/generate
curl -s https://full-scale-workers.thomaszhangdev.workers.dev/v1/health | jq .meshPipeline
#    -> providerConfigured: true

# Off again, the same clean stop:
cd workers && npx wrangler secret delete BASETEN_URL
```

A `wrangler secret put` or `delete` publishes a NEW VERSION built from the code that is
deployed at that moment. It does not roll code back — but it does mean the secret change and
whatever someone else deployed a minute earlier ship together. Check
`npx wrangler deployments list` first, and check afterwards that the behaviour you care about
still works, not just that the secret flipped.

**Two warnings that belong to the ON state, not to this file's history.**

With the provider ON, **every new catalogue row and every listing a person picks in the headset
is a paid SF3D call.** `POST /v1/catalog/ingest`, `POST /v1/listings/generate` and
`ScoutAgent`'s `find_products` tool all enqueue a mesh job; nothing rate-limits or budgets them.
On 2026-09-20 a teammate's run put 32 products through in 12 minutes without anyone deciding to.

**A caller that hits the adapter's `/generate` directly bypasses `MeshDispatcher`'s single
admission slot**, and therefore also the job row, the outbox row and the one-at-a-time
guarantee that keeps a single Baseten replica at `concurrency_target 1`. The adapter
authenticates with `GENERATION_API_KEY` and enforces nothing else. Anything that reaches it
without going through the Worker is invisible to `GET /v1/jobs/{id}` and to D1.

### Run it

```bash
# 1. Adapter + its own tunnel. NEVER a bare `bash infra/up.sh` during a demo: that
#    rotates all four live tunnel URLs and recreates ingest without its vendor keys.
#    gen-up.sh names only the `gen` service, and dies if a credential, the port or
#    the health check is missing.
bash infra/gen-up.sh
#    -> prints the trycloudflare URL, after checking /health says provider:true, auth:true

# 2. Wake the GPU, with ONE real paid prediction, before the Worker can send one.
#    Measured 2026-09-20: 170.9 s from SCALED_TO_ZERO, of which 141.99 s is the model
#    load; then 3.1 s for the whole adapter round trip on a warm replica. The adapter's
#    provider timeout is 180 s, so a cold wake only just fits — never let the first
#    real job be the one that pays for it. Do NOT use a dummy prediction as a health
#    check: send a real catalogue image and read the revisions the Truss reports back.
#    They must equal SOURCE_REVISION and MODEL_REVISION in deploy/sf3d/model/model.py,
#    or SF3DProvider raises provider_revision_mismatch and nothing may be bound.
curl -sS -H "Authorization: Bearer $BASETEN_API_KEY" -H 'content-type: application/json' \
  --max-time 900 -d "{\"image_base64\": \"$(base64 < some-catalogue-photo.jpg)\"}" \
  "$BASETEN_PREDICT_URL" | jq '.kind, .revisions, .settings.texture_resolution'

# 3. Point the Worker at the adapter. From workers/. Paste at the prompt; never
#    pass a credential as a command-line argument.
cd workers
npx wrangler secret put BASETEN_URL       # <tunnel>/generate
npx wrangler secret put BASETEN_API_KEY   # the GENERATION_API_KEY value, NOT a Baseten key
curl -s https://full-scale-workers.thomaszhangdev.workers.dev/v1/health | jq .meshPipeline
#    -> providerConfigured: true, and the dispatcher starts draining queued jobs

# 4. Stop the drain, if the first jobs fail. Either end removes the path:
npx wrangler secret delete BASETEN_URL        # Worker side
docker compose --profile gen stop gen         # adapter side
```

A quick-tunnel URL dies when `cloudflared` restarts. When that happens the Worker
keeps POSTing to a dead hostname and every job fails: re-run `infra/gen-up.sh` and
re-put `BASETEN_URL`. `infra/up.sh` refuses to start while the gen tunnel is alive;
`kill $(cat infra/.run/gen.pid)` first if you really need it.

### What the adapter declares on your behalf

It records one operator-declared `VisualReview` (`manual_review`) and one
operator-declared orientation, identity unless `GENERATION_ORIENTATION` is set, for
every artifact. GENERATION_HANDOFF.md requires a human to look at each real SF3D
mesh; this service completes without one. That is the demo operator's decision, not
Ani's, and the receipt names the reviewer so it is never mistaken for a human check.
A 90-degree yaw error passes the bounds check. Read the receipt's distortion label
(`eligible_for_visual_review` / `review_required` / `proxy_recommended`) and look at
anything above `eligible_for_visual_review` before it reaches a judge.

### Measured on a real product, 2026-09-20 — pick demo objects by footprint

First live catalogue binding: West 6 Drawer Dresser (`InStyle_Home__CA`,
`37ade021-af28-58c3-a81c-362644200dec`). The dimensions bind perfectly — reloaded
extents match D1's w/h/d to 1e-8 m, bottom-centre exact — and the mesh is still
labelled `proxy_recommended`, `distortion_ratio` **2.73**.

The reason is in the numbers and it is not a bug. SF3D's raw footprint is
0.919 x 0.752 m, near square, because it inferred depth from one front-on product
photo. The real dresser is 1.4986 wide by 0.4496 deep, aspect 3.33. Binding to the
true box therefore stretches X by 1.63 and squashes Z by 0.60, and that is visible.

It is NOT a yaw error. The test for one is cheap: recompute the distortion ratio
against the SWAPPED target `(d, h, w)` using `validation.source_oriented_extents`.
Here it is 4.07 against 2.73 as bound, so identity is the better fit and nothing is
facing sideways. Only when the swapped ratio is the clearly smaller one does the
mesh need a rotated orientation profile.

**Choose demo objects whose real footprint is roughly square** — chairs, stools,
lamps, side tables bind cleanly. Wide, shallow pieces — dressers, sideboards,
dining tables, sectionals — will bind to the right numbers and look stretched.
Every receipt carries `distortion_ratio`; sort by it before choosing a hero object.

Measured over the 46 meshes this adapter has produced so far
(`integration-sweep/reports/p-gen-distortion.json`, sorted ascending):
20 `eligible_for_visual_review`, 14 `review_required`, 12 `proxy_recommended`.
Worst is the Forge Large Wall Mount Barn Light at 4.04, best the Gia King Bed at
1.04. Roughly a quarter of the catalogue needs a look before it goes on stage.

**One mesh did fail the yaw test**, and it is the only one of the 46 that does:
Forge Large Wall Mount Barn Light, `distortion_ratio` 4.04 as bound against 2.42
if `w` and `d` were swapped. A wall-mounted lamp is measured 0.406 wide by 0.660
deep — deeper than it is wide, because the "depth" is its projection from the wall
— and SF3D produced it the other way round. Give that one a rotated orientation
profile through `GENERATION_ORIENTATION`, or keep it off the stage.

### Live generation fails on some products and cannot be made to succeed

**Three of the 19 products in the live drain never bound, in three attempts each.**
The adapter answers HTTP 422 `mesh_binding_rejected` and the job fails. The wire
code is deliberately sanitized, so the reason only reaches the adapter's log (see
`app/generation.py`); running `bind_glb` by hand on the raw mesh gives it in full:

| Product | Reason from the binder |
| --- | --- |
| Max Medium Wall Sconce | `Degenerate triangles` |
| Aledo Nightstand \| Walnut | `Degenerate normal-map UV triangle: cannot construct tangent basis` |
| Westcott Counter Stool | `Degenerate normal-map UV triangle: cannot construct tangent basis` |

The binder is right to refuse: a zero-area UV triangle has no tangent basis, and a
mesh without one cannot carry its normal map. **The failure is per-RUN, not per
product.** SF3D runs unseeded under `cuda-bfloat16-autocast`, so marching
tetrahedra produces a different mesh every time, and some of those meshes contain a
degenerate triangle. Two products whose CACHED meshes the binder rejected — Lunaria
Terra and Pino 6 Drawer Dresser — bound cleanly on a fresh run through this
pipeline. A fresh Westcott mesh bound cleanly by hand at distortion 1.245, then
failed twice more through the Worker.

So: **16 of 19 products bound on the first attempt; 3 failed 3 times each.** Risk is
concentrated in particular products — thin, slatted or openwork shapes — not spread
evenly across runs. Re-running one of those is a coin flip, not a fix.

Two rules follow, and they are why the demo does not depend on this path:

1. **Cap deliberate re-runs at two per object** (three paid attempts in total). Each
   one is an operator's decision, never an automatic retry: `retryable:false` in the
   adapter's response and `retries: 0` on the Worker's `baseten-generate` step both
   stay as they are. They exist to stop a blind resubmission of an AMBIGUOUS paid
   call, which is a different failure and must never be retried at all.
2. **Never let a judge watch a first-time generation of an unknown product.** One in
   six products cannot be generated on demand, and you find out 30 seconds in.

## Profiling diagnostics

Production bake resolution remains 1024 unless the evidence explicitly selects
512 for live use. The bounded B02 option is `--bake-resolution 512|1024`; it
requires `SF3D_PROFILE_ALLOW_BAKE_OVERRIDE=1` on the isolated profiling deployment.
The product request schema is unchanged. Geometry, conditioning size, BF16,
remeshing and pinned weights are unchanged.

Stage records use monotonic completed-work wall time at coarse CUDA boundaries.
`wall_ms` is inclusive; `exclusive_ms` subtracts child timers. Never sum parents
with children. Timers add some synchronization overhead, common to A/B/C/D;
there is no uninstrumented control in this four-request budget. Inline normal-map
assembly and native BVH internals are explicitly not independently separable
with these function hooks. Final framework JSON encoding and transport remain
outside `server_total_ms`; response preparation includes a JSON size-check pass.
