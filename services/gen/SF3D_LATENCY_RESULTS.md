# Controlled SF3D latency experiment — 2026-09-19

**Keep 1024. Repeated warm generation is 1.193 seconds client-side.**
The previous 59.531-second evidence was the first prediction on its replica.
This experiment establishes the warm/first distinction; it does not establish
that these code changes accelerated steady-state model computation. Model,
weights, input network/geometry resolution, BF16 and remeshing are unchanged.

[Full machine-readable evidence](evidence/sf3d-latency-2026-09-19.json) contains
every stage timer, startup timings, artifact hashes, provenance and B04 report.
[Baseline evidence](evidence/real-sf3d-binding-2026-09-19.json) is preserved.

## Before and after

Baseline: 275–286 seconds cold activation, then 59.530558 seconds for its first
prediction; 58.200017 seconds inside SF3D, 0.0602 decode, 0.00957 preprocessing,
0.0685 export, about 1.19 transport/framework/client. B04 was 0.20–0.28 seconds.
Current-main inspection confirmed up to 60 seconds intentional cron waiting,
30-second completion polling, and indexing before mesh publication.

All four new predictions used the same verified official chair input and the
same replica, with ordinals 1–4. No intervening deployment or dummy prediction.

| Request | Client s | Server s | SF3D s | Saved vs 59.531 s | Raw GLB bytes | Vertices / faces | B04 s |
|---|---:|---:|---:|---:|---:|---:|---:|
| A: first 1024 | 28.709949 | 27.675454 | 27.543737 | 30.820609 (51.77%) | 797632 | 12178 / 19996 | 0.222841 |
| B: repeat 1024 | 1.192554 | 0.734341 | 0.667522 | 58.338004 (98.00%) | 797660 | 12183 / 19996 | 0.184266 |
| C: 512, ordinal 3 | 1.545105 | 0.609840 | 0.571754 | 57.985453 (97.40%) | 695144 | 12166 / 19996 | 0.152147 |
| D: repeat 512 | 1.282272 | 0.667938 | 0.620640 | 58.248286 (97.85%) | 696608 | 12181 / 19996 | 0.210278 |

Those are observed differences, not causal speedups over a paired old-code
control. B is the fastest measured **total request**; C has the shortest server
time. A-to-B saves 27.517396 seconds (95.85%). The changed UV seam vertex counts
do not indicate changed geometry: all four expanded triangle-position arrays
are exactly equal. Peak CUDA allocation: A 6,470,981,632 bytes; B/C/D
6,424,048,128 bytes. Input is decoded RGBA; background removal did not run.
Every GLB contains geometry, one PBR material, base color and normal textures.

Fresh-deployment submission/preflight-to-ACTIVE took **428.1 seconds**, including
the build. First observed DEPLOYING-to-ACTIVE was about **207.1 seconds** (polling
uncertainty roughly 12 seconds). This is not the same measurement as reactivating
the old deployment; no cold-activation percentage improvement is claimed.
Framework `Model.load()` took **171.906 seconds** versus the prior 172.4/223.7
observations: 0.494/51.794 seconds less (0.29%/23.15%), with no controlled causal
startup optimization. The wrapper's inner load timer was 169.673 seconds.

| Startup stage | Seconds |
|---|---:|
| Checkpoint lookup/download | 54.641 |
| Model construction, including secondary checkpoint loading | 10.650 |
| Primary checkpoint deserialization | 19.161 |
| Move to CUDA / initialization boundary | 0.739 |
| rembg/U2NET session | 3.204 |
| Remaining imports, config, validation and runtime setup | 81.278 |

## Decisions

**No startup prewarm and no second deployment.** Lazy `all_edges` costs only
0.982 seconds, below the required five-second saving. The first-pass overhead
spans DINO (~9.873 s extra), UV unwrap (~4.649 s), material estimation (~3.164 s),
geometry, conditioning and texture padding. A coarse DINO timer does not identify
a deterministic initialization that can safely move to load without inference.
No dummy image or guessed CUDA warmup was added.

**512 does not become the live default.** D versus B is 0.089718 seconds **slower**
client-side (-7.52% saved); server time improves by only 0.066403 seconds (9.04%),
and the SF3D block by 0.046881 seconds (7.02%). Raw GLB size decreases by 101052
bytes (12.67%). Texture/material evaluation saves 0.005285 s (77.30%), padding
0.040622 s (91.90%), and texture quantization 0.021855 s (62.99%). These small
stages cannot deliver a meaningful total-request saving here. One pair is too
small to infer significance for millisecond changes.
The measured rasterization/interpolation/material/padding/quantization/transfer/
tangent subtotal drops from 0.098851 to 0.031352 seconds: 0.067499 s (68.28%).
It excludes combined geometry/texture sampling and unseparated inline work.

