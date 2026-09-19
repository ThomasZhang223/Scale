# Room scan in VR

A three.js WebXR page that loads a RoomPlan room scan (`CapturedRoom` JSON) and lets you
stand inside it on a Meta Quest. Walls, doors, windows and furniture boxes are built from
the scan's measurements, at true scale, with the floor at y = 0 and the room centered.

This is the smoke-test pass: hardcoded/URL-supplied scan JSON → parsed → rendered in the
Quest browser via WebXR. Live Supabase sync and the laptop file-picker/drag-drop panel are
not built yet.

## Run it

```bash
npm install
npm run dev          # laptop: http://localhost:5173
```

The room in `public/room-scan.json` (a 4.2 × 3.6 m sample, deliberately off-center like a
real ARKit scan) rises out of the floor on load.

## Run it on the Quest

Developer mode on, headset plugged in over USB:

```bash
npm run quest        # adb reverse tcp:5173 tcp:5173, then starts Vite
```

Open `http://localhost:5173` in the Quest Browser and press **Enter VR**.

Localhost over USB counts as a secure context for WebXR; a LAN IP address does not.

## Use your own scan

Replace `public/room-scan.json`, or open `?scan=https://.../your-scan.json`. The file must
be RoomPlan's `CapturedRoom` encoded with Swift's `JSONEncoder`.

Add `?panel=0` to hide the status text overlay.

## Files

| File | Job |
|---|---|
| `src/main.ts` | Scene, Enter VR, laptop spectator camera, loading the scan, the rise-up effect |
| `src/roomScan.ts` | Scan JSON → three.js room; recenters ARKit's origin |
| `src/roomScan.test.ts` | Node test: recentering math and per-object position/rotation |
| `public/room-scan.json` | The sample scan shown on load |

## If a real scan looks wrong

Open the browser console: it prints a table of detected furniture (category, size,
position, rotation). If walls are missing or rotated, compare one wall's `transform` in
your JSON with the parsers at the top of `src/roomScan.ts` — they accept 16 flat numbers
or 4 columns of 4, dimensions as `[x, y, z]`/`[x, y, z, w]`/`{x, y, z}`, and categories as
`"wall"` or `{"wall": {}}`.

## Verify

```bash
npm run build   # typecheck (tsc) + production build
npm test        # node --test src/roomScan.test.ts
```

## Not built yet (out of scope for this pass)

- `src/sync.ts` — optional Supabase live sync (`rooms` table, `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY`).
- The laptop panel's "open a scan file" button and drag-and-drop.
- `supabase/schema.sql`.
