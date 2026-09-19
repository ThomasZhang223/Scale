# services/gen — Component C: image-to-3D, the scale binding, embeddings

Owner: **Ani**. See `.claude/workstreams/ani.md` for the full scope and hour-by-hour plan, and
`.claude/contracts.md` for the schemas this service reads and writes — that file wins on any
disagreement with this one.

B03 implements independent, real image **or** text embeddings through `/embed`.
See [embedding setup, API and tests](app/embedding/README.md). `/health` is process
liveness; `/ready` reports model readiness. Generation and binding remain stubs.
The generation sections below describe planned scope, not current functionality.

## The three objectives

In priority order when they conflict: **dimensional accuracy**, then **fidelity**, then
**latency**.

- **Accuracy** is the binding — AABB equals `bboxMeters` within 1 mm. Verified with a tape
  measure, never a viewer. See `BINDING.md`.
- **Fidelity** is whether the mesh reads as the real object at 1:1 in a headset. Levers: choosing
  the best clean frame from the scan, a clean matte before generation, and the UV unwrap and PBR
  parameters Stable Fast 3D already returns.
- **Latency** is wall clock from last frame to a loadable `glbUrl`, measured on the venue
  network at peak. Keep the endpoint warm. Pre-bake the catalog; exactly one live generation
  happens on stage.

A correct box beats a beautiful object at the wrong size. The whole pitch is that the size is
real.


## Scope

One HTTP service, run standalone in Docker, that turns an `Object v1` at `state:"measured"` into
`state:"ready"` with a real `glbUrl`, a caption, and a palette. It sits behind
`POST /objects/{id}/generate` and `GET /jobs/{id}` on Thomas's Workers layer, and does the actual
work as a background job.

### Two latency tiers, one `tier` parameter

- **`live`** — Stable Fast 3D. Receives one best clean image; sub-second on an A100, ~6 GB VRAM,
  Stability AI Community License, gives UV unwrap and PBR parameters. Used for the single
  on-stage generation during the demo.
- **`quality`** — TRELLIS 2 or Hunyuan3D Pro. Slower, better mesh quality. Used for the offline
  pre-baked catalog (60–100 products) and async upgrades.

Both tiers sit behind one endpoint parameter: `tier: "live" | "quality"`.

### Two input paths, one convergence type

Both paths produce the same `Object v1` (see `.claude/contracts.md`):

1. **Phone scan** — frames (`objects/{objectId}/frames/{n}.jpg` in R2) plus a LiDAR-measured box.
   `measure.method` is `"lidar"`, confidence is real.
2. **Catalog product** — a product image plus dimensions Paul's scraper extracted or declared,
   which may be low confidence. These dimensions are **extracted or declared, not measured** —
   `measure.method` must be `"extracted"` or `"declared"`, and `measure.confidence` must be
   correspondingly lower. Never claim LiDAR-grade confidence for a number nobody measured with a
   sensor.

Both paths hit the same generator and the same binding step (see `BINDING.md`).

### Known failure set — test this before the event

Single-image generation degrades badly on **transparent, reflective, thin, and very dark**
objects. A MacBook is a good demo object: matte, rectangular, solid. A water bottle is the
adversarial case. Test twenty random objects on Friday so the failure boundary is known in
advance, not discovered on stage.

A phone sweep gives multiple candidate frames. Use all useful frames for SigLIP2 retrieval, but
select one best clean frame for Stable Fast 3D; do not send it a multi-view set.

If a generation is likely to be bad (object in the known failure set, low frame count), say so in
the response rather than silently returning a bad mesh.

## Run

Standalone service, own Docker container, registered in the root `docker-compose.yml` (Thomas
owns that file — ask him for the entry, do not add it yourself).

```
docker build -t services-gen services/gen
docker run --rm -p 8002:8002 services-gen
```

The embedding service requires an approved local model cache and internal-service
token; see its linked README for mount/environment setup. Docker build/run has
not been validated by the local Windows checks. The remaining generation-stage
endpoints return HTTP 501 — see `app/main.py`.

## Layout

```
services/gen/
  README.md         this file
  BINDING.md         the scale binding — read this, it's the technical thesis
  Dockerfile
  requirements.txt
  app/
    main.py          FastAPI app; real /embed, remaining job-worker stages 501
    bgremove/         background removal, before generation
    baseten/          Baseten client, both tiers behind `tier`
    binding/          the scale binding — sole owner, see BINDING.md
    embedding/        independent SigLIP image/text embeddings (no captions/index writes)
```