Matching-camera CPU previews show the same silhouette and base colors. At 512,
upholstery buttons/seams and wood edges are visibly softer/blockier. Normal maps
are present and shaded without obvious new gross corruption; fine detail is
reduced. Both resolutions inherit the original reconstruction's uneven feet.
1024 remains preferable for judges; offline/quality generation retains 1024 too.

All four pass actual local B04. Max bbox error is 2.63e-8 m and bottom-centre
error is zero. Materials and UV corners are preserved. This uses the baseline's
software test dimensions, not independently measured chair dimensions. B04
timing is separate CPU work; B's 0.184 s is 0.016–0.096 s below the old
0.20–0.28 s range (7.87–34.19%), with no B04 optimization or causal claim.

Artifacts and previews are outside Git at
`C:\Users\hp\AppData\Local\Temp\sf3d-latency-20260919`.
Open `comparison.html` for B versus D front, quarter and detail views.
Each A/B/C/D directory contains raw mesh, bound mesh, three previews and receipts.

## Orchestration and user-visible budgets

The local Worker changes remove the intentional minute-cron wait: durable
acceptance precedes immediate dispatcher notification. A deterministic fake
clock observes **0 ms intentional acceptance-to-notification delay**, removing
the previous 0–60 s scheduling window (100% of that intentional wait).
No deployed network latency is claimed. D1 outbox, cron, stable workflow IDs,
duplicate suppression, one admission slot and no ambiguous-inference retry remain.

Completion triggers immediate reconciliation, with 250 ms polling during a
five-second finishing window; terminal status is required before slot release.
That reduces a nominal 30 s completion check interval by 29.75 s (99.17%) on the
normal callback path. The 30 s alarm remains a recovery backstop, so this is not
a platform SLA. Waiting live work takes priority over queued catalog work.

Stored, validated meshes become ready and emit their room event **before**
indexing. Tests hold indexing unresolved and prove readiness is already visible;
missing stored GLBs cannot publish ready. Indexing delay removed is not measured
in seconds. These Worker commits are local and **not deployed** by this task.

Projected capture-submitted-to-final-mesh budget with no queue:

- Replica already ACTIVE, first prediction: **28.93 s** (A + local B04), plus
  unmeasured capture upload, adapter/storage/SSE, GLB download and client render.
- Same replica after a real prediction: **1.38 s** (B + local B04), plus those
  same unmeasured stages. This is a sum of measured components, not an
  end-to-end guarantee or p95.
- Capture-to-immediate-proxy: the measured box is shown locally when LiDAR
  measurement finishes; time from capture is **unmeasured**. The phone then
  uploads frames before object creation. A subsecond backend comment is not
  latency evidence. Capture-to-final-mesh has the projected budgets above plus
  the unmeasured measurement duration.

Activate 7–10 minutes before judging; verify exactly one L4, completed load,
ACTIVE, adapter readiness, empty queues and live SSE. Keep one resident replica.
Activation alone does not make the first prediction a warm repeat. Follow
[the exact activation/shutdown procedure](SF3D_JUDGING.md), explicitly deactivating
afterward and polling INACTIVE plus zero replicas; idle scale-down is 900 s.

## Cloud and checks

Hack the North / Team 26; model `wdlgzjk3`, deployment `w604592`; exact
`L4:4x16`, one NVIDIA L4, max replicas 1. **Four predictions, one deployment,
no second experiment.** Same replica identity recorded on all four responses.
The management API confirmed **INACTIVE / active_replica_count=0** twice.
The experiment process finished in 473.134 seconds including build/preflight.

