# services/gen — Component C: image-to-3D, the scale binding, embeddings

Owner: **Ani**. See `.claude/workstreams/ani.md` for the full scope and hour-by-hour plan, and
`.claude/contracts.md` for the schemas this service reads and writes — that file wins on any
disagreement with this one.

This is a skeleton only. No generation, binding, or embedding logic is implemented yet.

## The three objectives

In priority order when they conflict: **dimensional accuracy**, then **fidelity**, then
**latency**.

- **Accuracy** is the binding — AABB equals `bboxMeters` within 1 mm. Verified with a tape
  measure, never a viewer. See `BINDING.md`.
- **Fidelity** is whether the mesh reads as the real object at 1:1 in a headset. Levers:
  multi-view input over single-image, a clean matte before generation, and the UV unwrap and
  PBR parameters Stable Fast 3D already returns.
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

- **`live`** — Stable Fast 3D. Sub-second on an A100, ~6 GB VRAM, MIT licence, gives UV unwrap and
  PBR parameters. Used for the single on-stage generation during the demo.
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

Multi-view input beats single-image — a phone sweep gives four good frames for free, so use them
when available instead of forcing single-image generation.

If a generation is likely to be bad (object in the known failure set, low frame count), say so in
the response rather than silently returning a bad mesh.

## Run

Standalone service, own Docker container, registered in the root `docker-compose.yml` (Thomas
owns that file — ask him for the entry, do not add it yourself).

```
docker build -t services-gen services/gen
docker run --rm -p 8000:8000 services-gen
```

Every endpoint is unimplemented right now and returns HTTP 501 naming the job it belongs to — see
`app/main.py`.

## Layout

```
services/gen/
  README.md         this file
  BINDING.md         the scale binding — read this, it's the technical thesis
  Dockerfile
  requirements.txt
  app/
    main.py          FastAPI app, job-worker entry points, all 501 for now
    bgremove/         background removal, before generation
    baseten/          Baseten client, both tiers behind `tier`
    binding/          the scale binding — sole owner, see BINDING.md
    embedding/        CLIP ViT-L/14 embeddings, caption, palette
```
