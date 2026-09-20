# Resident SF3D judging procedure

Use only Hack the North / Team 26, **L4:4x16 (one NVIDIA L4)**. Never
activate a second deployment before the first is INACTIVE with zero replicas.
The latency experiment is separate from a deployed phone-to-XR integration.
Its raw SF3D endpoint must sit behind the configured B04 generation adapter;
never put a raw unscaled mesh into the Worker's ready state.

Reviewed deployment: model `wdlgzjk3`, deployment `w604592`, named
`full-scale-team26-latency-20260919`. The experiment ended INACTIVE with zero
replicas. [Measured results](SF3D_LATENCY_RESULTS.md) retain all four receipts.
**Keep texture resolution 1024.** There is no startup prewarm: merely reaching
ACTIVE does not remove the first-prediction penalty. Budget about **29 seconds
for the first request**, versus **1.2 seconds for a repeat on the same replica**,
plus B04 and the unmeasured capture/upload/storage/notification/render path.
Do not assume the repeat latency for the first judge request.

## Before judging

1. Activate the reviewed deployment **7–10 minutes before** the expected demo.
   Record its exact model/deployment IDs from the latency evidence, not a mutable
   production alias. Check the model belongs to Team 26.
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
$sf3dModel = 'wdlgzjk3'
$sf3dDeployment = 'w604592'
$sf3dBase = "https://api.baseten.co/v1/models/$sf3dModel/deployments/$sf3dDeployment"
$sf3dHeaders = @{ Authorization = "Api-Key $env:BASETEN_API_KEY" }
# Pre-judging activation (after verifying Team 26 / exact SKU / max replica):
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
