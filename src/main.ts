import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { buildRoomFromScan } from './roomScan';

/*
 * Smoke test: load a RoomPlan CapturedRoom JSON and stand inside it.
 *
 * On load, the page reads a CapturedRoom JSON file and builds the room:
 *  - public/room-scan.json by default (replace it with your own scan), or
 *  - any URL passed as ?scan=https://.../scan.json
 *
 * The same page runs in two places:
 *  - Quest Browser: press "Enter VR" and stand inside the scanned room.
 *  - A laptop: an orbiting spectator view (add ?panel=0 to hide the status text).
 */

const params = new URLSearchParams(location.search);
const SHOW_NOTE = params.get('panel') !== '0';
const SCAN_URL = params.get('scan') ?? '/room-scan.json';

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

// In VR the headset drives the camera; this position is only the laptop's view.
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

// ---------- the room ----------

// Before any scan: a floor grid, so the headset isn't a void and the scale is readable.
const waiting = new THREE.GridHelper(6, 12, 0x5fb3ff, 0x39424c);
scene.add(waiting);

const room = new THREE.Group();
scene.add(room);

// The room rises out of the floor when a scan arrives: a small moment that makes
// "it just came from the phone" obvious to anyone watching.
let rise = 1;

function showScan(scan: unknown, source = 'Room scan') {
  let built;
  try {
    built = buildRoomFromScan(scan);
  } catch (err) {
    console.error('The room scan could not be built:', err, scan);
    say(`${source} couldn't be built: ${(err as Error).message}. Check the console for details.`);
    return;
  }
  room.clear();
  room.add(built.group);
  waiting.visible = false;
  rise = 0;

  const { width, depth } = built.size;
  say(`${source}: ${width.toFixed(1)} × ${depth.toFixed(1)} m, ${built.objects.length} pieces of furniture.`);
  console.table(
    built.objects.map((o) => ({
      category: o.category,
      size: o.dimensions.map((n) => n.toFixed(2)).join(' × '),
      position: o.position.map((n) => n.toFixed(2)).join(', '),
      rotationDeg: ((o.rotation * 180) / Math.PI).toFixed(0),
    })),
  );
}

async function loadScanFile() {
  try {
    const res = await fetch(SCAN_URL);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    showScan(await res.json(), SCAN_URL.split('/').pop() ?? 'Room scan');
  } catch (err) {
    say(`Couldn't load ${SCAN_URL}: ${(err as Error).message}.`);
  }
}
void loadScanFile();

// ---------- status text (laptop only; the headset doesn't draw page elements in VR) ----------

const note = document.getElementById('note')!;
note.hidden = !SHOW_NOTE;

function say(text: string) {
  note.textContent = text;
}

// ---------- loop ----------

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (rise < 1) {
    rise = Math.min(1, rise + dt * 1.4);
    room.scale.y = Math.max(0.001, 1 - Math.pow(1 - rise, 3));
  }
  if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
