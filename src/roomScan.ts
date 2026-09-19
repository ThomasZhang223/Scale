import * as THREE from 'three';

/*
 * RoomPlan's CapturedRoom, encoded by Swift's JSONEncoder, is loose about shape:
 * transforms show up as 16 flat numbers or 4 column arrays, dimensions as an array
 * (sometimes with a trailing w) or an {x,y,z} object, and category enums as a plain
 * string or a single-key object. The parse* helpers below absorb that variance so
 * the rest of this file only ever deals with a Matrix4 and a plain [x, y, z].
 */

export interface RoomObjectData {
  category: string;
  dimensions: [number, number, number];
  /** Bottom-center of the object, in the recentered scene (meters). */
  position: [number, number, number];
  /** Yaw around Y, in radians. */
  rotation: number;
}

export interface BuildResult {
  group: THREE.Group;
  objects: RoomObjectData[];
  size: { width: number; depth: number };
}

interface Surface {
  category: string;
  dimensions: [number, number, number];
  matrix: THREE.Matrix4;
}

function parseTransform(raw: unknown): THREE.Matrix4 {
  let flat: number[];
  if (Array.isArray(raw) && raw.length === 16 && typeof raw[0] === 'number') {
    flat = raw as number[];
  } else if (Array.isArray(raw) && raw.length === 4 && Array.isArray(raw[0])) {
    flat = (raw as number[][]).flat();
  } else {
    throw new Error(`Unrecognized transform: ${JSON.stringify(raw)}`);
  }
  if (flat.length !== 16 || flat.some((n) => typeof n !== 'number' || Number.isNaN(n))) {
    throw new Error(`Transform did not resolve to 16 numbers: ${JSON.stringify(raw)}`);
  }
  return new THREE.Matrix4().fromArray(flat);
}

function parseDimensions(raw: unknown): [number, number, number] {
  if (Array.isArray(raw) && raw.length >= 3) {
    return [raw[0], raw[1], raw[2]];
  }
  if (raw && typeof raw === 'object' && 'x' in raw && 'y' in raw && 'z' in raw) {
    const d = raw as { x: number; y: number; z: number };
    return [d.x, d.y, d.z];
  }
  throw new Error(`Unrecognized dimensions: ${JSON.stringify(raw)}`);
}

function parseCategory(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const [key] = Object.keys(raw);
    if (key) return key;
  }
  throw new Error(`Unrecognized category: ${JSON.stringify(raw)}`);
}

function readSurfaces(json: Record<string, unknown>, key: string): Surface[] {
  const raw = json[key];
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    category: parseCategory((item as Record<string, unknown>).category),
    dimensions: parseDimensions((item as Record<string, unknown>).dimensions),
    matrix: parseTransform((item as Record<string, unknown>).transform),
  }));
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

function positionOf(s: Surface): THREE.Vector3 {
  s.matrix.decompose(_pos, _quat, _scale);
  return _pos.clone();
}

function bottomYOf(s: Surface): number {
  return positionOf(s).y - s.dimensions[1] / 2;
}

/** The two endpoints of a flat surface's centerline, in whatever space its matrix is in. */
function endpointsOf(s: Surface): [THREE.Vector3, THREE.Vector3] {
  const half = s.dimensions[0] / 2;
  const a = new THREE.Vector3(half, 0, 0).applyMatrix4(s.matrix);
  const b = new THREE.Vector3(-half, 0, 0).applyMatrix4(s.matrix);
  return [a, b];
}

interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function footprintFromWalls(walls: Surface[]): Footprint {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const wall of walls) {
    for (const p of endpointsOf(wall)) {
      xs.push(p.x);
      zs.push(p.z);
    }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/** No walls: fall back to the bounding box of the objects' centers. Rare, approximate. */
function footprintFromObjects(objects: Surface[]): Footprint {
  const xs = objects.map((o) => positionOf(o).x);
  const zs = objects.map((o) => positionOf(o).z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

const WALL_THICKNESS = 0.1;
const OPENING_THICKNESS = 0.12; // slightly more than a wall's, so it pokes through cleanly

const COLORS = {
  floor: 0x2b2f36,
  wall: 0xcfd8e3,
  door: 0x8a5a44,
  window: 0x8fd6ff,
  opening: 0xffd27a,
  object: 0x9aa5b1,
  edge: 0xe8edf2,
};

function boxMesh(dims: [number, number, number], matrix: THREE.Matrix4, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), material);
  matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  return mesh;
}

function flatMaterial(color: number, opacity = 1): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
  });
}

export function buildRoomFromScan(json: unknown): BuildResult {
  if (!json || typeof json !== 'object') throw new Error('Room scan JSON must be an object');
  const data = json as Record<string, unknown>;

  const walls = readSurfaces(data, 'walls');
  const doors = readSurfaces(data, 'doors');
  const windows = readSurfaces(data, 'windows');
  const openings = readSurfaces(data, 'openings');
  const objects = readSurfaces(data, 'objects');

  const floorY = walls.length
    ? Math.min(...walls.map(bottomYOf))
    : objects.length
      ? Math.min(...objects.map(bottomYOf))
      : 0;

  const footprint = walls.length ? footprintFromWalls(walls) : objects.length ? footprintFromObjects(objects) : { minX: -2, maxX: 2, minZ: -2, maxZ: 2 };
  const center = new THREE.Vector3((footprint.minX + footprint.maxX) / 2, floorY, (footprint.minZ + footprint.maxZ) / 2);

  const group = new THREE.Group();
  group.position.set(-center.x, -floorY, -center.z);

  const width = footprint.maxX - footprint.minX;
  const depth = footprint.maxZ - footprint.minZ;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), flatMaterial(COLORS.floor));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(center.x, floorY, center.z);
  group.add(floor);

  const wallMaterial = flatMaterial(COLORS.wall);
  for (const wall of walls) {
    group.add(boxMesh([wall.dimensions[0], wall.dimensions[1], WALL_THICKNESS], wall.matrix, wallMaterial));
  }

  const doorMaterial = flatMaterial(COLORS.door);
  for (const door of doors) {
    group.add(boxMesh([door.dimensions[0], door.dimensions[1], OPENING_THICKNESS], door.matrix, doorMaterial));
  }

  const windowMaterial = flatMaterial(COLORS.window, 0.35);
  for (const win of windows) {
    group.add(boxMesh([win.dimensions[0], win.dimensions[1], OPENING_THICKNESS], win.matrix, windowMaterial));
  }

  const openingMaterial = flatMaterial(COLORS.opening, 0.3);
  for (const opening of openings) {
    group.add(boxMesh([opening.dimensions[0], opening.dimensions[1], OPENING_THICKNESS], opening.matrix, openingMaterial));
  }

  const objectMaterial = flatMaterial(COLORS.object, 0.35);
  const edgeMaterial = new THREE.LineBasicMaterial({ color: COLORS.edge });
  const objectData: RoomObjectData[] = [];

  for (const obj of objects) {
    const mesh = boxMesh(obj.dimensions, obj.matrix, objectMaterial);
    group.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterial);
    mesh.add(edges);

    const worldPos = mesh.position.clone().add(group.position);
    const yaw = new THREE.Euler().setFromQuaternion(mesh.quaternion, 'YXZ').y;
    objectData.push({
      category: obj.category,
      dimensions: obj.dimensions,
      position: [worldPos.x, worldPos.y - obj.dimensions[1] / 2, worldPos.z],
      rotation: yaw,
    });
  }

  return { group, objects: objectData, size: { width, depth } };
}
