import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { buildRoomFromScan, type BuiltRoom, type ScannedObject } from './roomScan';
import { ObjectLoader, type LoadedObject } from './objects';
import { createPhysics } from './physics';
import { Interaction } from './interaction';
import { watchRoomScan, uploadRoomScan, supabase } from './sync';
import roomDemo from '../../../fixtures/room-demo.json';

/*
 * Stand inside a RoomPlan room scan, with scanned objects (GLBs) in it.
 *
 * Room: loaded from ?scan=<url>, else the committed fixtures/room-demo.json (RoomCapture v1,
 *   the team contract). Raw RoomPlan CapturedRoom JSON works too. Built at true size, floor at y = 0.
 * Objects: loaded from /objects.json, or dropped onto the page as .glb files.
 *   - Kept at their real-world size (Object Capture exports in meters).
 *   - If a file's name contains a category RoomPlan detected ("chair.glb", "my-sofa.glb"),
 *     the object takes that piece's place and rotation, replacing its grey box.
 *   - Otherwise it's dropped at the nearest free spot in front of you.
 *   - Physics: they land on the floor, can't pass through walls or furniture, stay upright.
 *
 * Works in the Quest Browser (Enter VR) and on a laptop (orbiting view, mouse drag).
 * ?panel=0 hides the panel. Optional Supabase in .env makes new room scans appear live.
 */

const params = new URLSearchParams(location.search);
const SHOW_PANEL = params.get('panel') !== '0';
const SCAN_URL = params.get('scan'); // null: the committed RoomCapture v1 fixture
const OBJECTS_URL = params.get('objects') ?? '/objects.json';

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

// ---------- panel ----------

const panel = document.getElementById('panel')!;
const connection = document.getElementById('connection')!;
const note = document.getElementById('note')!;
panel.hidden = !SHOW_PANEL;
const say = (text: string) => (note.textContent = text);

// ---------- state ----------

interface PlacedObject {
  id: string;
  name: string;        // file or manifest name; matched against detected categories
  loaded: LoadedObject;
  replaces?: ScannedObject;
}

let currentRoom: BuiltRoom | null = null;
let lastScan: Record<string, unknown> | null = null;
const objects = new Map<string, PlacedObject>();
let rise = 1; // 0..1 while the walls rise; objects are placed once it reaches 1
let placementPending = false;

async function start() {
  const physics = await createPhysics(scene);
  const loader = new ObjectLoader(renderer);
  const interaction = new Interaction(renderer, scene, camera, controls, physics);

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
    waiting.visible = false;
    rise = 0;
    placementPending = true; // re-place every object once the walls are up

    const { width, depth } = built.size;
    say(`${source}: ${width.toFixed(1)} × ${depth.toFixed(1)} m, ${built.objects.length} pieces of furniture detected.`);
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
    const lower = name.toLowerCase();
    const taken = new Set([...objects.values()].map((o) => o.replaces?.identifier));
    return currentRoom?.objects.find((o) => lower.includes(o.category.toLowerCase()) && !taken.has(o.identifier)) ?? null;
  }

  function placeAll() {
    for (const obj of objects.values()) obj.replaces = undefined;
    for (const obj of objects.values()) place(obj);
    console.table([...objects.values()].map(describe));
  }

  async function addObject(url: string, name: string, scale?: number) {
    try {
      const loaded = await loader.load(url, scale);
      const obj: PlacedObject = { id: crypto.randomUUID(), name, loaded };
      objects.set(obj.id, obj);
      if (currentRoom && rise >= 1) place(obj); // otherwise placed when the room is ready
    } catch (err) {
      console.error(`Loading ${name} failed:`, err);
      say(`Couldn’t load ${name}: ${(err as Error).message}`);
    }
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

  // ---------- loading ----------

  async function loadScanFile() {
    if (!SCAN_URL) return showScan(roomDemo, 'room-demo.json');
    try {
      const res = await fetch(SCAN_URL);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      showScan(await res.json(), SCAN_URL.split('/').pop() ?? 'Room scan');
    } catch (err) {
      say(`Couldn’t load ${SCAN_URL}: ${(err as Error).message}. Drop a scan file onto the page instead.`);
    }
  }

  async function loadManifest() {
    try {
      const res = await fetch(OBJECTS_URL);
      if (!res.ok) return; // no manifest is fine
      const list = (await res.json()) as { url: string; name?: string; scale?: number }[];
      await Promise.all(list.map((o) => addObject(o.url, o.name ?? o.url.split('/').pop()!, o.scale)));
    } catch (err) {
      console.warn('objects.json could not be read:', err);
    }
  }

  await loadScanFile();
  void loadManifest();
  watchRoomScan((scan) => showScan(scan, 'Live scan'), setConnection);

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
    if (supabase) {
      uploadRoomScan(scan).catch((err) => say(`Showing ${file.name} here; sending it to headsets failed: ${err.message}`));
    }
  }

  document.getElementById('reset')!.addEventListener('click', () => {
    if (lastScan) showScan(lastScan, 'Room reset');
  });

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

function setConnection(status: string) {
  const labels: Record<string, string> = {
    SUBSCRIBED: 'Live: new room scans appear automatically',
    NOT_CONFIGURED: 'Local files only (Supabase not set up)',
    CLOSED: 'Offline',
    CHANNEL_ERROR: 'Connection error: check Realtime is on for rooms',
    TIMED_OUT: 'Connection timed out',
  };
  connection.textContent = labels[status] ?? 'Connecting…';
  connection.dataset.live = String(status === 'SUBSCRIBED');
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
