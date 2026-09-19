# Room scan in VR

A three.js WebXR page that loads a RoomPlan room scan (`CapturedRoom` JSON) and lets you
stand inside it on a Meta Quest. Walls, doors, windows and furniture boxes are built from
the scan's measurements, at true scale, with the floor at y = 0 and the room centered.

## Run it

```bash
npm install
npm run dev          # laptop: http://localhost:5173
```

The room in `public/room-scan.json` (a 4.2 × 3.6 m sample) rises out of the floor.

**On the Quest** (developer mode on, plugged in over USB):

```bash
npm run quest        # adb reverse tcp:5173 tcp:5173, then starts Vite
```

Open `http://localhost:5173` in the Quest Browser and press **Enter VR**.

## Use your own scan

- Replace `public/room-scan.json`, or
- open `?scan=https://.../your-scan.json`, or
- on the laptop, click **Open a scan file** or drop a `.json` onto the page.

The file must be RoomPlan's `CapturedRoom` encoded with Swift's `JSONEncoder`.

## Files

| File | Job |
|---|---|
| `src/main.ts` | Scene, Enter VR, laptop camera, loading the scan, the rise-up effect |
| `src/roomScan.ts` | Scan JSON → three.js room; recenters ARKit's origin |
| `src/sync.ts` | Optional Supabase live updates |
| `public/room-scan.json` | The scan shown on load |

## Optional: live scans

To have new scans appear in every open headset without reloading, create a Supabase
project, run `supabase/schema.sql`, and copy `.env.example` to `.env` with the project URL
and anon key. Anything written to the `rooms` row (id `demo`) then shows up live, and
files opened on the laptop are sent to all headsets too.

## If a real scan looks wrong

Open the browser console: it prints a table of detected furniture. If walls are missing
or rotated, compare one wall's `transform` in your JSON with the readers at the bottom of
`src/roomScan.ts`. They accept 16 flat numbers or 4 columns of 4, and categories as
`"wall"` or `{"wall": {}}`.
