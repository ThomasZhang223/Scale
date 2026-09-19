# Synthetic B04 mesh fixtures

`synthetic.py` deterministically builds tiny GLB bytes in memory. No model output,
merchant asset or physical measurement is used. No large binary files are tracked.

- `simple`: asymmetric sloped body, two material primitives, embedded labeled PNG.
- `complex`: translated/rotated root, nested rotation, nonuniform scales, mirrored
  shared-mesh instance; two material assignments for each geometry instance.
- `orientation`: translated root plus labeled BODY, FRONT_+X, UP_+Z and LEFT_+Y
  marker nodes. Source +X front / +Z up / +Y left is synthetic by construction.

The fixture orientation matrix has rows `[[0,-1,0],[0,0,1],[-1,0,0]]`, mapping
source +X to project -Z, +Z to +Y and +Y to -X. This matrix is **not** an SF3D
orientation profile. Tests separately check wrong/swapped axes, all scene bounds,
normal/winding transforms and retained images/UV/PBR data after serialization.

Generation is deterministic under the exact NumPy/trimesh/Pillow pins in
`requirements-binding.txt`. Repeated binding must produce identical GLB bytes.
The PNG labels and GLB generator field explicitly identify synthetic provenance.
