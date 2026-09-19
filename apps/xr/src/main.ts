import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { buildRoomFromScan, type BuiltRoom, type ScannedObject } from './roomScan';
import { ObjectLoader, type LoadedObject } from './objects';
import { createPhysics } from './physics';
import { Interaction } from './interaction';
import {
  getRoom, getObject, getVersion, postVersion, objectToItem, boundsMismatch, watchRoom, postFit, STUB,
  type ObjectV1, type VersionV1, type PlacementV1,
} from './api';
import { FitOverlay, type FitReport } from './fit';
import { fromPlacement, layoutToVersion, toPlacement, type PlacedLayout } from './placements';
import { AgentClient, browserEvents, type AgentSnapshot, type Proposal, type RoomStateUpload } from './agent';
import { ProposalApplier } from './apply';
import { Ghosts, type GhostTarget } from './ghosts';
import offlineProposal from '../../../services/agent/fixtures/pipeline/proposal.json';
import { Palette, type PaletteItem } from './palette';
import { matchDetected } from './placement';
import roomDemo from '../../../fixtures/room-demo.json';
import roomLarge from '../public/room-large.json';

/*
 * Stand inside a RoomPlan room scan, with scanned objects (GLBs) in it.
 *
 * Room: GET /v1/rooms/{id} from the team's server (RoomCapture v1; ?room=<id> picks one),
 *   falling back to the committed fixtures/room-demo.json when the server is unreachable.
 *   ?scan=<url> loads a file instead; raw RoomPlan CapturedRoom JSON works too.
 *   Built at true size, floor at y = 0.
 * Objects: from the server (?object=<id>, and every `object` event on the room's live
 *   feed, GET /v1/sync/{id}) loaded by glbUrl at scale 1 — never rescaled; from
 *   /objects.json; or dropped onto the page as .glb files.
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
const OBJECTS_URL = params.get('objects') ?? '/objects.json';
// Without ?room=<id> (or VITE_ROOM_ID) the page shows the local large room, empty of furniture:
// every object comes from the palette. With one, the room is fetched from the server.
const SERVER_ROOM_ID: string | null = params.get('room') ?? import.meta.env.VITE_ROOM_ID ?? null;
const ROOM_ID = SERVER_ROOM_ID ?? roomLarge.roomId;
const OBJECT_IDS = params.get('object')?.split(',').filter(Boolean) ?? [];
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
scene.background = new THREE.Color('#1d2126');
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f45, 1.3));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(3, 6, 2);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
const SPECTATOR_POSITION = new THREE.Vector3(5.5, 6.5, 7.5); // far enough back for the 6.4 × 4.8 m room
camera.position.copy(SPECTATOR_POSITION);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.8, 0);
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

const PALETTE_ACTIONS: PaletteItem[] = [
  { url: '', name: 'Reset room', action: 'reset' },
  { url: '', name: 'Clear objects', action: 'clear' },
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
panel.hidden = !SHOW_PANEL;
const say = (text: string) => (note.textContent = text);

// ---------- state ----------

interface PlacedObject {
  id: string;          // placementId
  objectId: string;    // Object v1 id from the server, or local:<name> for files and the manifest
  name: string;        // file or manifest name; matched against detected categories
  loaded: LoadedObject;
  replaces?: ScannedObject;
}

const localId = (name: string) => `local:${name}`;

let currentRoom: BuiltRoom | null = null;
let lastScan: Record<string, unknown> | null = null;
let currentVersionId: string | null = null; // parent for the next version we push
let lastFitReport: FitReport | null = null;
let undoAvailable = false;
let lastTouchedId: string | null = null; // what the turn buttons act on when nothing is held
const objects = new Map<string, PlacedObject>();
const catalog: PaletteItem[] = []; // everything in objects.json, placed or not
let rise = 1; // 0..1 while the walls rise; objects are placed once it reaches 1
let placementPending = false;

async function start() {
  const physics = await createPhysics(scene);
  const loader = new ObjectLoader(renderer);
  const palette = new Palette();
  const applier = new ProposalApplier(physics);
  const agent = new AgentClient({
    roomId: ROOM_ID,
    stub: AGENT_STUB,
    openEvents: browserEvents,
    offlineProposal: offlineProposal as unknown as Proposal,
    onChange: onAgentChange,
  });
  const interaction = new Interaction(renderer, scene, camera, controls, physics, palette, spawn, onAction, layoutChanged, onGrab);
  const showPalette = () => palette.setItems([...catalog, ...PALETTE_ACTIONS, ...designerTiles(agent.snapshot)]);
  showPalette();
  renderAgentPanel(agent.snapshot);

  function onAction(action: string) {
    if (action === 'reset' && lastScan) showScan(lastScan, 'Room reset');
    if (action === 'clear') clearObjects();
    if (action.startsWith('preset:')) void askAgent({ preset: action.slice(7) });
    if (action === 'turn:left') turnLast(Math.PI / 2);
    if (action === 'turn:right') turnLast(-Math.PI / 2);
    if (action === 'accept') void acceptProposal();
    if (action === 'reject') void rejectProposal();
    if (action === 'ask_again') void agent.askAgain();
    if (action === 'try_again') agent.reset();
    if (action === 'undo') void undoLayout();
  }

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
    physics.moveTo(id, n.position.x, n.position.z, physics.rotationY(id) + delta);
    say(`${obj.name}: turned ${delta > 0 ? 'left' : 'right'} 90°.`);
    layoutChanged(id);
  }

  // ---------- the designer agent ----------

  /** The wrist's Designer row: preset tiles, or the agent's status, or the proposal and its buttons. */
  function designerTiles(s: AgentSnapshot): PaletteItem[] {
    const label = (name: string, severity: 'info' | 'warn' = 'info'): PaletteItem => ({ url: '', name, label: true, severity });
    const tile = (name: string, action: string, accent = false): PaletteItem => ({ url: '', name, action, accent });
    switch (s.state) {
      case 'working':
        return [label(s.status || 'Working…'), ...s.log.slice(-3).map((e) => label(e.message, e.severity))];
      case 'proposed': {
        const p = s.proposal!;
        return [
          label(s.offline ? 'Offline: sample proposal' : p.summary),
          label(p.explanation),
          ...(p.tradeoffs.length ? [label(p.tradeoffs[0], 'warn')] : []),
          ...(p.fit.red || p.fit.amber ? [label(`Fit: ${p.fit.red} red, ${p.fit.amber} amber`, p.fit.red ? 'warn' : 'info')] : []),
          tile('Accept', 'accept', true), tile('Reject', 'reject'), tile('Ask again', 'ask_again'),
        ];
      }
      case 'applying':
        return [label('Applying…')];
      case 'failed':
        return [label(s.error ?? 'Failed', 'warn'), tile('Try again', 'try_again')];
      case 'room_changed':
        return [label('The room changed.', 'warn'), tile('Ask again', 'ask_again'), tile('Dismiss', 'try_again')];
      default:
        return [
          label(`Designer${s.solver === 'offline' ? ' (solver offline)' : ''}`),
          tile('Turn 90° left', 'turn:left'),
          tile('Turn 90° right', 'turn:right'),
          ...(undoAvailable ? [tile('Undo', 'undo')] : []),
        ];
    }
  }

  function onAgentChange(s: AgentSnapshot) {
    showPalette();
    renderAgentPanel(s);
    if (s.state === 'proposed' && s.proposal) showGhosts(s.proposal);
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
      b.className = accent ? '' : 'quiet';
      b.textContent = text;
      b.addEventListener('click', () => onAction(action));
      return b;
    };
    const buttons: HTMLButtonElement[] = [];
    if (s.state === 'proposed') buttons.push(button('Accept', 'accept', true), button('Reject', 'reject'), button('Ask again', 'ask_again'));
    if (s.state === 'failed') buttons.push(button('Try again', 'try_again'));
    if (s.state === 'room_changed') buttons.push(button('Ask again', 'ask_again'), button('Dismiss', 'try_again'));
    if (s.state === 'idle' && undoAvailable) buttons.push(button('Undo', 'undo'));
    agentButtons.replaceChildren(...buttons);
    if (s.state === 'proposed' && s.proposal) {
      const p = s.proposal;
      say(`${p.summary}: ${p.explanation}${p.tradeoffs.length ? ` Trade-off: ${p.tradeoffs[0]}` : ''}`);
    }
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

  async function askAgent(req: { preset?: string; text?: string }) {
    if (!currentRoom) return say('Load a room first.');
    await syncAgentState();
    await agent.request({ ...req, pins: interaction.heldIds() });
  }

  /** The object (placed or detected) a proposal talks about; the offline fixture uses obj_<category>. */
  function resolveObject(objectId: string): { kind: 'placed'; obj: PlacedObject } | { kind: 'box'; box: ScannedObject } | null {
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

  function showGhosts(p: Proposal) {
    if (!currentRoom) return;
    const targets: GhostTarget[] = [];
    for (const m of p.moves) {
      const hit = resolveObject(m.objectId);
      if (!hit) continue;
      const to = fromPlacement(m.to, currentRoom.offset);
      if (hit.kind === 'placed') {
        const n = hit.obj.loaded.node;
        targets.push({ node: n, from: [n.position.x, 0, n.position.z], to: to.position, rotY: to.rotationY, size: hit.obj.loaded.size });
      } else {
        const [w, h, d] = hit.box.dimensions;
        targets.push({ node: hit.box.node, from: hit.box.position, to: to.position, rotY: to.rotationY, size: new THREE.Vector3(w, h, d) });
      }
    }
    ghosts.show(targets);
  }

  async function acceptProposal() {
    const p = await agent.accept();
    if (!p || !currentRoom) return;
    ghosts.clear();
    const offset = currentRoom.offset;
    const moves: { id: string; x: number; z: number; rotY: number }[] = [];
    for (const m of p.moves) {
      const hit = resolveObject(m.objectId);
      if (!hit) continue;
      const to = fromPlacement(m.to, offset);
      if (hit.kind === 'placed') moves.push({ id: hit.obj.id, x: to.position[0], z: to.position[2], rotY: to.rotationY });
      else {
        // A detected box has no body: it simply moves, and its solid collider with it.
        hit.box.node.position.set(to.position[0], to.position[1], to.position[2]);
        hit.box.node.rotation.y = to.rotationY;
        hit.box.position = to.position;
        hit.box.rotationY = to.rotationY;
        physics.moveDetected(hit.box.identifier, to.position[0], to.position[2], to.rotationY, hit.box.dimensions);
      }
    }
    applier.start(moves, interaction.heldIds(), (result) => {
      if (result.stuck.length) say(`Couldn't reach its spot: ${result.stuck.map((id) => objects.get(id)?.name ?? id).join(', ')}. Left where physics stopped it.`);
      undoAvailable = true;
      agent.applied();
      layoutChanged('');
      void checkFit();
    });
  }

  async function rejectProposal() {
    await agent.reject();
    ghosts.clear();
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

  /** Puts every object where a stored layout says, instantly. */
  function applyPlacements(placements: PlacementV1[]) {
    if (!currentRoom) return;
    for (const p of placements) {
      const layout = fromPlacement(p, currentRoom.offset);
      const hit = resolveObject(p.objectId);
      if (!hit) continue;
      if (hit.kind === 'placed') physics.moveTo(hit.obj.id, layout.position[0], layout.position[2], layout.rotationY);
      else {
        hit.box.node.position.set(...layout.position);
        hit.box.node.rotation.y = layout.rotationY;
        hit.box.position = layout.position;
        hit.box.rotationY = layout.rotationY;
        physics.moveDetected(hit.box.identifier, layout.position[0], layout.position[2], layout.rotationY, hit.box.dimensions);
      }
    }
  }

  agentPresets.replaceChildren(
    ...[['Turn 90° left', 'turn:left'], ['Turn 90° right', 'turn:right']].map(([text, action]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'quiet';
      b.textContent = text;
      b.addEventListener('click', () => onAction(action));
      return b;
    }),
  );
  document.getElementById('agent-ask')!.addEventListener('click', () => {
    const text = agentText.value.trim();
    if (text) void askAgent({ text });
  });
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
  }

  /** Draws a FitReport and says what's wrong. */
  function showFit(report: FitReport) {
    lastFitReport = report;
    fitOverlay.show(report);
    if (report.ok || !report.violations.length) return;
    const blocks = report.violations.filter((v) => v.severity === 'block').length;
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
    const match = findMatch(obj.name);
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
  }

  /** A detected piece whose category appears in the object's name and isn't taken yet. */
  function findMatch(name: string): ScannedObject | null {
    if (!currentRoom) return null;
    return matchDetected(name, currentRoom.objects, [...objects.values()].map((o) => o.replaces?.identifier));
  }

  function placeAll() {
    for (const obj of objects.values()) obj.replaces = undefined;
    for (const obj of objects.values()) place(obj);
    console.table([...objects.values()].map(describe));
  }

  async function addObject(url: string, name: string, scale?: number) {
    try {
      const loaded = await loader.load(url, scale);
      const obj: PlacedObject = { id: crypto.randomUUID(), objectId: localId(name), name, loaded };
      objects.set(obj.id, obj);
      if (currentRoom && rise >= 1) place(obj); // otherwise placed when the room is ready
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
      const obj: PlacedObject = { id: crypto.randomUUID(), objectId: item.objectId ?? localId(item.name), name: item.name, loaded };
      objects.set(obj.id, obj);
      lastTouchedId = obj.id;
      const spot = physics.findFreeSpot(loaded.size, 0, at);
      scene.add(loaded.node);
      // Straight onto the floor under the ray, no drop: it's being carried, not delivered.
      physics.addObject(obj.id, loaded.node, loaded.size, loaded.hull, spot, 0, 0);
      report(obj);
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
        button.className = 'quiet';
        button.textContent = `Add ${item.name}`;
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
      return say(`${obj.name ?? obj.objectId}: ${(err as Error).message}.`);
    }
    if (catalog.some((c) => c.url === item.url)) return; // the feed can repeat an object
    const entry: PaletteItem = { url: item.url, name: item.name, scale: 1, objectId: obj.objectId };
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
        say(`${item.name}: ${mismatch}.`);
      }
    } catch (err) {
      console.error(`Loading ${item.name} from ${item.url} failed:`, err);
      say(`Couldn’t load ${item.name} from the server: ${(err as Error).message}`);
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
  }

  // ---------- versions (stored layouts) ----------

  /** Moves every object the version mentions to its stored spot; fetches ones we don't have yet. */
  async function applyVersion(version: VersionV1) {
    if (!currentRoom) return;
    currentVersionId = version.versionId;
    const offset = currentRoom.offset;
    for (const p of version.placements) {
      const layout = fromPlacement(p, offset);
      let obj = objects.get(p.placementId) ?? [...objects.values()].find((o) => o.objectId === p.objectId && !version.placements.some((q) => q.placementId === o.id && q !== p));
      if (!obj) {
        try {
          await addServerObject(await getObject(p.objectId));
        } catch (err) {
          console.warn(`Version ${version.versionId}: object ${p.objectId} unavailable:`, err);
          continue;
        }
        obj = [...objects.values()].find((o) => o.objectId === p.objectId);
        if (!obj) continue;
      }
      physics.moveTo(obj.id, layout.position[0], layout.position[2], layout.rotationY);
    }
    say(`Layout "${version.label}" applied: ${version.placements.length} placements.`);
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
    const known = ['sofa', 'couch', 'chair', 'table', 'desk', 'bed', 'storage', 'shelf', 'lamp', 'television', 'tv', 'plant'];
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
      showScan(roomDemo, 'room-demo.json (fixture)');
      setConnection('offline');
    }
  }

  async function loadManifest() {
    let list: { url: string; name?: string; scale?: number }[];
    try {
      const res = await fetch(OBJECTS_URL);
      if (!res.ok) return; // no manifest is fine
      list = await res.json();
    } catch (err) {
      console.warn('objects.json could not be read:', err);
      return;
    }
    for (const o of list) catalog.push({ url: o.url, name: o.name ?? o.url.split('/').pop()!, scale: o.scale });
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
          const obj: PlacedObject = { id: crypto.randomUUID(), objectId: localId(item.name), name: item.name, loaded };
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

  await loadRoom();
  void loadManifest();
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

  (document.getElementById('colliders') as HTMLInputElement).addEventListener('change', (e) => {
    physics.setDebug((e.target as HTMLInputElement).checked);
  });

  // ---------- loop ----------

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
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
