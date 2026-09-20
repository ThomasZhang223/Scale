import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { buildRoomFromScan, type BuiltRoom, type ScannedObject } from './roomScan';
import { ObjectLoader, type LoadedObject } from './objects';
import { createPhysics } from './physics';
import { Interaction } from './interaction';
import {
  getRoom, getObject, listObjects, getVersion, postVersion, objectToItem, boundsMismatch, watchRoom, postFit, STUB, askIntent, listScans, listBuiltIns, searchObjects, sameOrigin, getJob, postListingsGenerate, postObjectThumbnail,
  type ObjectV1, type VersionV1, type PlacementV1, getActiveRoom, getRoomLive
} from './api';
import { FitOverlay, type FitReport } from './fit';
import { fromPlacement, layoutToVersion, toPlacement, type PlacedLayout } from './placements';
import { AgentClient, browserEvents, type AgentSnapshot, type Proposal, type RoomStateUpload } from './agent';
import { ProposalApplier } from './apply';
import { Ghosts, type GhostTarget } from './ghosts';
import offlineProposal from '../../../services/agent/fixtures/pipeline/proposal.json';
import { Palette, type PaletteItem } from './palette';
import { Thumbnails } from './thumbs';
import { matchDetected } from './placement';
import { measuredBox } from './objects';
import { Voice, type VoiceState } from './voice';
import { findListings, matchLibraryByWord, needFromDetected, needFromText, classifyUtterance, clearScanWinner, normalizeTranscript, productQuery, SIMILAR_ENOUGH, STOREFRONTS, type Command, type Listing, type ListingsResult, type Need, type Recommendation, type StageInfo } from './listings';
import { FindPanel, type FindKind } from './findpanel';
import { Outdoors } from './outdoors';
import roomH from '../../../fixtures/room-h.json';
import roomLarge from '../public/room-large.json';

/*
 * Stand inside a RoomPlan room scan, with scanned objects (GLBs) in it.
 *
 * Room: GET /v1/rooms/{id} from the team's server (RoomCapture v1; ?room=<id> picks one),
 *   falling back to the committed fixtures/room-h.json when the server is unreachable.
 *   ?scan=<url> loads a file instead; raw RoomPlan CapturedRoom JSON works too.
 *   Built at true size, floor at y = 0.
 * Objects: from the server (?object=<id>, and every `object` event on the room's live
 *   feed, GET /v1/sync/{id}) loaded by glbUrl at scale 1 — never rescaled; from
 *   the cloud library's built-in furniture (source "primitive"), or the ?objects=<url> manifest
 *   when given; or dropped onto the page as .glb files.
 *   - Kept at their real-world size (Object Capture exports in meters).
 *   - If its name contains a category RoomPlan detected ("chair.glb", "my-sofa.glb"),
 *     the object takes that piece's place and rotation at start, replacing its grey box.
 *   - Otherwise it waits in the palette on your left hand (Quest) or behind an Add
 *     button (laptop); a dropped .glb lands at the nearest free spot in front of you.
 *   - Physics: they land on the floor, can't pass through walls or furniture, stay upright.
 *
 * Works in the Quest Browser (Enter VR) and on a laptop (orbiting view, mouse drag).
 * ?panel=0 hides the panel.
 */

const params = new URLSearchParams(location.search);
const SHOW_PANEL = params.get('panel') !== '0';
const SCAN_URL = params.get('scan'); // null: the committed RoomCapture v1 fixture
const OBJECTS_URL = params.get('objects'); // null: the built-in furniture comes from the server
// Without ?room=<id> (or VITE_ROOM_ID) the page shows the local large room, empty of furniture:
// every object comes from the palette. With one, the room is fetched from the server.
const SERVER_ROOM_ID: string | null = params.get('room') ?? import.meta.env.VITE_ROOM_ID ?? null;
const ROOM_ID = SERVER_ROOM_ID ?? roomLarge.roomId;
const OBJECT_IDS = params.get('object')?.split(',').filter(Boolean) ?? [];
// How many of the newest phone scans to bring into the room on load (?scans=N).
// ceiling: 0 for the demo — the room opens empty and everything in it was put there on purpose.
// `?scans=6` brings the old behaviour back for one page load, and changing this default restores
// it for everyone. The scans themselves are unaffected: they are still listed on the tablet's My
// scans page and in the scans popout, which read listScans(), and still re-list every 10 s.
const RECENT_SCANS = Number(params.get('scans') ?? 0);
/**
 * A voice request puts its top result in the room by itself. A person who says "find me a lamp"
 * to a headset expects a lamp to appear, not a list to read.
 *
 * ceiling: always on, and only for voice — a typed search and a hand pick are untouched. Set
 * this to false to make every voice result list-only; that is the switch the popout redesign
 * flips if it would rather the user chose.
 */
const VOICE_AUTO_ADD_TOP = true;
const VERSION_ID = params.get('version'); // a stored layout to apply after the room loads
const AGENT_STUB = params.get('agentstub') === '1' || import.meta.env.VITE_AGENT_STUB === '1'; // the agent's fixture timeline

// ---------- renderer, scene, camera ----------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor'); // y = 0 is the real floor, matching the scan
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
const outdoors = new Outdoors(); // sky, clouds and grass around the room
scene.add(outdoors.group);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x4d7a35, 1.2)); // sky above, grass below
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(3, 6, 2);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 500);
const SPECTATOR_POSITION = new THREE.Vector3(7.5, 3.6, 9.5); // back from the 6.4 × 4.8 m room, low enough to see the sky
camera.position.copy(SPECTATOR_POSITION);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.2, 0);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.4;
controls.addEventListener('start', () => (controls.autoRotate = false));

renderer.xr.addEventListener('sessionstart', () => (controls.enabled = false));
renderer.xr.addEventListener('sessionend', () => {
  controls.enabled = true;
  camera.position.copy(SPECTATOR_POSITION);
  camera.quaternion.identity();
});

const waiting = new THREE.GridHelper(6, 12, 0x5fb3ff, 0x39424c);
scene.add(waiting);
const room = new THREE.Group();
scene.add(room);
const fitOverlay = new FitOverlay();
scene.add(fitOverlay.group);
// No transcript card and no listings card: the headset shows no dialogue and no subtitles.
// What was heard is never written down, and the designer's reasoning is spoken, not drawn.
// The decision the user must act on (Keep / Put back / Ask again, and the fit counts) lives
// on the tablet's Designer page instead, where a ray can reach it.

// The find panel: head-locked ahead and to the right, showing per-store Browserbase progress
// and then the listing cards. Its own module (findpanel.ts), like hud.ts.
const findPanel = new FindPanel();
findPanel.attachTo(scene);
renderer.xr.addEventListener('sessionstart', () => findPanel.setPresenting(true));
renderer.xr.addEventListener('sessionend', () => findPanel.setPresenting(false));

const PALETTE_ACTIONS: PaletteItem[] = [
  { url: '', name: 'Reset room', action: 'reset', section: 'Room' },
  { url: '', name: 'Clear objects', action: 'clear', destructive: true, section: 'Room' },
];
const ghosts = new Ghosts();
scene.add(ghosts.group);

// Laptop side of the designer agent: a text box, the presets, and the full decision log.
const agentText = document.getElementById('agent-text') as HTMLInputElement;
const agentStatus = document.getElementById('agent-status')!;
const agentLog = document.getElementById('agent-log')!;
const agentButtons = document.getElementById('agent-buttons')!;
const agentPresets = document.getElementById('agent-presets')!;

// ---------- panel ----------

const panel = document.getElementById('panel')!;
const connection = document.getElementById('connection')!;
const note = document.getElementById('note')!;
const catalogEl = document.getElementById('catalog')!;
const scannedEl = document.getElementById('scanned')!;
const listingText = document.getElementById('listing-text') as HTMLInputElement;
const listingSearch = document.getElementById('listing-search')!;
const listingNote = document.getElementById('listing-note')!;
const listingCards = document.getElementById('listing-cards')!;
const micButton = document.getElementById('agent-mic') as HTMLButtonElement;
panel.hidden = !SHOW_PANEL;
const say = (text: string) => (note.textContent = text);

/**
 * One line to the laptop's note strip. It used to fan out to a transcript card in the
 * headset as well; that card is gone (no dialogue, no subtitles), so the severity and the
 * channel it carried have no reader left and are not taken any more.
 */
function tell(text: string) {
  say(text);
}

/** Spoken output is one sentence: the rest is never written down. */
function concise(text: string, maxChars = 140): string {
  const first = text.trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  return first.length > maxChars ? `${first.slice(0, maxChars - 1).replace(/\s+\S*$/, '')}…` : first;
}

// ---------- state ----------

interface PlacedObject {
  id: string;          // placementId
  objectId: string;    // Object v1 id from the server, or local:<name> for files and the manifest
  name: string;        // file or manifest name; matched against detected categories
  loaded: LoadedObject;
  replaces?: ScannedObject;
  category?: string;   // when known (a listing, a replacement): matched against detected categories instead of the name
  listing?: Listing;   // the merchant listing this stands for, when it came from one
}

const localId = (name: string) => `local:${name}`;
import { instanceObjectId } from './ids';

let currentRoom: BuiltRoom | null = null;
let lastScan: Record<string, unknown> | null = null;
let currentVersionId: string | null = null; // parent for the next version we push
let lastFitReport: FitReport | null = null;
let undoAvailable = false;
let lastTouchedId: string | null = null; // what the turn buttons act on when nothing is held
let selectedStyle: string | null = null; // the whole-room style Rearrange will use; none picked → Rearrange is disabled
let listings: ListingsResult | null = null; // the last recommendation set, shown on the wrist and the laptop
let listingsNeed: Need | null = null;
let listingsBusy = false;
let stageLines: string[] = []; // per-store Browserbase progress, mirrored on the laptop
let voiceState: VoiceState = 'idle';
let lastHeard: string | null = null;

/**
 * The tablet's four pages: which sections share one tab. Designer keeps the agent, the style
 * presets and the way back to the listings popout; Room keeps what LiDAR found and the two
 * destructive actions. "My scans" and "Furniture" are absent on purpose — a section missing
 * from this map becomes a page of its own, which is what those two want, and a page named
 * after its one section drops the header that would otherwise repeat the tab.
 */
const PAGE_OF: Record<string, string> = {
  Listings: 'Designer',
  Scanned: 'Room',
};

