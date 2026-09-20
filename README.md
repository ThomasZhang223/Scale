<p align="center">
  <img src="docs/assets/scale-logo.png" alt="Scale" width="160">
</p>

<h1 align="center">Scale</h1>

<p align="center">
  Scan your room and any real object, browse Shopify and generate 3d renders, then compose them together at true measured scale:
  on the phone in 3D and AR, and in a Meta Quest at 1:1.
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

## Sponsor technologies

| | |
| --- | --- |
| **Cloudflare** | The backbone, not a hosting choice: 3 Workers (front door API, the WebXR page proxied over service bindings, the designer agent), D1, R2, Vectorize, KV, Durable Objects, Workflows, Queues, Cron Triggers, Workers AI, Browser Rendering, Static Assets, the Agents SDK, Tunnel, and Observability — 16 products, each with the config line that proves it in `docs/architecture/index.html`. |
| **Shopify** | Storefronts are crawled and extracted for real-world dimensions; the headset's live "find" requests browse three storefronts in parallel, and a listing is only offered once it has a reconstructed mesh. |
| **Expo** | The iPhone app: native Swift modules (RoomPlan capture, Object Capture, wall and object measurement) wrapped in an Expo Router app. |
| **Baseten** | SF3D image-to-3D generation for the catalogue, served through a dimension-binding adapter that performs the one scale binding. Currently switched off for the live demo: catalogue meshes were reconstructed ahead of time and are served from cache; live generation is supported by the pipeline but disabled. |
| **Browserbase** | Drives headless browsing of merchant storefronts for `services/ingest`'s crawl, extract, and find pipeline. |
| **ElevenLabs** | Voice in the headset: speech in and out for the hold-to-talk loop. |
| **OpenAI** | The designer agent's planner (`services/agent`), and the catalogue dimension-extraction pass in `services/ingest`. |

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

## Team

**Thomas** — iOS native capture modules (RoomPlan room scanning, object measurement) and the
Expo app around them; the Cloudflare Workers backend, including the mesh
generation and merchant-ingest workflows, the catalogue and search routes, and the KV/D1/R2/
Vectorize wiring; `infra/` (Docker, tunnels, deploy and provisioning scripts); WebXR interaction and
palette work (room selection, window/panel handling, voice-driven library answers) alongside Justin.

**Justin** — the WebXR runtime for the Quest (`apps/xr/src`): scene setup, interaction, physics and
stacking, the HUD, the voice/find panels, and ElevenLabs voice integration; the OR-Tools CP-SAT
layout solver and its evolution into `services/fit`; the designer agent Worker (`services/agent`)
and its planning pipeline; the wall-capture and object-capture native modules on the phone; and
Expo app screens (tabs, capture flow, room detail).

**Ani** — the generation and retrieval pipeline in `services/gen`: the SigLIP 2 embedding service,
the SF3D image-to-3D deployment on Baseten and its dimension-binding adapter, Shopify-aware
discovery with verified dimensions, and the Cloudflare-side wiring (mesh job dispatch, indexing)
that connects generation output back into the Worker.

**Paul** — `services/ingest`: the Shopify crawler and extractor, dimension extraction over
Browserbase-rendered pages, and the prebaked catalogue (images and manifest) handed to Ani's
pipeline; `services/search`'s ranking service; and the phone's voice loop
(`apps/mobile/src/voice`) — intent parsing, the tool schema, and the transport to the agent.

The full design doc and its reasoning are in `BUILD_DOC.md`.
