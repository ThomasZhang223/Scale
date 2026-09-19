# mesh-macbook.glb — not fabricated here

This repo cannot author a real binary glTF by hand, so this placeholder README stands in for
`fixtures/mesh-macbook.glb` until **Ani** supplies the real file. Do not commit a fake `.glb`.

The real file must satisfy the mesh normalisation contract in `.claude/contracts.md` for the
exact numbers in `fixtures/object-macbook.json`:

1. The mesh's axis-aligned bounding box equals `bboxMeters` from `object-macbook.json`
   (`w: 0.3126, h: 0.0155, d: 0.2212`, metres) to within 1 mm.
2. The origin sits at the bottom-centre of that box (placement `y = 0` means "on the floor").
3. +Y is up, −Z is the front face.
4. Units are metres, so the glTF node scale is `1`.

Once supplied, this README is replaced by the real `mesh-macbook.glb`.
