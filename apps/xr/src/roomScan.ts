import * as THREE from 'three';

/**
 * Turns RoomPlan's CapturedRoom JSON into a three.js room.
 *
 * RoomPlan describes a room as numbers, not a mesh: every wall, door, window and
 * piece of furniture has `dimensions` (meters) and a `transform` (4x4 matrix,
 * column-major, like three.js). Walls are flat (depth 0) with their center at the
 * transform; objects are boxes centered at the transform.
 *
 * Two things the phone can't know and we fix here:
 *  1. ARKit's origin is wherever the phone was when scanning started, so the floor
 *     sits around y = -1.4 and the room is off-center. We shift everything so the
 *     floor is y = 0 and the room is centered on the origin (our shared convention).
 *  2. Swift's JSON encoding of matrices and enums varies in shape, so the readers
 *     below accept each form we might see. Log one real scan to confirm.
 */

export interface ScannedObject {
  identifier: string;
  category: string;
  dimensions: [number, number, number];  // w, h, d
  position: [number, number, number];    // bottom-center, after recentering
  rotationY: number;
  /** The box drawn for this object. Origin at its bottom-center, so a model can take its place. */
  node: THREE.Group;
}

export interface BuiltRoom {
  group: THREE.Group;
  objects: ScannedObject[];
  size: { width: number; depth: number };
}

type Json = Record<string, unknown>;

const WALL_THICKNESS = 0.1;
const COLORS = {
  wall: '#e8e4dc',
  floor: '#b9a88f',
  door: '#8a6a4f',
  window: '#9fd3ff',
  opening: '#cfc8bb',
  object: '#9aa5b1',
};

export function buildRoomFromScan(scan: Json): BuiltRoom {
  const walls = surfaces(scan.walls);
  const doors = surfaces(scan.doors);
  const windows = surfaces(scan.windows);
  const openings = surfaces(scan.openings);
  const objects = surfaces(scan.objects);

  // ---- find the floor and the center, so we can recenter ----
  const footprint = new THREE.Box3();
  let floorY = Infinity;
  for (const s of walls) {
    floorY = Math.min(floorY, s.position.y - s.dims[1] / 2);
    for (const corner of wallEnds(s)) footprint.expandByPoint(corner);
  }
  if (!walls.length) {
    for (const s of objects) {
      floorY = Math.min(floorY, s.position.y - s.dims[1] / 2);
      footprint.expandByPoint(s.position);
    }
  }
  if (!Number.isFinite(floorY)) floorY = 0;
  const center = footprint.isEmpty() ? new THREE.Vector3() : footprint.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(-center.x, -floorY, -center.z);

  const group = new THREE.Group();
  group.name = 'scanned-room';
  const content = new THREE.Group();
  content.position.copy(offset);
  group.add(content);

  // ---- structure ----
  const size = footprint.isEmpty()
    ? { width: 6, depth: 6 }
    : { width: footprint.max.x - footprint.min.x, depth: footprint.max.z - footprint.min.z };

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size.width, size.depth).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: COLORS.floor }),
  );
  floor.position.set(center.x, floorY, center.z);
  content.add(floor);

  for (const s of walls) {
    const wall = slab(s, WALL_THICKNESS, COLORS.wall);
    wall.userData.collider = 'wall'; // physics turns these into solid walls
    content.add(wall);
  }
  // Doors and windows lie in the wall's plane; slightly thicker so they show on both sides.
  for (const s of doors) content.add(slab(s, WALL_THICKNESS + 0.02, COLORS.door));
  for (const s of windows) content.add(slab(s, WALL_THICKNESS + 0.02, COLORS.window, 0.55));
  for (const s of openings) content.add(slab(s, WALL_THICKNESS + 0.02, COLORS.opening, 0.35));

  // ---- furniture: returned as data, drawn as reference boxes ----
  // Boxes live directly in `group` (already-recentered space) with their origin at the
  // bottom-center, which is also where physics colliders and replacement models go.
  const scanned: ScannedObject[] = objects.map((s, i) => {
    const position: [number, number, number] = [
      s.position.x + offset.x,
      s.position.y - s.dims[1] / 2 + offset.y,
      s.position.z + offset.z,
    ];
    const node = objectBox(s.dims, s.category);
    node.position.set(...position);
    node.rotation.y = s.rotationY;
    group.add(node);
    return {
      identifier: s.identifier || `${s.category}-${i}`,
      category: s.category,
      dimensions: s.dims,
      position,
      rotationY: s.rotationY,
      node,
    };
  });

  return { group, objects: scanned, size };
}

// ---------- readers ----------

interface Surface {
  identifier: string;
  category: string;
  dims: [number, number, number];
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  rotationY: number;
}

function surfaces(list: unknown): Surface[] {
  if (!Array.isArray(list)) return [];
  const out: Surface[] = [];
  for (const item of list as Json[]) {
    const dims = readVec3(item.dimensions);
    const matrix = readMatrix(item.transform);
    if (!dims || !matrix) continue;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    matrix.decompose(position, quaternion, new THREE.Vector3());
    const rotationY = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ').y;
    const identifier = typeof item.identifier === 'string' ? item.identifier : '';
    out.push({ identifier, category: readCategory(item.category), dims, position, quaternion, rotationY });
  }
  return out;
}

/** Accepts [x, y, z], [x, y, z, w] or {x, y, z}. */
function readVec3(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]), Number(v[1]), Number(v[2])];
  if (v && typeof v === 'object' && 'x' in v) {
    const o = v as { x: number; y: number; z: number };
    return [o.x, o.y, o.z];
  }
  return null;
}

/** Accepts 16 numbers (column-major) or 4 columns of 4 numbers. Both match three.js order. */
function readMatrix(t: unknown): THREE.Matrix4 | null {
  if (!Array.isArray(t)) return null;
  const flat = (t.length === 4 && Array.isArray(t[0]) ? (t as number[][]).flat() : t) as number[];
  if (flat.length !== 16 || flat.some((n) => typeof n !== 'number')) return null;
  return new THREE.Matrix4().fromArray(flat);
}

/** Swift enums arrive as "chair" or as {"chair": {}} depending on the encoder. */
function readCategory(c: unknown): string {
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') return Object.keys(c)[0] ?? 'unknown';
  return 'unknown';
}

// ---------- geometry ----------

function slab(s: Surface, thickness: number, color: string, opacity = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(s.dims[0], s.dims[1], thickness),
    new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity }),
  );
  mesh.position.copy(s.position);
  mesh.quaternion.copy(s.quaternion);
  return mesh;
}

function objectBox(dims: [number, number, number], category: string): THREE.Group {
  const geo = new THREE.BoxGeometry(...dims).translate(0, dims[1] / 2, 0);
  const box = new THREE.Group();
  box.add(
    new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: COLORS.object, transparent: true, opacity: 0.35 })),
    new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: COLORS.object })),
  );
  box.userData.category = category;
  return box;
}

/** A wall's two bottom ends, for measuring the room's footprint. */
function wallEnds(s: Surface): THREE.Vector3[] {
  const half = new THREE.Vector3(s.dims[0] / 2, 0, 0).applyQuaternion(s.quaternion);
  return [s.position.clone().add(half), s.position.clone().sub(half)];
}
