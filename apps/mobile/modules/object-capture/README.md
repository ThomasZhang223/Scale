# modules/object-capture

Apple Object Capture on the phone: the guided orbit (`ObjectCaptureSession` +
`ObjectCaptureView`), on-device photogrammetry (`PhotogrammetrySession`), and a USDZ → GLB
export so the headset can load the result. iPhone 12 Pro or later, iOS 17 or later.

This is the second of two object paths. `modules/object-measure` is the one-tap LiDAR
bounding box (a size in under a second, no mesh); this one takes a couple of minutes and
produces a textured mesh at true scale. They never share a camera session.

## Flow

```
startSession()      ready
startDetecting()    detecting   — Apple draws the box; user fits it
startCapturing()    capturing   — orbit; onShots ticks; onFeedback says why a shot was refused
finishCapture()     completed   — images on disk
reconstruct(detail) → { usdzPath, glbPath, bboxMeters, imageCount }
```

`detail` is `preview | reduced | medium` — the levels iOS supports (`full`/`raw` are macOS only).
`reduced` is the demo default.

## Scale

Object Capture writes metres at true size and `GLBExporter.swift` copies vertices verbatim,
so `bboxMeters` is measured off the mesh itself. There is no binding step for this path:
standing rule 2 is satisfied because nothing ever rescales, not because C did it.

## GLB export

`GLBExporter.swift` walks the USDZ with Model I/O and writes glTF 2.0 binary: positions,
normals, UVs (V flipped: USD is bottom-left, glTF top-left), UInt32 indices, one base-colour
JPEG per material. Roughness and normal maps from Object Capture are dropped — the headset's
unlit-ish look does not need them.

## Known gaps, on purpose

- Single scan pass. `beginNewScanPassAfterFlip()` (flip the object for its underside) is not
  exposed; the demo objects sit on a table.
- `ObjectCapturePointCloudView` is not shown between capture and reconstruction.
- Unverified on a real device at the time of writing: the first thing to check is that the
  GLB opens in the XR page and the readout matches a tape measure. If the mesh comes out
  mirrored, the UV flip and the handedness in `GLBExporter.swift` are the two lines to look at.
