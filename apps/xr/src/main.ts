import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { buildRoomFromScan, type BuiltRoom, type ScannedObject } from './roomScan';
import { ObjectLoader, type LoadedObject } from './objects';
import { createPhysics } from './physics';
import { Interaction } from './interaction';
import {
  getRoom, getObject, getVersion, postVersion, objectToItem, boundsMismatch, watchRoom, postFit, STUB,
  type ObjectV1, type VersionV1,
} from './api';
import { FitOverlay, type FitReport } from './fit';
import { fromPlacement, layoutToVersion, type PlacedLayout } from './placements';
import { Palette, type PaletteItem } from './palette';
import { matchDetected } from './placement';
import roomDemo from '../../../fixtures/room-demo.json';

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
const ROOM_ID = params.get('room') ?? import.meta.env.VITE_ROOM_ID ?? roomDemo.roomId;
const OBJECT_IDS = params.get('object')?.split(',').filter(Boolean) ?? [];
const VERSION_ID = params.get('version'); // a stored layout to apply after the room loads

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
const SPECTATOR_POSITION = new THREE.Vector3(4, 5, 5.5);
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
const objects = new Map<string, PlacedObject>();
const catalog: PaletteItem[] = []; // everything in objects.json, placed or not
let rise = 1; // 0..1 while the walls rise; objects are placed once it reaches 1
let placementPending = false;

async function start() {
  const physics = await createPhysics(scene);
  const loader = new ObjectLoader(renderer);
  const palette = new Palette();
  const interaction = new Interaction(renderer, scene, camera, controls, physics, palette, spawn, onAction, layoutChanged);
  const showPalette = () => palette.setItems([...catalog, ...PALETTE_ACTIONS]);
  showPalette();

  function onAction(action: string) {
    if (action === 'reset' && lastScan) showScan(lastScan, 'Room reset');
    if (action === 'clear') clearObjects();
  }

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
    fitOverlay.show(report);
    if (report.ok || !report.violations.length) return;
    const blocks = report.violations.filter((v) => v.severity === 'block').length;
    say(`Fit: ${report.violations.map((v) => v.message).join('; ')} (${blocks} blocking).`);
  }

  /** Asks the server to check the current layout; under the stub, that's the door-swing fixture. */
  async function checkFit() {
    if (SCAN_URL) return;
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
  if (!SCAN_URL) {
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
    }
    interaction.update(dt);
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