/** Whole-room styles: [button label, agent preset]. Each is a different set of rules in services/agent STYLES. */
const STYLES: [string, string][] = [
  ['Cozy', 'cozy'],
  ['Spacious', 'spacious'],
  ['Modern', 'modern'],
  ['Social', 'social'],
];
/**
 * Scans the server has no picture of. The tablet's render is the only image of them that
 * exists, so it is sent to the search index the first time it is drawn. Scans only: a
 * primitive has a real name and vector already, and a catalogue row has the store's photo.
 */
const needsThumbnail = new Set<string>();
const objects = new Map<string, PlacedObject>();
const catalog: PaletteItem[] = []; // everything in the palette's furniture list, placed or not
let rise = 1; // 0..1 while the walls rise; objects are placed once it reaches 1
let placementPending = false;

async function start() {
  const physics = await createPhysics(scene);
  const loader = new ObjectLoader(renderer);
  const palette = new Palette();
  // A tile's picture of the mesh it stands for. The palette pulls one per visible object
  // cell; thumbs.ts draws each mesh once, off to the side, and hands back a canvas.
  const thumbs = new Thumbnails(
    loader,
    () => {
      showPalette();
      findPanel.refresh(); // a scan row in the popout is waiting on the same picture
    },
    // Fire-and-forget, off the frame loop: the render goes to the search index so a scan can
    // be found by what it looks like. Nothing on screen waits for it and it is never retried.
    (objectId, jpeg) => void postObjectThumbnail(objectId, jpeg).catch((err) => console.warn(`Thumbnail not indexed for ${objectId}:`, err)),
  );
  palette.thumbFor = (item) =>
    item.url ? thumbs.get(item.objectId ?? item.url, item.url, item.scale, !!item.objectId && needsThumbnail.has(item.objectId)) : null;
  // Scale 1: a server mesh is already metres, and a picture of it never re-guesses that.
  findPanel.thumbFor = (objectId, glbUrl) => (glbUrl ? thumbs.get(objectId, sameOrigin(glbUrl), 1, needsThumbnail.has(objectId)) : null);
  const applier = new ProposalApplier(physics);
  // Built before the first showPalette(): the talk row reads voice.supported.
  const voice = new Voice({
    onState(state, detail) {
      voiceState = state;
      micButton.dataset.state = state;
      micButton.title = state === 'recording' ? 'Release to send' : state === 'error' ? detail ?? 'Voice error' : 'Hold to talk';
      // Voice trouble (a blocked mic, a rejected ElevenLabs call) is a console matter, not a
      // message on the wrist or the card: the layout work carries on without it.
      if (state === 'error' && detail) console.warn(`Voice: ${detail}`);
      showPalette();
    },
  });
  const agent = new AgentClient({
    roomId: ROOM_ID,
    stub: AGENT_STUB,
    openEvents: browserEvents,
    offlineProposal: offlineProposal as unknown as Proposal,
    onChange: onAgentChange,
  });
  const interaction = new Interaction(renderer, scene, camera, controls, physics, palette, spawn, onAction, layoutChanged, onGrab, (id) => removeObject(id), (r) => {
    const hit = findPanel.hitTest(r);
    if (!hit) return null;
    return hit.kind === 'close' ? 'find:close' : `find:pick:${hit.objectId}`;
  });
  // The popout stands in the room like the tablet does, and is moved by the same grab on the
  // same trigger. It is already in the scene (attachTo above); this only makes it grabbable.
  interaction.addWindow(findPanel);
  // Designer tiles first (closest to the hand), then the catalogue, then Reset / Clear. Each
  // item's section decides which tab it lands under; a section named here shares a page with
  // its neighbours, and one that is not named is its own page.
  const showPalette = () =>
    palette.setItems(
      [...designerTiles(agent.snapshot), ...scannedTiles(), ...listingTiles(), ...catalog, ...PALETTE_ACTIONS].map((it) => ({
        ...it,
        page: PAGE_OF[it.section ?? ''] ?? it.section,
      })),
    );
  showPalette();
  renderAgentPanel(agent.snapshot);

  function onAction(action: string) {
    if (action.startsWith('page:')) return palette.showPage(action.slice(5));
    if (action === 'scroll:back') return palette.scrollBy(-1);
    if (action === 'scroll:next') return palette.scrollBy(1);
    if (action === 'listings:show') findPanel.reopen();
    if (action === 'find:close') findPanel.dismiss();
    if (action.startsWith('find:pick:')) void pickListing(action.slice(10));
    if (action === 'reset' && lastScan) showScan(lastScan, 'Room reset');
    if (action === 'clear') clearObjects();
    if (action.startsWith('style:')) {
      selectedStyle = selectedStyle === action.slice(6) ? null : action.slice(6); // tap again to clear
      showPalette();
      renderAgentPanel(agent.snapshot);
    }
    if (action === 'rearrange') {
      // A preset goes only when a person actually picked one on the laptop panel. With none
      // picked the button's own meaning travels as free text, down the same route a spoken
      // sentence takes — never a stand-in preset, which would be a style nobody asked for.
      //
      // sampleOnSolverOutage marks this as the BUTTON's request, here at the one place the
      // button is pressed, rather than by recognising its words later — someone saying
      // "rearrange the room" out loud is free text and must still fail in view. The spoken
      // command "rearrange" arrives as this same action, so it is the button and inherits it.
      void askAgent(selectedStyle ? { preset: selectedStyle } : { text: 'Rearrange the room.' }, { sampleOnSolverOutage: true });
    }
    if (action.startsWith('preset:')) void askAgent({ preset: action.slice(7) });
    if (action === 'turn:left') turnLast(Math.PI / 2);
    if (action === 'turn:right') turnLast(-Math.PI / 2);
    if (action === 'remove') removeLast();
    if (action === 'accept') void acceptProposal();
    if (action === 'reject') void rejectProposal();
    if (action === 'ask_again') void agent.askAgain();
    if (action === 'try_again') agent.reset();
    if (action === 'undo') void undoLayout();
    if (action === 'hold:talk:down') void talkDown();
    if (action === 'hold:talk:up') void talkUp();
    if (action.startsWith('scan:')) void findForScanned(action.slice(5));
    // 'listing:<id>' is gone with the tablet's copy of the result rows. A row is picked in the
    // popout now, which sends 'find:pick:<id>' and goes through pickListing.
  }

  // ---------- scanned pieces and merchant listings ----------

  const fmtDims = (d: [number, number, number]) => d.map((m) => `${Math.round(m * 100)}`).join(' × ') + ' cm';

  /** A scanned piece is "taken" when a placed object stands in its place. */
  function replacedBy(identifier: string): PlacedObject | undefined {
    return [...objects.values()].find((o) => o.replaces?.identifier === identifier);
  }

  /** Wrist rows for what LiDAR found: category and size; trigger finds listings that fit in its place. */
  function scannedTiles(): PaletteItem[] {
    if (!currentRoom?.objects.length) return [];
    return currentRoom.objects.map((box) => {
      const taken = replacedBy(box.identifier);
      return {
        url: '',
        name: `${box.category} · ${fmtDims(box.dimensions)}${taken ? ' · replaced' : ''}`,
        action: `scan:${box.identifier}`,
        section: 'Scanned',
        accent: listingsNeed?.replaces?.identifier === box.identifier,
      };
    });
  }

  /** Wrist rows for the current recommendations: name, merchant and width; trigger puts one in the room. */
  function listingTiles(): PaletteItem[] {
    const items: PaletteItem[] = [];
    if (listingsBusy) return [{ url: '', name: 'Searching listings…', label: true, section: 'Listings' }];
    if (!listings) return items;
    // The listings card can be closed; the search itself is not over. This brings it back.
    items.push({ url: '', name: 'Show listings', action: 'listings:show', section: 'Listings' });
    if (listings.note) items.push({ url: '', name: listings.note, label: true, severity: 'warn', section: 'Listings' });
    // The rows themselves live in the popout, not here. They used to be repeated as tablet
    // rows as well, which made the same six results readable in two places and kept the
    // tablet tall — and a row here could only ever be a truncated name and one dimension.
    return items;
  }

  /** Listings that would fit in a scanned piece's place. */
  async function findForScanned(identifier: string) {
    const box = currentRoom?.objects.find((o) => o.identifier === identifier);
    if (!box) return say(`No scanned piece ${identifier} in this room.`);
    const taken = replacedBy(identifier);
    if (taken) say(`${box.category}: already replaced by ${taken.name}. Remove it first to try another.`);
    await findFor(needFromDetected(box));
  }

  /** Runs a search, keeps the result, and redraws both surfaces. Live first, bundled with a note. */
  async function findFor(need: Need, opts: { autoAdd?: boolean } = {}) {
    listingsNeed = need;
    listingsBusy = true;
    stageLines = [];
    const query = need.text ? productQuery(need.text) : need.categoryWords?.[0] ?? '';
    findPanel.showSearching(query, STOREFRONTS.map((s) => s.merchant));
    showPalette();
    renderListings();
    const onStage = (s: StageInfo) => {
      findPanel.setStage(s);
      stageLines = [...stageLines.filter((l) => !l.startsWith(`${s.merchant}:`)), `${s.merchant}: ${s.detail}`];
      renderListings();
    };
    try {
      listings = await findListings(need, 8, { onStage });
    } catch (err) {
      listings = { recommendations: [], source: 'bundled', note: `Listings unavailable: ${(err as Error).message}` };
    } finally {
      listingsBusy = false;
    }
    presentResults({ mode: 'shop', query, rows: listings.recommendations, note: listings.note });
    const top = listings.recommendations[0];
    // Asked by voice, so something has to appear: the top row goes in through the same pick a
    // hand would make. Placement, generation and dedupe stay entirely that code's business.
    if (opts.autoAdd && top) void pickListing(top.listing.objectId);
    const what = need.replaces ? `for the ${need.replaces.category}` : need.text ? `for "${need.text}"` : '';
    // The card: one short line per listing, nothing else. The voice reads each one out.
    const shown = listings.recommendations.slice(0, 6);
    if (!top) {
      tell(`Nothing for sale fits ${what}.`);
    } else {
      tell(`${listings.recommendations.length} listings ${what}`);
      shown.forEach((r, i) => tell(`${i + 1}. ${r.listing.name} — ${r.listing.merchant ?? 'catalogue'}`));
    }
    if (need.text && lastHeard === need.text) {
      const readout = top
        ? `${listings.recommendations.length} listings. ${shown.map((r) => `${r.listing.name} from ${r.listing.merchant ?? 'the catalogue'}`).join('. ')}.`
        : `Nothing for sale fits ${what}.`;
      speak(readout); // only answer aloud when it was asked aloud
    }
    return listings;
  }

  /**
   * Puts a listing in the room: its GLB when the mesh is ready, else a box of exactly its
   * bboxMeters. If the search was for a scanned piece, it takes that piece's place.
   */
  async function addListing(objectId: string): Promise<string | null> {
    const rec = listings?.recommendations.find((r) => r.listing.objectId === objectId);
    if (!rec) { say('That listing is no longer in the results.'); return null; }
    const l = rec.listing;
    let loaded: LoadedObject;
    try {
      // scale 1: the mesh normalisation contract; a measured box is already exact.
      loaded = l.state === 'ready' && l.glbUrl ? await loader.load(l.glbUrl, 1) : measuredBox(l.bboxMeters, l.name);
    } catch (err) {
      say(`Couldn't load ${l.name}: ${(err as Error).message}`);
      return null;
    }
    const replaces = listingsNeed?.replaces;
    const obj: PlacedObject = {
      id: crypto.randomUUID(),
      objectId: l.objectId,
      name: l.name,
      loaded,
      listing: l,
      // The category decides which scanned piece it stands in for; a Shopify title rarely contains "chair".
      category: replaces && !replacedBy(replaces.identifier) ? replaces.category : l.category,
    };
    objects.set(obj.id, obj);
    lastTouchedId = obj.id;
    if (currentRoom && rise >= 1) place(obj);
    showPalette();
    renderCatalog();
    layoutChanged(obj.id);
    return obj.id;
  }

  /**
   * A card was picked in the headset: the box goes in now at true size, the Worker enqueues the
   * Baseten job, and the mesh replaces the box when the job is done — by SSE if the room is
   * live, else by polling GET /jobs/{id}.
   */
  async function pickListing(objectId: string) {
    const rec = listings?.recommendations.find((r) => r.listing.objectId === objectId);
    if (!rec) return say('That listing is no longer in the results.');
    const l = rec.listing;
    const placedId = await addListing(objectId); // the measured box, placed where it belongs
    const placed = placedId ? objects.get(placedId) : undefined;
    if (!placed) return tell(`${l.name}: no room to place it.`);
    // Already has a real mesh — addListing loaded it, there's nothing left to generate.
    if (l.state === 'ready' && l.glbUrl) {
      findPanel.setProgress(objectId, 'Mesh placed at true scale');
      return;
    }
    findPanel.setProgress(objectId, 'Queued for Baseten…');
    let job: { objectId: string; jobId: string | null };
    try {
      job = await postListingsGenerate(l, SERVER_ROOM_ID);
    } catch (err) {
      findPanel.setProgress(objectId, `Couldn’t queue the mesh: ${(err as Error).message}`);
      return tell(`${l.name}: 3D request failed — ${concise((err as Error).message, 80)}`);
    }
    // The server mints a stable id; the placed box keeps tracking it so SSE dedupe works.
    placed.objectId = job.objectId;
    if (!job.jobId) {
      // The object already had its mesh, so no job was started and there is nothing to poll.
      // This is the race where the row turned ready between the search and the pick; the
      // usual ready path never reaches here, because addListing loaded the GLB above.
      try {
        const loaded = await loader.load(objectToItem(await getObject(job.objectId)).url, 1); // scale 1: the mesh normalisation contract
        if (objects.has(placed.id)) swapLoaded(placed, loaded);
        findPanel.setProgress(objectId, 'Mesh placed at true scale');
      } catch (err) {
        findPanel.setProgress(objectId, `Mesh failed to load: ${(err as Error).message}`);
        tell(`${l.name}: ${concise((err as Error).message, 80)}`);
      }
      return;
    }
    tell(`${l.name}: in the room as a box, 3D on the way.`);
    const started = Date.now();
    // ceiling: 3 s polling for up to 10 min. The SSE `object` event usually lands first; when it
    // does, addServerObject's own dedupe guard (matching objects by objectId) skips placing a
    // second copy, so this poll only matters when the room feed is stubbed or unavailable.
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const elapsed = Date.now() - started;
      if (elapsed > 600_000) return findPanel.setProgress(objectId, 'Still waiting on Baseten; the box stays.');
      let j;
      try { j = await getJob(job.jobId); } catch (err) { findPanel.setProgress(objectId, `Job status unavailable: ${(err as Error).message}`); continue; }
      if (j.state === 'done') {
        try {
          const obj = await getObject(job.objectId);
          const item = objectToItem(obj);
          const loaded = await loader.load(item.url, 1); // scale 1: the mesh normalisation contract
          const mismatch = boundsMismatch(loaded.size, item.expected);
          if (mismatch) tell(`${item.name}: ${mismatch}.`);
          if (objects.has(placed.id)) {
            swapLoaded(placed, loaded);
            findPanel.setProgress(objectId, 'Mesh placed at true scale');
            tell(`${l.name}: 3D ready.`);
          } else {
            findPanel.setProgress(objectId, 'Mesh ready, but the box was removed');
            tell(`${l.name}: 3D ready; add it again from the tablet.`);
          }
        } catch (err) {
          findPanel.setProgress(objectId, `Mesh failed to load: ${(err as Error).message}`);
          tell(`${l.name}: ${(err as Error).message}`);
        }
        return;
      }
      if (j.state === 'failed') {
        findPanel.setProgress(objectId, `Generation failed: ${j.error ?? 'unknown'}`);
        return tell(`${l.name}: 3D failed, the box stays.`);
      }
      const waiting = j.state === 'queued' && elapsed > 20_000;
      findPanel.setProgress(objectId, waiting ? 'Waiting on Baseten — box placed at true size' : `Generating mesh ${j.progressPct}%`);
    }
  }

  /** Replaces a placed object's mesh in place: same id, same spot, same heading. */
  function swapLoaded(obj: PlacedObject, loaded: LoadedObject) {
    const node = physics.nodeOf(obj.id);
    const x = node?.position.x ?? 0, z = node?.position.z ?? -1;
    const rotY = physics.rotationY(obj.id);
    physics.remove(obj.id);
    obj.loaded.node.removeFromParent();
    // The box is being replaced, not kept: dispose its geometry/material so it doesn't leak.
    obj.loaded.node.traverse((n) => {
      const m = n as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
    });
    obj.loaded = loaded;
    scene.add(loaded.node);
    physics.addObject(obj.id, loaded.node, loaded.size, loaded.hull, { x, z }, rotY, 0); // in place: no drop
    showPalette();
    layoutChanged(obj.id);
  }

  /** Laptop: the LiDAR pieces as rows with a Find-a-match button. */
  function renderScanned() {
    const rows = (currentRoom?.objects ?? []).map((box) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.className = 'label';
      const taken = replacedBy(box.identifier);
      label.innerHTML = `${box.category.charAt(0).toUpperCase() + box.category.slice(1)} <span class="dims">${fmtDims(box.dimensions)}${taken ? ` · replaced by ${taken.name}` : ''}</span>`;
      const find = document.createElement('button');
      find.type = 'button';
      find.className = listingsNeed?.replaces?.identifier === box.identifier ? 'tinted' : 'gray';
      find.textContent = 'Find a match';
      find.addEventListener('click', () => void findForScanned(box.identifier));
      row.append(label, find);
      return row;
    });
    scannedEl.replaceChildren(...rows);
  }

  /** Laptop: photo cards for the recommendations, the top one outlined, with why it was chosen. */
  function renderListings() {
    listingNote.textContent = listingsBusy
      ? ['Searching via Browserbase…', ...stageLines].join(' · ')
      : listings
        ? [listings.note, listings.source === 'live' ? 'From the live catalogue.' : null, listingsNeed?.replaces ? `Fits where the scanned ${listingsNeed.replaces.category} stands.` : null].filter(Boolean).join(' ')
        : 'Pick a scanned piece above, or describe what you need.';
    const cards = (listings?.recommendations ?? []).map((r, i) => {
      const l = r.listing;
      const card = document.createElement('div');
      card.className = i === 0 ? 'card top' : 'card';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = l.name;
      if (l.imageUrl) img.src = l.imageUrl;
      img.addEventListener('error', () => (img.style.visibility = 'hidden')); // a missing thumb is not a broken card
      const body = document.createElement('div');
      body.className = 'body';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = l.name;
      name.title = l.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const { w, h, d } = l.bboxMeters;
      meta.textContent = `${l.merchant ?? l.source} · ${Math.round(w * 100)} × ${Math.round(h * 100)} × ${Math.round(d * 100)} cm${l.price ? ` · ${(l.price.cents / 100).toFixed(0)} ${l.price.currency}` : ''}`;
      const why = document.createElement('div');
      why.className = 'why';
      why.textContent = `${Math.round(r.score * 100)}% · ${r.reasons.join(' · ')}`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const add = document.createElement('button');
      add.type = 'button';
      add.className = i === 0 ? 'filled' : 'tinted';
      add.textContent = l.glbUrl ? 'Add' : 'Add + generate mesh';
      add.addEventListener('click', () => void pickListing(l.objectId));
      actions.append(add);
      if (l.productUrl) {
        const open = document.createElement('a');
        open.href = l.productUrl;
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = 'Open';
        actions.append(open);
      }
      body.append(name, meta, why, actions);
      card.append(img, body);
      return card;
    });
    listingCards.replaceChildren(...cards);
  }

  listingSearch.addEventListener('click', () => {
    const text = listingText.value.trim();
    if (text) void findFor(needFromText(text));
  });
  listingText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') listingSearch.click();
  });
  renderListings();

  /** The person grabbed something: if a proposal is being applied, that object stays in their hand. */
  function onGrab(id: string) {
    lastTouchedId = id;
    if (applier.active) applier.exclude(id);
  }

  /** Turns the held object (or the last one touched) a quarter turn; left is counter-clockwise from above. */
  function turnLast(delta: number) {
    const id = interaction.heldIds()[0] ?? lastTouchedId ?? [...objects.keys()].pop() ?? null;
    const obj = id ? objects.get(id) : undefined;
    if (!id || !obj) return say('Grab or add an object first, then turn it.');
    const n = obj.loaded.node;
    physics.moveTo(id, n.position.x, n.position.z, physics.rotationY(id) + delta, n.position.y);
    say(`${obj.name}: turned ${delta > 0 ? 'left' : 'right'} 90°.`);
    layoutChanged(id);
  }

  /** Removes the held object (or the last one touched). A detected piece it stood in for comes back. */
  /** The Remove tile: whatever is in hand, else the last one touched. */
  function removeLast() {
    removeObject(interaction.heldIds()[0] ?? lastTouchedId ?? [...objects.keys()].pop() ?? null);
  }

  /**
   * Removes exactly this object. The A button names the one under its own ray, so this must not
   * fall back to a guess — and it is final: Undo restores a layout, which only moves objects
   * that still exist, so an object removed here does not come back.
   */
  function removeObject(id: string | null) {
    const obj = id ? objects.get(id) : undefined;
    if (!id || !obj) return say('Grab or add an object first, then remove it.');
    interaction.drop(id);
    physics.remove(id);
    obj.loaded.node.removeFromParent();
    objects.delete(id);
    if (lastTouchedId === id) lastTouchedId = null;
    const box = obj.replaces;
    if (box) {
      box.node.visible = true;
      physics.moveDetected(box.identifier, box.position[0], box.position[2], box.rotationY, box.dimensions);
    }
    fitOverlay.clear(); // ceiling: the overlay is per-report, not per-object; the next report redraws it
    say(`${obj.name} removed.`);
    renderScanned();
    showPalette();
    layoutChanged(id);
  }

  // ---------- voice: push-to-talk in, spoken proposals out ----------


  /** The talk row: hold the trigger on it, speak, let go. Shows what was heard, or what went wrong. */
  function voiceTiles(label: (n: string, s?: 'info' | 'warn') => PaletteItem, tile: (n: string, a: string, accent?: boolean) => PaletteItem): PaletteItem[] {
    if (!voice.supported) return [label('No microphone in this browser', 'warn')];
    const rows: PaletteItem[] = [];
    if (voiceState === 'recording') rows.push({ ...tile('Listening… release to send', 'hold:talk', true), destructive: true });
    else if (voiceState === 'transcribing') rows.push(label('Transcribing…'));
    else rows.push(tile(voiceState === 'speaking' ? 'Hold to talk (interrupts)' : 'Hold to talk', 'hold:talk', true));
    return rows; // what was heard is on the transcript card, not the wrist; errors go to the console
  }

  async function talkDown() {
    voice.stopSpeaking();
    try {
      await voice.start();
    } catch (err) {
      console.warn('Voice:', err);
    }
  }

  async function talkUp() {
    const text = await voice.stop();
    if (!text) return;
    lastHeard = text;
    agentText.value = text;
    tell(`“${text}”`);
    showPalette();
    await routeRequest(text);
  }

  /** Spoken output; a failure here is shown, never thrown, so voice never blocks the layout work. */
  function speak(text: string) {
    if (!voice.supported || !text) return;
    voice.speak(text).catch((err) => console.warn('Voice:', err));
  }

  // Laptop: hold the mic button. The first press also asks for microphone permission.
  micButton.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    micButton.setPointerCapture(e.pointerId);
    void talkDown();
  });
  micButton.addEventListener('pointerup', () => void talkUp());
  micButton.addEventListener('pointercancel', () => void talkUp());
  // The Quest hides permission prompts inside the immersive session, so ask on the way in.
  document.getElementById('VRButton')?.addEventListener('click', () => void voice.warmUp(), { once: true });

  // ---------- the designer agent ----------

  /** The wrist's Designer row: preset tiles, or the agent's status, or the proposal and its buttons. */
  function designerTiles(s: AgentSnapshot): PaletteItem[] {
    const label = (name: string, severity: 'info' | 'warn' = 'info'): PaletteItem => ({ url: '', name, label: true, severity, section: 'Designer' });
    const tile = (name: string, action: string, accent = false): PaletteItem => ({ url: '', name, action, accent, section: 'Designer' });
    switch (s.state) {
      case 'working':
        return [label(s.status || 'Working…'), ...s.log.slice(-3).map((e) => label(e.message, e.severity))];
      case 'proposed': {
        const p = s.proposal!;
        // There is no transcript card any more, so what the user must know before pressing
        // Keep has to be here: one line of summary, and the fit counts, which are a warning
        // and not dialogue. The explanation and the trade-off are spoken and not written.
        return [
          ...(s.offline ? [label('Offline: sample proposal', 'warn')] : []),
          label(p.summary),
          ...(p.fit.red || p.fit.amber ? [label(`Fit: ${p.fit.red} red, ${p.fit.amber} amber`, p.fit.red ? 'warn' : 'info')] : []),
          // The furniture is already gliding (previewProposal); the decision comes once it has landed.
          ...(applier.active ? [label('Moving…')] : [tile('Keep', 'accept', true), tile('Put back', 'reject'), tile('Ask again', 'ask_again')]),
        ];
      }
      case 'applying':
        return [label('Applying…')];
      case 'failed':
        return [label(s.error ?? 'Failed', 'warn'), tile('Try again', 'try_again')];
      default:
        return [
          ...(s.solver === 'offline' ? [label('Solver offline', 'warn')] : []),
          ...voiceTiles(label, tile),
          tile('Turn 90° left', 'turn:left'),
          tile('Turn 90° right', 'turn:right'),
          ...(objects.size ? [tile('Remove', 'remove')] : []),
          // No style presets on the tablet and no gate in front of Rearrange: a style now
          // arrives inside the spoken sentence ("make it cozy"), which reaches the agent as
          // free text. The laptop panel keeps its preset buttons for a keyboard demo.
          ...(objects.size ? [tile('Rearrange', 'rearrange', true)] : []),
          ...(undoAvailable ? [tile('Undo', 'undo')] : []),
        ];
    }
  }

  let spokenFor: string | null = null; // the last proposal (or failure) read aloud, so a redraw never repeats it
  function onAgentChange(s: AgentSnapshot) {
    showPalette();
    renderAgentPanel(s);
    if (s.state === 'proposed' && s.proposal) {
      const key = `proposed:${s.proposal.summary}`;
      if (spokenFor !== key) {
        spokenFor = key;
        const p = s.proposal;
        // Everything in writing, in front of the eyes; one sentence aloud.
        tell(p.summary);
        if (p.explanation) tell(p.explanation);
        if (p.tradeoffs[0]) tell(`Trade-off: ${p.tradeoffs[0]}`);
        if (p.fit.red || p.fit.amber) tell(`Fit: ${p.fit.red} red, ${p.fit.amber} amber.`);
        // Aloud: the summary and the reasoning behind it. The trade-off and the fit counts stay
        // written only, so the voice stops while the furniture is still gliding.
        speak([p.summary, p.explanation].filter(Boolean).join(' '));
      }
    } else if (s.state === 'failed' && s.error && spokenFor !== `failed:${s.error}`) {
      spokenFor = `failed:${s.error}`;
      tell(s.error);
      speak(`That didn't work. ${concise(s.error)}`);
    }
    if (s.state === 'proposed' && s.proposal) previewProposal(s.proposal);
    else if (s.state !== 'applying') ghosts.clear();
  }

  function renderAgentPanel(s: AgentSnapshot) {
    agentStatus.textContent = s.status || (s.state === 'idle' ? `Designer ready${s.solver === 'offline' ? ' (solver offline)' : ''}` : s.state);
    agentStatus.dataset.state = s.state;
    agentLog.replaceChildren(
      ...s.log.map((e) => {
        const line = document.createElement('div');
        line.className = `log ${e.severity} ${e.kind}`;
        line.textContent = `${e.at.replace(/^.*T/, '').replace(/Z$/, '')}  ${e.message}`;
        return line;
      }),
    );
    agentLog.scrollTop = agentLog.scrollHeight;
    const button = (text: string, action: string, accent = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = accent ? 'filled' : 'gray';
      b.textContent = text;
      b.addEventListener('click', () => onAction(action));
      return b;
    };
    const buttons: HTMLButtonElement[] = [];
    if (s.state === 'proposed') buttons.push(button('Keep', 'accept', true), button('Put back', 'reject'), button('Ask again', 'ask_again'));
    if (s.state === 'failed') buttons.push(button('Try again', 'try_again'));
    if (s.state === 'idle' && undoAvailable) buttons.push(button('Undo', 'undo'));
    agentButtons.replaceChildren(...buttons);
  }

  /** Everything the agent needs to know about the room right now. */
  function roomStateUpload(): RoomStateUpload | null {
    if (!currentRoom || !lastScan) return null;
    const offset = currentRoom.offset;
    const objectsOut: RoomStateUpload['objects'] = {};
    const placements: RoomStateUpload['placements'] = [];
    for (const o of objects.values()) {
      const s = o.loaded.size;
      objectsOut[o.objectId] = {
        name: o.name,
        category: o.replaces?.category ?? categoryOf(o.name),
        bboxMeters: { w: s.x, h: s.y, d: s.z },
        source: o.replaces || !o.objectId.startsWith('local:') ? 'scan' : 'local',
        detectedDims: o.replaces?.dimensions,
      };
      placements.push(toPlacement({ placementId: o.id, objectId: o.objectId, position: [o.loaded.node.position.x, o.loaded.node.position.y, o.loaded.node.position.z], rotationY: physics.rotationY(o.id) }, offset));
    }
    const taken = new Set([...objects.values()].map((o) => o.replaces?.identifier));
    for (const d of currentRoom.objects) {
      if (taken.has(d.identifier)) continue;
      const id = `box:${d.identifier}`;
      objectsOut[id] = { name: d.category, category: d.category, bboxMeters: { w: d.dimensions[0], h: d.dimensions[1], d: d.dimensions[2] }, source: 'box', confidence: 'high' };
      placements.push(toPlacement({ placementId: id, objectId: id, position: d.position, rotationY: d.rotationY }, offset));
    }
    return { room: lastScan, objects: objectsOut, placements, fitReport: lastFitReport ?? undefined };
  }

  async function syncAgentState() {
    const state = roomStateUpload();
    if (!state) return;
    await agent.syncState(state);
  }

  async function askAgent(req: { preset?: string; text?: string }, options: { sampleOnSolverOutage?: boolean } = {}) {
    if (!currentRoom) return say('Load a room first.');
    await syncAgentState();
    // The agent pins by objectId (services/agent clean.ts); what the hands hold are placement ids.
    const pins = interaction.heldIds().map((id) => objects.get(id)?.objectId ?? id);
    await agent.request({ ...req, pins }, options);
  }

  /** The object (placed or detected) a proposal talks about; the offline fixture uses obj_<category>. */
  function resolveObject(objectId: string, placementId?: string): { kind: 'placed'; obj: PlacedObject } | { kind: 'box'; box: ScannedObject } | null {
    // The placementId is the exact instance (it is our own objects-map key, uploaded as such);
    // the objectId is only a fallback for proposals that don't carry one (the offline fixture).
    const exact = placementId ? objects.get(placementId) : undefined;
    if (exact) return { kind: 'placed', obj: exact };
    const placed = [...objects.values()].find((o) => o.objectId === objectId);
    if (placed) return { kind: 'placed', obj: placed };
    if (objectId.startsWith('box:')) {
      const box = currentRoom?.objects.find((d) => `box:${d.identifier}` === objectId);
      return box ? { kind: 'box', box } : null;
    }
    const category = objectId.replace(/^obj_/, '').toLowerCase();
    const byName = [...objects.values()].find((o) => o.name.toLowerCase().includes(category) || o.replaces?.category === category);
    if (byName) return { kind: 'placed', obj: byName };
    const box = currentRoom?.objects.find((d) => d.category === category);
    return box ? { kind: 'box', box } : null;
  }

  // A proposal is shown by doing it: the furniture glides to the proposed spots as soon as the
  // agent answers (instead of drawing ghost outlines), and Keep / Put back come after. What is
  // still on the wrist during the glide is the summary, so the person sees the move and the
  // reason together. `previewBefore` is where everything was, so Put back can glide it home.
  // Grabbing something mid-glide still works: the applier drops it from the move and the rest
  // continue (onGrab → applier.exclude).
  type PlacedMove = { id: string; x: number; z: number; rotY: number };
  type BoxPose = { box: ScannedObject; position: ScannedObject['position']; rotationY: number };
  let previewedRequest: string | null = null; // onAgentChange fires on every status change; preview once per proposal
  let previewBefore: { placed: PlacedMove[]; boxes: BoxPose[] } | null = null;

  /** A detected box has no body: it simply moves, and its solid collider with it. */
  function moveBox(box: ScannedObject, position: ScannedObject['position'], rotationY: number) {
    box.node.position.set(position[0], position[1], position[2]);
    box.node.rotation.y = rotationY;
    box.position = position;
    box.rotationY = rotationY;
    physics.moveDetected(box.identifier, position[0], position[2], rotationY, box.dimensions);
  }

  function previewProposal(p: Proposal) {
    if (!currentRoom || previewedRequest === p.requestId) return;
    previewedRequest = p.requestId;
    ghosts.clear();
    // ceiling: "Ask again" on top of an un-kept preview snapshots the previewed layout, not the
    // one before it. Put back then returns to the first proposal, not to the hand-made layout.
    const before: { placed: PlacedMove[]; boxes: BoxPose[] } = { placed: [], boxes: [] };
    const offset = currentRoom.offset;
    const moves: PlacedMove[] = [];
    for (const m of p.moves) {
      const hit = resolveObject(m.objectId, m.to.placementId);
      if (!hit) continue;
      const to = fromPlacement(m.to, offset);
      if (hit.kind === 'placed') {
        const n = hit.obj.loaded.node;
        before.placed.push({ id: hit.obj.id, x: n.position.x, z: n.position.z, rotY: physics.rotationY(hit.obj.id) });
        moves.push({ id: hit.obj.id, x: to.position[0], z: to.position[2], rotY: to.rotationY });
      } else {
        before.boxes.push({ box: hit.box, position: hit.box.position, rotationY: hit.box.rotationY });
        moveBox(hit.box, to.position, to.rotationY);
      }
    }
    previewBefore = before;
    applier.start(moves, interaction.heldIds(), (result) => {
      if (result.stuck.length) tell(`Couldn't reach its spot: ${result.stuck.map((id) => objects.get(id)?.name ?? id).join(', ')}. Left where physics stopped it.`);
      showPalette(); // "Moving…" becomes Keep / Put back
    });
  }

  /** Keep: the furniture is already where the proposal put it; this only records the layout. */
  async function acceptProposal() {
    const p = await agent.accept();
    if (!p) return;
    previewBefore = null;
    undoAvailable = true;
    agent.applied();
    layoutChanged('');
    void checkFit();
  }

  /** Put back: everything glides home to where it was before the preview. */
  async function rejectProposal() {
    const before = previewBefore;
    previewBefore = null;
    await agent.reject();
    ghosts.clear();
    if (!before) return;
    for (const b of before.boxes) moveBox(b.box, b.position, b.rotationY);
    applier.start(before.placed, interaction.heldIds(), () => layoutChanged(''));
  }

  async function undoLayout() {
    const versionId = await agent.undo();
    if (!versionId) return say('Nothing to undo.');
    const version = await agent.version(versionId);
    if (version) applyPlacements(version.placements);
    undoAvailable = false;
    showPalette();
    renderAgentPanel(agent.snapshot);
    layoutChanged('');
  }

  /** Puts every object where a stored layout says, instantly. Lowest first, as applyVersion. */
  function applyPlacements(placements: PlacementV1[]) {
    if (!currentRoom) return;
    const gone: string[] = [];
    for (const p of [...placements].sort((a, b) => a.p[1] - b.p[1])) {
      const layout = fromPlacement(p, currentRoom.offset);
      const hit = resolveObject(p.objectId);
      if (!hit) {
        // Same rule as applyVersion: skip what no longer exists, and name it. This path had no
        // message at all, so an Undo onto a layout holding a deleted object came back short
        // with nothing said.
        gone.push(p.objectId.slice(0, 8));
        continue;
      }
      if (hit.kind === 'placed') physics.moveTo(hit.obj.id, layout.position[0], layout.position[2], layout.rotationY, layout.position[1]);
      else {
        hit.box.node.position.set(...layout.position);
        hit.box.node.rotation.y = layout.rotationY;
        hit.box.position = layout.position;
        hit.box.rotationY = layout.rotationY;
        physics.moveDetected(hit.box.identifier, layout.position[0], layout.position[2], layout.rotationY, hit.box.dimensions);
      }
    }
    if (gone.length) {
      console.warn(`Layout: ${gone.length} object(s) no longer exist and were left out:`, gone);
      tell(`${gone.length} object${gone.length > 1 ? 's are' : ' is'} no longer available and ${gone.length > 1 ? 'were' : 'was'} left out: ${gone.join(', ')}.`);
    }
  }

  {
    const button = (text: string, action: string, cls: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.addEventListener('click', () => onAction(action));
      return b;
    };
    const group = (cls: string, ...children: HTMLElement[]) => {
      const g = document.createElement('div');
      g.className = cls;
      g.append(...children);
      return g;
    };
    const rearrange = button('Rearrange', 'rearrange', 'filled');
    rearrange.disabled = !selectedStyle;
    rearrange.title = selectedStyle ? '' : 'Pick a style first';
    agentPresets.replaceChildren(
      group('segmented', button('Turn 90° left', 'turn:left', ''), button('Turn 90° right', 'turn:right', ''), button('Remove', 'remove', '')),
      group('styles', ...STYLES.map(([text, preset]) => button(text, `style:${preset}`, selectedStyle === preset ? 'filled' : 'tinted'))),
      rearrange,
    );
  }
  document.getElementById('agent-ask')!.addEventListener('click', () => {
    const text = agentText.value.trim();
    if (text) void routeRequest(text);
  });

  /**
   * A sentence from the keyboard or the microphone, routed to one of three handlers by one pure
   * function (listings.ts `classifyUtterance`), never by a model.
   *
   *   mine    the user's own phone scans
   *   shop    the merchants, through /v1/find
   *   design  the layout agent, unchanged
   *
   * Until 2026-09-20 only the shop test existed, and it tested a narrower verb list than
   * productQuery could parse, so ordinary speech ("show me some lamps") fell through here to the
   * agent — which is why voice appeared to do nothing but rearrange.
   */
  async function routeRequest(said: string) {
    // One known speech-to-text homophone, repaired before either router sees it, so both agree.
    const text = normalizeTranscript(said);
    // A command is decided here, instantly and with no network: it is a button press, and a
    // button press must not wait on a model.
    const rules = classifyUtterance(text);
    if (rules.kind === 'command') return runCommand(rules.command!);

    // Everything else asks the Worker's intent parser what the sentence MEANS. Thomas names the
    // SOURCE he wants searched ("find me some objects for shopify", "search my scanned
    // objects"), and no verb list can learn that a source is not a product. On any failure the
    // regex router answers instead — both are deterministic about what they do with the result.
    let kind = rules.kind;
    let query: string | null = null;
    let router: 'llm' | 'rules' = 'rules';
    try {
      const parsed = await askIntent(text);
      kind = parsed.intent === 'scans' ? 'mine' : parsed.intent;
      query = parsed.query;
      router = 'llm';
    } catch (err) {
      console.info('intent: rules (', (err as Error).message, ')');
    }
    // METRES COME FROM ONE PLACE. needFromText is tested and the model is not: it returned a
    // null fit for "the 80 centimeter gap" that the parser reads as 0.8 exactly.
    const need = needFromText(text);
    console.info(`intent: ${kind} via ${router}`, query ?? '(browse)');

    if (kind === 'mine') return findMine(text, rules, query);
    if (kind === 'library') return findLibrary(text, query ?? productQuery(text));
    if (kind === 'shop') {
      listingText.value = text;
      // A clean query from the model beats productQuery's strip, but it is still run through
      // the strip: the model sometimes hands back the whole clause.
      const words = query ? productQuery(query) : productQuery(text);
      return findFor({ ...need, query: words || undefined, browse: !words }, { autoAdd: VOICE_AUTO_ADD_TOP });
    }
    return askAgent({ text });
  }

  /**
   * Intent (d): the furniture this app ships — `source:"primitive"` rows, the Furniture page.
   *
   * Two signals, because they fail differently. A word that appears in a row's own name or
   * category is exact and survives a noisy query. A vector score catches the synonyms a word
   * match cannot: measured on the deployed index, couch -> sofa 0.9695 and armchair -> chair
   * 0.9646, while lamp's best is 0.8907 with no lamp in the library at all. One clear match is
   * placed; several are listed; none falls through to the merchants, which is the whole point of
   * trying the library first.
   */
  async function findLibrary(text: string, query: string) {
    listingsBusy = true;
    showPalette();
    let rows: ObjectV1[];
    try {
      rows = await listBuiltIns();
    } catch (err) {
      listingsBusy = false;
      return sayAloud(`Couldn't reach the library: ${(err as Error).message}`);
    } finally {
      listingsBusy = false;
    }

    let matches = matchLibraryByWord(rows as Listing[], query) as ObjectV1[];
    if (!matches.length && query) {
      // Nothing carried the word, so ask the index whether anything MEANS it.
      try {
        const hits = await searchObjects({ text: query, source: 'primitive', limit: 5 });
        const top = hits[0];
        if (top && top.score >= SIMILAR_ENOUGH) matches = [top.object];
      } catch (err) {
        console.info('library vector search unavailable:', (err as Error).message);
      }
    }
    if (!matches.length) {
      // The library has nothing like it. The merchants might, so say so and go there.
      sayAloud(`Nothing like that in the library — looking in the shops.`);
      return findFor({ ...needFromText(text), query: query || undefined, browse: !query }, { autoAdd: VOICE_AUTO_ADD_TOP });
    }

    presentResults({
      mode: 'library',
      query,
      rows: matches.map((o) => ({ listing: o as Listing, score: 0, reasons: ['from the library'] })),
      note: null,
    });
    if (matches.length > 1) return sayAloud(`${matches.length} in the library. Pick one to place it.`);
    const one = matches[0];
    if ([...objects.values()].some((o) => o.objectId === one.objectId)) {
      return sayAloud(`The ${one.name} is already in the room.`);
    }
    if (!VOICE_AUTO_ADD_TOP) return sayAloud(`${one.name} is in the list. Pick it to place it.`);
    await addServerObject(one);
    return sayAloud(`Placed the ${one.name}.`);
  }

  /**
   * A spoken button press fires the SAME action the tile fires, through onAction — never a copy
   * of a tile's body, so voice and hand can never drift apart. Nothing destructive is reachable:
   * 'reset' and 'clear' are tablet-only on purpose, because a misheard word must not be able to
   * empty the room on stage.
   */
  function runCommand(command: Command) {
    // Verbatim from designerTiles: while the furniture is still gliding into the proposed
    // layout the three decision tiles do not exist, so neither does the spoken command — firing
    // 'accept' then would decide something the user cannot yet see.
    const decidable = agent.snapshot.state === 'proposed' && !applier.active;
    switch (command) {
      case 'keep':
        return decidable ? onAction('accept') : sayAloud('Nothing to keep yet.');
      case 'ask_again':
        return decidable ? onAction('ask_again') : sayAloud('There is no proposal to redo.');
      // What a person means by "undo that" depends on what just happened: the proposal's Put
      // back while one is pending, the layout Undo once it has been applied.
      case 'putback':
        if (decidable) return onAction('reject');
        return undoAvailable ? onAction('undo') : sayAloud('There is nothing to put back.');
      case 'rearrange':
        return onAction('rearrange');
      case 'listings':
        return onAction('listings:show');
      default:
        return onAction(command); // page:<name>, the tab bar's own ids
    }
  }

  /**
   * Intent (a): the user's own captures. Answers from the scan library, never from a merchant,
   * and never falls through to the agent — a person who asked for their own thing is not asking
   * for the room to be rearranged. `source:"scan"` only: no catalogue row and no primitive can
   * reach this list.
   *
   * What it will and will not add is deliberate. Every scan row on the server today is called
   * "Captured object" with category "unknown", so a noun in the sentence has nothing to match
   * against and picking one anyway would be a guess (standing rule 4). So: a sentence that names
   * the newest adds the newest, a library of exactly one adds that one, and anything else is
   * listed for a hand to choose from.
   */
  async function findMine(text: string, intent: ReturnType<typeof classifyUtterance>, query: string | null = null) {
    listingsNeed = null;
    listingsBusy = true;
    showPalette();
    let scans: ObjectV1[];
    try {
      scans = await listScans();
    } catch (err) {
      return sayAloud(`Couldn't reach your scans: ${(err as Error).message}`);
    } finally {
      listingsBusy = false;
    }

    if (!scans.length) {
      // Nothing to show and nothing to guess. Never hand this to the agent.
      presentResults({ mode: 'scans', query: text, rows: [], note: 'No finished scans yet.' });
      return sayAloud('You have no finished scans yet. Capture something on the phone first.');
    }

    // ceiling: matches on the name and category the phone sent. Those are "Captured object" and
    // "unknown" for every row today, so this finds nothing and the count rules below decide
    // instead. It starts working by itself the day the phone names a capture — the real fix is
    // upstream, on the phone's Save screen, or a caption written at index time.
    // Ranked by what the scan LOOKS like. Every scan row is called "Captured object" with no
    // category, so a word match has nothing to read; what it does have is a render of its own
    // mesh, image-embedded into the same space the query text is embedded into. Measured live:
    // "person" puts the person and the bust on top, "bag" puts the bag on top, and a query for
    // furniture scores all four near zero because none of them is furniture.
    let ranked: { score: number; object: ObjectV1 }[] = [];
    if (query) {
      try {
        ranked = await searchObjects({ text: query, source: 'scan', limit: 10 });
      } catch (err) {
        console.info('scan search unavailable, listing instead:', (err as Error).message);
      }
    }
    const shown = ranked.length ? ranked.map((h) => h.object) : scans;

    presentResults({
      mode: 'scans',
      query: text,
      rows: shown.map((o) => ({ listing: o as Listing, score: 0, reasons: ['scanned on your phone'] })),
      note: null,
    });

    // Placed without asking only when the answer is not in doubt: a clear winner on the ranking,
    // a sentence that names the newest, or a library of exactly one.
    const one = ranked.length ? clearScanWinner(ranked)
      : intent.newest ? shown[0]
      : shown.length === 1 ? shown[0]
      : null;
    if (intent.listOnly || !one) {
      const what = ranked.length ? `${ranked.length} scans, none of them a clear match` : `${scans.length} scan${scans.length === 1 ? '' : 's'}`;
      return sayAloud(`You have ${what}. Pick one to place it.`);
    }
    if ([...objects.values()].some((o) => o.objectId === one.objectId)) {
      return sayAloud(`${one.name || 'That scan'} is already in the room.`);
    }
    if (!VOICE_AUTO_ADD_TOP) return sayAloud(`${one.name || 'Your scan'} is in the list. Pick it to place it.`);
    await addServerObject(one); // the scan library's own add path: it places, dedupes and reports
    return sayAloud(`Placed ${one.name || 'your scan'} at its measured size.`);
  }

  /**
   * The one seam between intent and presentation. This file decides WHICH rows; the panel decides
   * how they look. Today it drives the existing FindPanel, so nothing regresses before the popout
   * lands. `mode` says which library the rows came from: merchants, or the user's own scans.
   */
  function presentResults(res: { mode: FindKind; query: string; rows: Recommendation[]; note: string | null }) {
    listings = { recommendations: res.rows, source: 'live', note: res.note };
    findPanel.showResults(res.rows, res.note, res.mode, res.query);
    showPalette();
    renderListings();
  }

  /** Spoken only, and only when the request was spoken. No on-screen text: the panel is the UI. */
  function sayAloud(line: string) {
    if (lastHeard) speak(concise(line));
    else console.info(line);
  }
  agentText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('agent-ask')!.click();
  });
  void agent.health().then(() => showPalette());

  /** Removes every placed object; detected boxes come back with the next reset. */
  function clearObjects() {
    for (const obj of objects.values()) {
      physics.remove(obj.id);
      obj.loaded.node.removeFromParent();
    }
    objects.clear();
    fitOverlay.clear();
    say('All objects removed.');
    showPalette();
  }

  // ---------- room ----------

  function showScan(scan: Record<string, unknown>, source: string) {
    let built: BuiltRoom;
    try {
      built = buildRoomFromScan(scan);
    } catch (err) {
      console.error('The room scan could not be built:', err, scan);
      say('A scan arrived but couldn’t be built. The browser console has the details.');
      return;
    }
    lastScan = scan;
    // Park objects while the new room rises; they're placed again once the walls are up.
    for (const obj of objects.values()) {
      physics.remove(obj.id);
      obj.loaded.node.removeFromParent();
    }
    physics.setRoom(built); // before the rise animation scales anything
    room.clear();
    room.add(built.group);
    currentRoom = built;
    fitOverlay.setRoomOffset(built.offset);
    fitOverlay.clear();
    waiting.visible = false;
    rise = 0;
    placementPending = true; // re-place every object once the walls are up

    const { width, depth } = built.size;
    say(`${source}: ${width.toFixed(1)} × ${depth.toFixed(1)} m, ${built.objects.length} pieces of furniture detected.`);
    renderScanned();
    showPalette();
    // Start with a recommendation for the largest scanned piece; the person can pick another.
    const largest = [...built.objects].sort((a, b) => b.dimensions[0] * b.dimensions[2] - a.dimensions[0] * a.dimensions[2])[0];
    if (largest && !listings) void findFor(needFromDetected(largest));
  }

  /** Draws a FitReport and says what's wrong. */
  function showFit(report: FitReport) {
    lastFitReport = report;
    fitOverlay.show(report);
    if (report.ok || !report.violations.length) return;
    const blocks = report.violations.filter((v) => v.severity === 'block').length;
    for (const v of report.violations) tell(v.message);
    say(`Fit: ${report.violations.map((v) => v.message).join('; ')} (${blocks} blocking).`);
  }

  /** Asks the server to check the current layout; under the stub, that's the door-swing fixture. */
  async function checkFit() {
    if (SCAN_URL || !SERVER_ROOM_ID) return; // the server's stub only knows its own room
    try {
      showFit(await postFit(ROOM_ID));
    } catch (err) {
      console.warn('Fit check failed:', err);
    }
  }

  // ---------- objects ----------

  /** Puts an object in the current room: in a detected piece's place, or the nearest free spot. */
  function place(obj: PlacedObject) {
    if (!currentRoom) return;
    const match = findMatch(obj.category ?? obj.name);
    obj.replaces = match ?? undefined;

    let spot = { x: 0, z: -1 }; // in front of where you stand when entering VR
    let rotY = 0;
    if (match) {
      match.node.visible = false;
      physics.removeDetected(match.identifier);
      spot = { x: match.position[0], z: match.position[2] };
      rotY = match.rotationY;
    }
    spot = physics.findFreeSpot(obj.loaded.size, rotY, spot);
    scene.add(obj.loaded.node);
    physics.addObject(obj.id, obj.loaded.node, obj.loaded.size, obj.loaded.hull, spot, rotY);
    report(obj);
    renderScanned();
  }

  /** A detected piece whose category appears in the object's name and isn't taken yet. */
  function findMatch(name: string): ScannedObject | null {
    if (!currentRoom) return null;
    return matchDetected(name, currentRoom.objects, [...objects.values()].map((o) => o.replaces?.identifier));
  }

  /** An objectId no placed object already carries — see src/ids.ts for why that matters. */
  function freshObjectId(base: string): string {
    return instanceObjectId(base, [...objects.values()].map((o) => o.objectId));
  }

  function placeAll() {
    for (const obj of objects.values()) obj.replaces = undefined;
    for (const obj of objects.values()) place(obj);
    console.table([...objects.values()].map(describe));
    showPalette();
  }

  async function addObject(url: string, name: string, scale?: number) {
    try {
      const loaded = await loader.load(url, scale);
      const obj: PlacedObject = { id: crypto.randomUUID(), objectId: freshObjectId(localId(name)), name, loaded };
      objects.set(obj.id, obj);
      lastTouchedId = obj.id;
      if (currentRoom && rise >= 1) {
        place(obj); // otherwise placed when the room is ready
        showPalette();
      }
    } catch (err) {
      console.error(`Loading ${name} failed:`, err);
      say(`Couldn’t load ${name}: ${(err as Error).message}`);
    }
  }

  /** A fresh copy of a catalogue item, at `at` or the nearest free spot. Resolves to its id. */
  async function spawn(item: PaletteItem, at: { x: number; z: number }): Promise<string | null> {
    if (!currentRoom || rise < 1) return null;
    try {
      const loaded = await loader.load(item.url, item.scale);
      const obj: PlacedObject = { id: crypto.randomUUID(), objectId: freshObjectId(item.objectId ?? localId(item.name)), name: item.name, loaded };
      objects.set(obj.id, obj);
      lastTouchedId = obj.id;
      const spot = physics.findFreeSpot(loaded.size, 0, at);
      scene.add(loaded.node);
      // Straight onto the floor under the ray, no drop: it's being carried, not delivered.
      physics.addObject(obj.id, loaded.node, loaded.size, loaded.hull, spot, 0, 0);
      report(obj);
      showPalette(); // Rearrange appears with the first object
      // Saved as soon as it is in the room, not only once it has been moved. In VR the pull
      // puts it straight into your hand and the release saves it, but an object added from the
      // laptop's Add button is never grabbed, so without this it lived only in this tab.
      // layoutChanged is debounced, so the grab-and-release that usually follows still costs
      // one version, not two.
      layoutChanged(obj.id);
      return obj.id;
    } catch (err) {
      console.error(`Loading ${item.name} failed:`, err);
      say(`Couldn’t load ${item.name}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Laptop stand-in for the wrist palette: one Add button per catalogue item. */
  function renderCatalog() {
    catalogEl.replaceChildren(
      ...catalog.map((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'gray';
        button.textContent = item.name.length <= 2 ? item.name.toUpperCase() : item.name.charAt(0).toUpperCase() + item.name.slice(1); // sentence case; "TV"
        button.addEventListener('click', () => void spawn(item, { x: 0, z: -1 }));
        return button;
      }),
    );
  }

  function report(obj: PlacedObject) {
    const s = obj.loaded.size;
    let text = `${obj.name}: ${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} m`;
    if (obj.replaces) {
      const [w, h, d] = obj.replaces.dimensions;
      text += `, in place of the detected ${obj.replaces.category} (${fmt(w)} × ${fmt(h)} × ${fmt(d)} m)`;
    }
    if (obj.loaded.note) text += `. ${obj.loaded.note}`;
    say(text + '.');
  }

  // ---------- the server ----------

  /** An Object v1 from the server: loaded by its glbUrl at scale 1, placed, and added to the palette. */
  async function addServerObject(obj: ObjectV1) {
    let item;
    try {
      item = objectToItem(obj);
    } catch (err) {
      // No mesh yet (state "measured": the phone scanned it, nobody has generated a mesh).
      // Stand it in as a box of its measured size so it is in the room, and in every
      // rearrange, tonight; the mesh replaces it when generation exists.
      if (obj.bboxMeters && obj.bboxMeters.w > 0 && obj.bboxMeters.h > 0 && obj.bboxMeters.d > 0) {
        if ([...objects.values()].some((o) => o.objectId === obj.objectId)) return;
        const name = obj.name?.trim() || obj.category || 'scanned object';
        const placed: PlacedObject = { id: crypto.randomUUID(), objectId: obj.objectId, name, loaded: measuredBox(obj.bboxMeters, name) };
        objects.set(placed.id, placed);
        if (currentRoom && rise >= 1) place(placed); // otherwise placed when the walls are up
        const cm = (m: number) => Math.round(m * 100);
        tell(`${name}: measured on the phone, ${cm(obj.bboxMeters.w)} × ${cm(obj.bboxMeters.h)} × ${cm(obj.bboxMeters.d)} cm. Shown as a box until its mesh is generated.`);
        showPalette();
        return;
      }
      return say(`${obj.name ?? obj.objectId}: ${(err as Error).message}.`);
    }
    if ([...objects.values()].some((o) => o.objectId === obj.objectId)) return; // the poller in pickListing swaps the box for this mesh
    if (catalog.some((c) => c.url === item.url)) return; // the feed can repeat an object
    const entry: PaletteItem = { url: item.url, name: item.name, scale: 1, objectId: obj.objectId, section: 'Furniture' };
    catalog.push(entry);
    showPalette();
    renderCatalog();
    try {
      const loaded = await loader.load(item.url, 1);
      entry.size = loaded.size;
      showPalette();
      renderCatalog();
      const placed: PlacedObject = { id: crypto.randomUUID(), objectId: obj.objectId, name: item.name, loaded };
      objects.set(placed.id, placed);
      if (currentRoom && rise >= 1) place(placed); // otherwise placed when the walls are up
      const mismatch = boundsMismatch(loaded.size, item.expected);
      if (mismatch) {
        console.warn(`${item.name}: ${mismatch}`);
        tell(`${item.name}: ${mismatch}.`);
      }
    } catch (err) {
      console.error(`Loading ${item.name} from ${item.url} failed:`, err);
      tell(`Couldn’t load ${item.name} from the server: ${(err as Error).message}`);
    }
  }

  async function loadServerObjects() {
    for (const id of OBJECT_IDS) {
      try {
        await addServerObject(await getObject(id));
      } catch (err) {
        say(`Object ${id}: ${(err as Error).message}`);
      }
    }
    // The phone's scans: the newest few, ready ones as their mesh, measured ones as a box.
    if (STUB || SCAN_URL || !(RECENT_SCANS > 0)) return;
    try {
      const scans = (await listObjects('scan')).filter((o) => !OBJECT_IDS.includes(o.objectId)).slice(0, RECENT_SCANS);
      for (const obj of scans) await addServerObject(obj);
      if (scans.length) say(`${scans.length} scanned objects from the phone loaded.`);
    } catch (err) {
      console.warn('Listing scanned objects failed:', err);
    }
  }

  // ---------- versions (stored layouts) ----------

  /**
   * Moves every object the version mentions to its stored spot; fetches ones we don't have yet.
   *
   * Lowest first. A Placement's `p` is a full 3D point, so an object that was resting on a table
   * comes back on the table — but only if the table is already there. These bodies are dynamic
   * and under gravity, so a rider restored before its support falls straight through to the floor
   * and the stack is lost a frame later, where nobody can see why. Ascending y puts every support
   * in place, collider and all, before anything that rests on it.
   */
  async function applyVersion(version: VersionV1) {
    if (!currentRoom) return;
    currentVersionId = version.versionId;
    const offset = currentRoom.offset;
    const lowestFirst = [...version.placements].sort((a, b) => a.p[1] - b.p[1]);
    const unsupported: string[] = [];
    const missing: string[] = [];
    for (const p of lowestFirst) {
      const layout = fromPlacement(p, offset);
      let obj = objects.get(p.placementId) ?? [...objects.values()].find((o) => o.objectId === p.objectId && !version.placements.some((q) => q.placementId === o.id && q !== p));
      if (!obj) {
        try {
          await addServerObject(await getObject(p.objectId));
        } catch (err) {
          // The object was deleted, or its mesh is gone. Skip it: a layout must never be able to
          // refuse to open because one thing in it no longer exists. But say which one — a room
          // that quietly comes back smaller than it was saved is worse than one that explains.
          console.warn(`Version ${version.versionId}: object ${p.objectId} unavailable:`, err);
          missing.push(p.objectId.slice(0, 8));
          continue;
        }
        obj = [...objects.values()].find((o) => o.objectId === p.objectId);
        if (!obj) {
          missing.push(p.objectId.slice(0, 8));
          continue;
        }
      }
      physics.moveTo(obj.id, layout.position[0], layout.position[2], layout.rotationY, layout.position[1]);
      // Stored off the floor with nothing under it: whatever it rested on is missing from this
      // version, or its GLB failed to load. Gravity is about to drop it. Say so rather than let
      // the layout quietly differ from the one that was saved.
      if (layout.position[1] > 0.01 && !physics.supportUnder(obj.id)) unsupported.push(obj.name);
    }
    if (missing.length) {
      tell(`${missing.length} object${missing.length > 1 ? 's are' : ' is'} no longer available and ${missing.length > 1 ? 'were' : 'was'} left out: ${missing.join(', ')}.`);
    }
    if (unsupported.length) {
      console.warn(`Version ${version.versionId}: nothing to rest on for ${unsupported.join(', ')}; they fall to the floor.`);
      tell(`${unsupported.join(', ')} had nothing to rest on and fell to the floor.`);
    }
    say(`Layout "${version.label}" applied: ${version.placements.length - missing.length} of ${version.placements.length} placements.`);
  }

  let pushTimer: number | undefined;

  /** After a drop, push the layout as a new version (debounced; one call per pause in editing). */
  function layoutChanged(_id: string) {
    if (SCAN_URL || !currentRoom) return;
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(async () => {
      void syncAgentState(); // the agent keeps its own layout history until the server's is real
      if (!SERVER_ROOM_ID) return;
      const offset = currentRoom!.offset;
      const layout: PlacedLayout[] = [...objects.values()].map((o) => ({
        placementId: o.id,
        objectId: o.objectId,
        position: [o.loaded.node.position.x, o.loaded.node.position.y, o.loaded.node.position.z],
        rotationY: physics.rotationY(o.id),
      }));
      try {
        const body = await layoutToVersion(ROOM_ID, layout, offset, currentVersionId, 'headset edit');
        const version = await postVersion(ROOM_ID, body);
        currentVersionId = version.versionId;
        void checkFit();
      } catch (err) {
        // The stub answers 501 here; once versions are real this becomes the live save.
        console.info('Layout not saved to the server:', (err as Error).message);
      }
    }, 800);
  }

  /** A category the agent and the detected boxes will recognise, from a file or manifest name. */
  function categoryOf(name: string): string {
    const known = ['coffee table', 'side table', 'sofa', 'couch', 'armchair', 'chair', 'stool', 'bench', 'dining', 'table', 'desk', 'bed', 'storage', 'shelf', 'bookcase', 'cabinet', 'dresser', 'wardrobe', 'lamp', 'television', 'tv', 'plant', 'rug'];
    const lower = name.toLowerCase();
    return known.find((k) => lower.includes(k)) ?? name.replace(/\.(glb|gltf)$/i, '');
  }

  // ---------- loading ----------

  async function loadRoom() {
    if (SCAN_URL) {
      try {
        const res = await fetch(SCAN_URL);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        showScan(await res.json(), SCAN_URL.split('/').pop() ?? 'Room scan');
        setConnection('file');
      } catch (err) {
        say(`Couldn’t load ${SCAN_URL}: ${(err as Error).message}. Drop a scan file onto the page instead.`);
      }
      return;
    }
    if (!SERVER_ROOM_ID) {
      showScan(roomLarge, 'room-large.json');
      setConnection('file');
      return;
    }
    try {
      const scan = await getRoom(ROOM_ID);
      showScan(scan, `Room ${ROOM_ID.slice(0, 8)}… from the server`);
      setConnection(STUB ? 'stub' : 'server');
    } catch (err) {
      console.warn('The server did not answer; showing the committed fixture instead.', err);
      showScan(roomH, 'room-h.json (the demo room, offline)');
      setConnection('offline');
    }
  }

  async function loadManifest() {
    let list: { url: string; name?: string; scale?: number; objectId?: string }[];
    try {
      if (OBJECTS_URL) {
        // An explicit ?objects=<url> is a choice, not a fallback.
        const res = await fetch(OBJECTS_URL);
        if (!res.ok) return; // no manifest is fine
        list = await res.json();
      } else {
        // Scale 1: server meshes are already metres (standing rule 2), never re-guessed.
        list = (await listBuiltIns()).map((o) => ({ url: sameOrigin(o.glbUrl!), name: o.name, scale: 1, objectId: o.objectId }));
      }
    } catch (err) {
      console.warn('The furniture list could not be read:', err);
      tell(`Built-in furniture unavailable: ${(err as Error).message}`);
      return;
    }
    for (const o of list) catalog.push({ url: o.url, name: o.name ?? o.url.split('/').pop()!, scale: o.scale, objectId: o.objectId, section: 'Furniture' });
    showPalette();
    renderCatalog();

    // Preload every item so the first pull from the palette is instant. Only items that
    // stand in for a detected piece are placed now; the rest wait in the palette.
    await Promise.all(
      catalog.map(async (item) => {
        try {
          const loaded = await loader.load(item.url, item.scale);
          item.size = loaded.size;
          if (!findMatch(item.name)) return;
          const obj: PlacedObject = { id: crypto.randomUUID(), objectId: freshObjectId(localId(item.name)), name: item.name, loaded };
          objects.set(obj.id, obj);
          if (currentRoom && rise >= 1) place(obj); // otherwise placed when the walls are up
        } catch (err) {
          console.error(`Loading ${item.name} failed:`, err);
          say(`Couldn’t load ${item.name}: ${(err as Error).message}`);
        }
      }),
    );
    showPalette(); // labels now include sizes
    renderCatalog();
  }

  /**
   * "My scans": what the phone captured and reconstructed, as pullable palette tiles next to
   * the bundled furniture. Scale 1 always — a captured mesh is already true size (standing
   * rule 2: nothing downstream rescales). Loaded after the manifest so the palette order is
   * stable: designer, scanned pieces, listings, my scans, furniture.
   */
  const knownScans = new Set<string>();
  async function loadMyScans(announce = false) {
    let scans;
    try {
      scans = await listScans();
    } catch (err) {
      console.warn('My scans unavailable:', err);
      return;
    }
    const fresh = scans.filter((o) => !knownScans.has(o.objectId));
    if (!fresh.length) return;
    for (const o of fresh) knownScans.add(o.objectId);
    // A phone scan arrives with no picture of any kind: Object Capture uploads the mesh alone.
    // The render the tablet makes is therefore the only image of it that exists, and the
    // search index needs one — without it every scan is the same "Captured object" text,
    // embeds to the same point, and no query can separate two of them. Decided here from the
    // row the server actually sent, never from a Recommendation, which carries a fallback URL
    // that makes an object with no image look like it has one (listings.ts).
    for (const o of fresh) if (o.source === 'scan' && !o.imageUrl) needsThumbnail.add(o.objectId);
    const items: PaletteItem[] = fresh.map((o) => ({
      url: sameOrigin(o.glbUrl!),
      name: o.name || 'Captured object',
      scale: 1,
      objectId: o.objectId,
      section: 'My scans',
    }));
    catalog.unshift(...items);
    showPalette();
    renderCatalog();
    await Promise.all(
      items.map(async (item) => {
        try {
          const loaded = await loader.load(item.url, 1);
          item.size = loaded.size;
          const expected = fresh.find((o) => o.objectId === item.objectId)?.bboxMeters;
          const mismatch = expected ? boundsMismatch(loaded.size, expected) : null;
          if (mismatch) console.warn(`${item.name}: ${mismatch}`);
        } catch (err) {
          console.error(`Loading scan ${item.name} failed:`, err);
          say(`Couldn’t load your scan ${item.name}: ${(err as Error).message}`);
        }
      }),
    );
    showPalette();
    renderCatalog();
    if (announce) say(fresh.length === 1 ? `New scan from the phone: ${items[0].name}. It's on your wrist.` : `${fresh.length} new scans from the phone are on your wrist.`);
  }

  await loadRoom();

  /**
   * The room picked on the phone becomes the surroundings here. Polled from this page's own
   * dev server (vite.config.ts) every 3 s; a change fetches the live room and rebuilds the
   * scene through the same path a dropped scan file uses. Objects already placed stay in
   * the palette; the floor and walls under them change.
   */
  let activeRoomId: string | null = null;
  async function followPhoneRoom() {
    let picked: string | null;
    try {
      picked = await getActiveRoom();
    } catch {
      return;
    }
    if (!picked || picked === activeRoomId) return;
    try {
      // Live first (a room built on the phone exists only there); the stub second, which is
      // where the committed demo room lives.
      const scan = await getRoomLive(picked).catch(() => getRoom(picked));
      activeRoomId = picked;
      showScan(scan, `Room ${picked.slice(0, 8)}… picked on the phone`);
      setConnection('server');
      say('Now in the room you picked on the phone.');
    } catch (err) {
      activeRoomId = picked; // do not retry a room the server cannot give us every 3 s
      say(`Couldn’t load the room picked on the phone: ${(err as Error).message}`);
    }
  }
  void followPhoneRoom();
  setInterval(() => void followPhoneRoom(), 3_000);

  // Phone captures arrive while the headset is on. Poll rather than SSE: the sync feed is
  // per room and stubbed by default, while this list is always the live table. Ten seconds
  // is invisible next to the minutes a capture takes.
  void loadManifest().then(() => loadMyScans(false));
  setInterval(() => void loadMyScans(true), 10_000);
  await loadServerObjects();
  void checkFit();
  if (VERSION_ID) {
    getVersion(VERSION_ID).then(applyVersion).catch((err) => say(`Version ${VERSION_ID}: ${(err as Error).message}`));
  }
  if (!SCAN_URL && SERVER_ROOM_ID) {
    watchRoom(ROOM_ID, {
      object: (obj) => void addServerObject(obj),
      version: (v) => void getVersion(v.versionId).then(applyVersion).catch((err) => console.warn('Version event:', err)),
      fit: showFit,
      status: setConnection,
    });
  }

  // ---------- panel actions ----------

  const picker = document.getElementById('picker') as HTMLInputElement;
  document.getElementById('open')!.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    for (const file of picker.files ?? []) void openFile(file);
    picker.value = '';
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    for (const file of e.dataTransfer?.files ?? []) void openFile(file);
  });

  async function openFile(file: File) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.glb') || name.endsWith('.gltf')) {
      say(`Loading ${file.name}…`);
      return addObject(URL.createObjectURL(file), file.name);
    }
    if (!name.endsWith('.json')) return say(`${file.name}: drop a room scan (.json) or an object (.glb).`);

    let scan: Record<string, unknown>;
    try {
      scan = JSON.parse(await file.text());
    } catch {
      return say(`${file.name} isn’t valid JSON. Export the CapturedRoom with JSONEncoder and try again.`);
    }
    showScan(scan, file.name);
    setConnection('file');
  }

  document.getElementById('reset')!.addEventListener('click', () => onAction('reset'));
  // Delete / Backspace on the laptop removes the last-touched object; not while typing.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    onAction('remove');
  });

  (document.getElementById('colliders') as HTMLInputElement).addEventListener('change', (e) => {
    physics.setDebug((e.target as HTMLInputElement).checked);
  });

  // ---------- loop ----------

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    outdoors.update(clock.elapsedTime);
    if (rise < 1) {
      rise = Math.min(1, rise + dt * 1.4);
      room.scale.y = Math.max(0.001, 1 - Math.pow(1 - rise, 3));
    } else if (placementPending) {
      placementPending = false;
      placeAll();
      void syncAgentState();
    }
    interaction.update(dt);
    applier.update(dt);
    physics.step(dt);
    thumbs.update(); // at most one tile picture drawn per frame, and only for the page on screen
    findPanel.place(renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
    if (!renderer.xr.isPresenting) controls.update();
    renderer.render(scene, camera);
  });
}

function setConnection(status: 'stub' | 'server' | 'live' | 'nosync' | 'offline' | 'file') {
  const labels = {
    stub: 'Server: stub data (X-Stub: 1)',
    server: 'Server: connected',
    live: 'Live: new objects appear as the phone pushes them',
    nosync: 'Server answered; the live feed isn’t available yet (retrying)',
    offline: 'Server unreachable: showing the committed fixture',
    file: 'Local file',
  };
  connection.textContent = labels[status];
  connection.dataset.live = String(status === 'live');
}

function describe(o: PlacedObject) {
  const s = o.loaded.size;
  return {
    object: o.name,
    size: `${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} m`,
    replaces: o.replaces ? `${o.replaces.category} (${o.replaces.dimensions.map(fmt).join(' × ')} m)` : '',
    units: o.loaded.note ?? 'meters',
  };
}

const fmt = (n: number) => n.toFixed(2);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

start().catch((err) => {
  console.error(err);
  say(`Couldn’t start: ${(err as Error).message}`);
});
