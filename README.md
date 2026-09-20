<p align="center">
  <img src="docs/assets/scale-logo.png" alt="Scale" width="160">
</p>

<h1 align="center">Scale</h1>

<p align="center">
  Scan your room and any real object, then compose them together at true measured scale:
  on the phone in 3D and AR, and in a Meta Quest at 1:1.
</p>

<p align="center">
  <img src="docs/assets/scale-hero.png" alt="Scale: phone capture to headset room" width="720">
</p>

Built at Hack the North 2026.

## What it does

Room planners already ship LiDAR scans, accurate dimensions, and place-at-scale. Scale does two
things they structurally cannot:

- **Ingest an object that is for sale nowhere.** Walk around anything you own with an iPhone.
  Photogrammetry runs on the phone, the mesh is exported to glTF on the phone, and a minute later
  the object is in your headset at its real size.
- **Retrieve over your own possessions and the open web.** Ask, out loud, for "a side table under
  50 cm for the gap by the desk". The designer agent turns intent into constraints, an OR-Tools
  solver places things, and live Shopify storefronts are searched for listings that fit, measured
  in metres, dropped into the room as boxes and then as meshes.

Every number in the system is metres. Scale is bound exactly once. No language model ever emits a
coordinate. When a value cannot be determined, the system says so instead of guessing.

## The two apps

### Phone (Expo, iOS)

- **Capture an object in 3D.** Apple Object Capture guided orbit, on-device photogrammetry, a
  native USDZ to glTF exporter, the size read off the mesh. Preview in SceneKit, place in AR at 1:1
  with QuickLook, save to the library.
- **Measure an object.** One tap on a LiDAR frame: a measured box in under a second.
- **Photograph the walls.** The fallback when a room scan cannot read a space: six faces of a box
  room, each straightened with a four-point transform and measured from LiDAR at the corners.
- **New room from photos.** Six photos from the camera roll, straightened the same way; the room's
  size follows from each wall's proportions and one entered ceiling height. The faces are stitched
  on the room page.
- **Library.** Rooms with a photo hero and a view from inside, scanned objects with their own photos,
  and the merchant catalogue with real Shopify product photos, prices, and sizes.
- **Send a room to the headset.** Pick a room on the phone; the Quest rebuilds around you.

### Headset (WebXR, Meta Quest)

- The room at 1:1, furniture with physics, grab and carry, turn, lift with the other hand, and
  set it down on whatever is under it.
- A floating window for the library: four columns of tiles, drag it by its bar, push it away or
  pull it closer with the stick. It never closes.
- A dialogue card that floats where you look and dismisses itself when the reply is spoken, and a
  second card for shop listings that you can bring back at any time.
- Voice: hold to talk. Arrangement requests go to the designer agent; "find ..." requests go to
  three live storefronts in parallel, each shown as a small browser window with the page it is
  reading and the product photos as they arrive.
- New captures from the phone appear in the palette within ten seconds. No page reload.

## Architecture

<p align="center">
  <img src="docs/architecture/full-scale-architecture.png" alt="Architecture" width="820">
</p>

| Piece | Where | Role |
| --- | --- | --- |
| `workers` | Cloudflare Worker | The only front door. Rooms, objects, versions, uploads, search, jobs. |
| D1, R2, Vectorize, KV | Cloudflare | Rows, meshes and photos, SigLIP 2 vectors, upstream config. |
| `services/agent` | Cloudflare Worker | The designer agent the headset talks to. Intent to constraints, never coordinates. |
| `services/fit` | Docker | OR-Tools CP-SAT solver. Answers `/fit` and `/solve`. |
| `services/ingest` | Docker | Shopify crawl, Browserbase page reads, dimension extraction in metres. |
| `services/search` | Docker | Ranking. |
| `services/gen` | Docker + Baseten | 2D to 3D generation (SF3D) behind an adapter that performs the one scale binding. |
| `apps/mobile` | iPhone | Capture, library, room selection. |
| `apps/xr` | Meta Quest | The room at 1:1, the palette window, voice, listings. |

`docs/SYSTEM_STATE.md` describes exactly what is deployed and how data flows today.
`.claude/contracts.md` is the authority on every schema and route.

## Repository layout

```
apps/mobile/       Expo app: capture modules (Swift), library, room selection
apps/xr/           WebXR runtime for the Quest (three.js + Rapier)
workers/           Cloudflare Worker: every HTTP route
services/agent/    designer-agent Worker
services/fit/      OR-Tools solver
services/ingest/   Shopify scraper and extractor
services/search/   ranking service
services/gen/      Baseten generation, scale binding, embeddings
fixtures/          committed fixtures every stub answers
infra/             the laptop half of the stack: Docker, tunnels, publish
docs/              system state, architecture, brand assets
```

## Running it

Prerequisites: Xcode 26 or newer with an iPhone that has LiDAR (12 Pro or later), a Meta Quest
with developer mode, Node, Docker Desktop, and `cloudflared`.

**Phone**

```
cd apps/mobile
npm install
npx expo run:ios --device
```

**Headset**

```
cd apps/xr
npm install
npm run quest        # adb reverse, then Vite on http://localhost:5173
```

Open `http://localhost:5173` in the Quest browser over USB and press Enter VR. WebXR needs a
secure context, which localhost over USB provides.

**Edge and services**

```
cp infra/.env.example infra/.env   # fill in UPSTREAM_TOKEN
bash infra/up.sh                   # containers, tunnels, publish to the Worker
cd services/agent && npm run dev   # designer agent on :8789
```

Every `/v1` route answers a committed fixture when the request carries `X-Stub: 1`, so each app
runs against stubs with none of the above.

## Standing rules

1. Metres everywhere. Convert at the UI edge only.
2. The scale binding happens exactly once.
3. Never let a language model emit coordinates. It turns intent into constraints; a solver places.
4. Fail loud. No silent defaults.
5. Build against stubs, not against people.

## Team

| | |
| --- | --- |
| Thomas | iOS capture, Expo app, backend, data schemas |
| Justin | WebXR runtime, glTF, the fit solver, the designer agent |
| Ani | Baseten image-to-3D, the scale binding, embeddings |
| Paul | Voice loop, merchant retrieval end to end |

The full design doc and its reasoning are in `BUILD_DOC.md`.
