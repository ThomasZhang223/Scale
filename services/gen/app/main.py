"""services/gen — Component C skeleton.

Owner: Ani. Scaffold only — no generation, binding, or embedding logic implemented.
See ../README.md and ../BINDING.md.

Job-worker entry points, one per stage of the pipeline described in the workstream doc. Each
returns HTTP 501 with a JSON body naming the job, until implemented.
"""

from fastapi import FastAPI, Response
import json

app = FastAPI(title="services-gen")


def _not_implemented(job: str) -> Response:
    return Response(
        content=json.dumps({"error": "not_implemented", "job": job}),
        status_code=501,
        media_type="application/json",
    )


@app.post("/generate")
async def generate():
    """Entry point for POST /objects/{id}/generate, tier: "live" | "quality".

    Runs background removal, calls Baseten for the chosen tier, applies the scale binding, and
    writes embeddings on completion. See BINDING.md for the binding contract.
    """
    return _not_implemented("generate")


@app.post("/bgremove")
async def bgremove():
    """Background removal stage, run before generation. See app/bgremove/."""
    return _not_implemented("bgremove")


@app.post("/baseten")
async def baseten_call():
    """Baseten image-to-3D call, both tiers behind `tier`. See app/baseten/."""
    return _not_implemented("baseten")


@app.post("/bind")
async def bind():
    """The scale binding: normalised mesh -> bboxMeters. Sole owner. See BINDING.md."""
    return _not_implemented("bind")


@app.post("/embed")
async def embed():
    """SigLIP2 embedding, caption, palette, written on state:"ready". See app/embedding/."""
    return _not_implemented("embed")


@app.get("/health")
async def health():
    return {"status": "ok"}
