# baseten

B01's isolated SF3D Truss package and opt-in synchronous GLB-download runner are
in [`../../deploy/sf3d`](../../deploy/sf3d/README.md). It accepts one image and
returns actual raw, unscaled textured GLB bytes. Packaging tests do not establish
that the image builds, weights load, or generation works; those are B02 gates.

The Ani-side provider/binding/storage adapter is implemented in
[`../../GENERATION_HANDOFF.md`](../../GENERATION_HANDOFF.md). Its tests use a fake
provider; live generation and durable backend wiring remain blocked.
No public routes or shared contracts change in B01. The baseline has one SF3D
setting; no `quality` model is implemented. See `docs/ANI_ML_EXECUTION_PLAN.md`
from the repository root for scope, evidence, access and cost gates.