Actual account charge was not returned; billing schema introspection was denied.
The [published L4 rate](https://www.baseten.co/pricing/) and API agree on
**$0.01414/minute ($0.8484/hour)**. Applying that rate to the entire 7.89-minute
session, including build, estimates **$0.112**; this is not a billing receipt.
Even the full authorized 20-minute ceiling is $0.283 at that rate. No payment
method, purchase, extra replica or other GPU was used.

Local checks: **229 generation/B04 tests passed, 3 opt-in tests skipped;
24 Worker tests passed; TypeScript passed; explicit-file secret/artifact scans
passed.** One outdated text mock was corrected to supply its actual text hash
after main's newer embedding identity validation; production validation was kept.

## Full stage table

Inclusive monotonic completed-work seconds at coarse CUDA boundaries. Parent
totals overlap their child rows; **do not sum this table**. Exclusive times and
call counts are in JSON. `all_edges` construction is zero when its cached value
is used. Inline normal-map tensor assembly and native BVH suboperations are not
independently separated by these minimal hooks. Response preparation includes
base64/validation and a JSON size-check; final framework serialization is outside
the server timer. Instrumentation overhead was not independently benchmarked.

| Stage (inclusive seconds) | A first 1024 | B repeat 1024 | C first 512 | D repeat 512 | B minus D (s) | B to D saved |
|---|---:|---:|---:|---:|---:|---:|
| all_edges_cache_hit | 0.000000 | 0.000015 | 0.000011 | 0.000015 | 0.000000 | 0.14% |
| background_alpha_decision | 0.000916 | 0.000847 | 0.000881 | 0.001269 | -0.000422 | -49.86% |
| conditioning_prepare | 0.468317 | 0.008302 | 0.007716 | 0.011004 | -0.002702 | -32.55% |
| conditioning_resize | 0.586841 | 0.000224 | 0.000214 | 0.000218 | 0.000005 | 2.37% |
| cpu_atlas_overlap | 0.138325 | 0.149931 | 0.142079 | 0.168951 | -0.019019 | -12.69% |
| dino_features | 9.912996 | 0.040266 | 0.040085 | 0.040500 | -0.000234 | -0.58% |
| field_sampling | 0.801733 | 0.004208 | 0.003767 | 0.003919 | 0.000289 | 6.86% |
| foreground_crop_pad | 0.006954 | 0.000753 | 0.000731 | 0.001099 | -0.000346 | -46.03% |
| geometry_field | 0.625381 | 0.015394 | 0.015152 | 0.015422 | -0.000028 | -0.18% |
| geometry_total | 3.786293 | 0.022748 | 0.021489 | 0.023022 | -0.000274 | -1.21% |
| glb_export | 0.075501 | 0.055234 | 0.026047 | 0.029978 | 0.025256 | 45.73% |
| gpu_cpu_transfer | 0.002621 | 0.002568 | 0.001052 | 0.001092 | 0.001476 | 57.47% |
| lazy_all_edges | 0.981805 | 0.000000 | 0.000000 | 0.000000 | 0.000000 | n/a |
| marching_tetrahedra_total | 2.359927 | 0.003976 | 0.003201 | 0.004185 | -0.000209 | -5.25% |
| material_estimator | 3.177273 | 0.013552 | 0.008781 | 0.014279 | -0.000727 | -5.36% |
| normal_map_tangents | 0.000939 | 0.000513 | 0.000653 | 0.000746 | -0.000233 | -45.39% |
| pbr_construction | 0.000018 | 0.000017 | 0.000019 | 0.000020 | -0.000003 | -17.33% |
| scene_codes_total | 13.239236 | 0.304353 | 0.304148 | 0.304783 | -0.000429 | -0.14% |
| texture_interpolation | 0.000459 | 0.000360 | 0.000193 | 0.000233 | 0.000126 | 35.14% |
| texture_material_field | 0.065348 | 0.006837 | 0.001501 | 0.001552 | 0.005285 | 77.30% |
| texture_padding | 1.127008 | 0.044200 | 0.004814 | 0.003578 | 0.040622 | 91.90% |
| texture_quantization | 0.039354 | 0.034695 | 0.009626 | 0.012841 | 0.021855 | 62.99% |
| texture_rasterizer_bvh | 0.019741 | 0.009677 | 0.010980 | 0.011309 | -0.001631 | -16.86% |
| transformer | 0.616612 | 0.224547 | 0.224507 | 0.224758 | -0.000211 | -0.09% |
| trimesh_construction | 0.026345 | 0.015563 | 0.020141 | 0.021470 | -0.005907 | -37.96% |
| triplane_postprocess | 1.273554 | 0.037759 | 0.037915 | 0.037687 | 0.000072 | 0.19% |
| uv_unwrap_total | 4.827436 | 0.178544 | 0.167273 | 0.197369 | -0.018825 | -10.54% |
| vertex_normals | 0.503520 | 0.001012 | 0.000953 | 0.001200 | -0.000187 | -18.52% |
