# Transform convention — read this before writing any transform code

Every `transform` in `RoomCapture v1` (walls, openings, objects) is **16 floats,
column-major**. This matches `simd_float4x4` memory order and `THREE.Matrix4.fromArray` —
load it with **no transpose**:

```js
const m = new THREE.Matrix4().fromArray(transform); // no .transpose()
```

Getting this wrong is the most expensive silent bug available in this workstream: a wrong
convention still produces a room that looks plausible — it just comes out mirrored or
rotated, and nothing throws.

**Prove it before trusting it.** Load `fixtures/room-demo.json`, render one wall, and check it
lands where the fixture's floor polygon and `northBearingDeg` say it should. "Looks like a
room" is not proof.

## GLBs are never rescaled here

A GLB arriving via `Object v1.glbUrl` already satisfies the mesh normalisation contract:

- Its axis-aligned bounding box equals `bboxMeters`, to within 1 mm.
- Its origin sits at the bottom-centre of that box.
- +Y is up, −Z is the front face.
- Its glTF node scale is 1.

The scale binding happens exactly once, in Ani's component. Applying any scale factor here is
a bug, not a preference — a second rescale squares the error and nobody finds it until the
demo.
