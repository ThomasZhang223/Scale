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
  /** Added to capture-frame coordinates to get scene coordinates (floor at 0, room centered). */
  offset: [number, number, number];
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
  ceiling: '#f2f0ec',
};

const EXPECTED_SCHEMA_VERSION = 1;

export function buildRoomFromScan(scan: Json): BuiltRoom {
  // Two inputs: RoomCapture v1 (the team contract; fixtures/room-demo.json) carries a
  // schemaVersion and one `openings` list with a `kind`; raw RoomPlan CapturedRoom JSON
  // from the phone has neither and keeps doors and windows in their own lists.
  if ('schemaVersion' in scan && scan.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(`RoomCapture schemaVersion ${scan.schemaVersion}, expected ${EXPECTED_SCHEMA_VERSION} — ask Thomas`);
  }
  const walls = surfaces(scan.walls);
  const listed = surfaces(scan.openings);
  const doors = [...surfaces(scan.doors), ...listed.filter((s) => s.kind === 'door')];
  const windows = [...surfaces(scan.windows), ...listed.filter((s) => s.kind === 'window')];
  const openings = listed.filter((s) => !s.kind || s.kind === 'opening');
  const objects = surfaces(scan.objects);
  const appearance = readAppearance(scan, walls);

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
    // rotateX(-90°) sends the plane's u to +X and its v to -Z, so a photo taken pointing
    // down, held the way the photographer stood, lands the right way up under your feet.
    new THREE.PlaneGeometry(size.width, size.depth).rotateX(-Math.PI / 2),
    surfaceMaterial(appearance.get('floor'), COLORS.floor),
  );
  floor.position.set(center.x, floorY, center.z);
  content.add(floor);

  // RoomPlan has no ceiling category, so a capture only has one when somebody photographed or
  // sampled it. Its height is the tallest wall: there is no other measurement of it.
  const ceiling = appearance.get('ceiling');
  if (ceiling) {
    if (!walls.length) {
      throw new Error('appearance.surfaces has a ceiling but the capture has no walls, so its height is unknown — ask Thomas');
    }
    const height = walls.reduce((h, s) => Math.max(h, s.dims[1]), 0);
    // rotateX(+90°) faces the plane down and sends u to +X, v to +Z — the opposite of the
    // floor on both axes, which is why a ceiling photo shot facing the same way needs 180°.
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size.width, size.depth).rotateX(Math.PI / 2),
      surfaceMaterial(ceiling, COLORS.ceiling),
    );
    mesh.position.set(center.x, floorY + height, center.z);
    content.add(mesh);
  }

  // RoomCapture v1 measures wall thickness; RoomPlan reports 0, so those get a default.
  const wallThickness = (s: Surface) => (s.dims[2] > 0 ? s.dims[2] : WALL_THICKNESS);
  const thickest = walls.reduce((t, s) => Math.max(t, wallThickness(s)), WALL_THICKNESS);
  // Windows and openings are cut out of the wall they sit in, so you see the outdoors through
  // them; doors stay as solid slabs. A window whose wall we can't find keeps the old slab.
  const cut = new Set<Surface>();
  for (const s of walls) {
    const thickness = wallThickness(s);
    const look = appearance.get(s.identifier);
    const photo = surfaceTexture(look);
    // A door or window in a photographed wall is already in the photo, so it is painted, not
    // cut. ExtrudeGeometry's UVs are not the wall rectangle, so a hole would scramble the
    // photo across the whole wall.
    // ceiling: openings are painted while the wall carries a photo. Cutting one needs UVs
    // built for the wall rectangle, and then a second photo of what is behind the hole.
    const holes = photo ? [] : [...windows, ...openings].filter((w) => inWall(w, s, thickness));
    holes.forEach((w) => cut.add(w));
    const wall = holes.length
      ? wallWithHoles(s, thickness, holes)
      : wallSlab(s, thickness, look, photo, center);
    content.add(wall);
    // Physics wants a plain box (it reads BoxGeometry.parameters); the visible wall may have holes.
    const collider = holes.length ? slab(s, thickness, COLORS.wall) : wall;
    collider.userData.collider = 'wall'; // physics turns these into solid walls
    if (collider !== wall) {
      collider.visible = false;
      content.add(collider);
    }
  }
  // Doors lie in the wall's plane; slightly thicker so they show on both sides.
  for (const s of doors) content.add(slab(s, thickest + 0.02, COLORS.door));
  for (const s of windows) content.add(cut.has(s) ? glass(s, wallThickness(walls.find((w) => inWall(s, w, wallThickness(w)))!)) : slab(s, thickest + 0.02, COLORS.window, 0.55));
  for (const s of openings) if (!cut.has(s)) content.add(slab(s, thickest + 0.02, COLORS.opening, 0.35));

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

  return { group, objects: scanned, size, offset: [offset.x, offset.y, offset.z] };
}

// ---------- readers ----------

interface Surface {
  identifier: string;
  kind?: string; // RoomCapture v1 openings: door | window | opening
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
    // RoomCapture v1 uses `id`; RoomPlan's own export uses `identifier`.
    const identifier = typeof item.id === 'string' ? item.id : typeof item.identifier === 'string' ? item.identifier : '';
    const kind = typeof item.kind === 'string' ? item.kind : undefined;
    out.push({ identifier, kind, category: readCategory(item.category), dims, position, quaternion, rotationY });
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

// ---------- appearance ----------
//
// `appearance` is the optional layer in RoomCapture v1 (.claude/contracts.md): one entry per
// surface, keyed by wall id plus the literal "floor" and "ceiling", carrying a sampled colour
// and — when the surface was photographed and rectified — the URL of that photo.
//
// Appearance is NEVER a source of dimensions. Every rectangle drawn here comes from the walls'
// own `dimensions`; the photo is stretched onto it, and where the two disagree the wall wins.

export interface SurfaceAppearance {
  hex?: string | null;
  textureUrl?: string | null;
  /** Quarter turn applied to the photo, 0/90/180/270. Which image edge meets which wall. */
  rotationDeg?: number;
  /** Mirrors the photo across its own vertical axis. The escape hatch, not the normal case. */
  mirrored?: boolean;
}

const QUARTER_TURNS = [0, 90, 180, 270];
const textureLoader = new THREE.TextureLoader();

function readAppearance(scan: Json, walls: Surface[]): Map<string, SurfaceAppearance> {
  const out = new Map<string, SurfaceAppearance>();
  const surfaces = (scan.appearance as { surfaces?: Record<string, SurfaceAppearance> } | undefined)?.surfaces;
  if (!surfaces) return out;
  const known = new Set<string>([...walls.map((w) => w.identifier), 'floor', 'ceiling']);
  for (const [key, surface] of Object.entries(surfaces)) {
    // A key that names no wall in this capture means the appearance layer and the shell were
    // written against different rooms. Say which key, rather than drawing five of six surfaces.
    if (!known.has(key)) {
      throw new Error(`appearance.surfaces has "${key}", which is neither a wall id in this capture nor "floor" or "ceiling" — ask Thomas`);
    }
    const turn = surface.rotationDeg ?? 0;
    if (!QUARTER_TURNS.includes(turn)) {
      throw new Error(`appearance.surfaces["${key}"].rotationDeg is ${turn}; a surface photo turns by 0, 90, 180 or 270 only`);
    }
    out.set(key, surface);
  }
  return out;
}

/**
 * One rectified photo, mapped to fill its surface exactly once.
 *
 * The photo is a four-point transform of the surface rectangle onto the WHOLE image, so the
 * image aspect is not the surface aspect. Stretching it to UV 0..1 is what undoes the
 * transform — it is the correction, not a distortion. Never tiled, never aspect-fitted.
 */
function surfaceTexture(look: SurfaceAppearance | undefined): THREE.Texture | null {
  if (!look?.textureUrl) return null;
  const texture = textureLoader.load(look.textureUrl);
  texture.colorSpace = THREE.SRGBColorSpace; // a photo is sRGB; without this the room goes pale
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.center.set(0.5, 0.5); // turn about the middle, so the photo still covers the rectangle
  texture.rotation = THREE.MathUtils.degToRad(look.rotationDeg ?? 0);
  if (look.mirrored) texture.repeat.x = -1;
  texture.anisotropy = 4; // the floor is seen at a grazing angle from standing height
  return texture;
}

/** A whole surface: its photo when it has one, its sampled colour when it does not. */
function surfaceMaterial(look: SurfaceAppearance | undefined, fallback: string): THREE.MeshStandardMaterial {
  const map = surfaceTexture(look);
  return new THREE.MeshStandardMaterial(map ? { map } : { color: look?.hex ?? fallback });
}

/**
 * Which BoxGeometry face of this wall looks into the room: 4 is +Z, 5 is -Z.
 *
 * BoxGeometry's own UVs run left to right for a viewer standing OUTSIDE the face they are
 * looking at, and someone inside the room is outside the wall's inward face. So the photo
 * reads un-mirrored on either index, and picking the wrong one hides it inside the wall.
 */
function inwardFace(wall: Surface, roomCenter: THREE.Vector3): number {
  const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(wall.quaternion);
  return outward.dot(roomCenter.clone().sub(wall.position)) > 0 ? 4 : 5;
}

// ---------- geometry ----------

/** A wall slab whose inward face carries the wall's photo; every other face stays plain. */
function wallSlab(
  s: Surface,
  thickness: number,
  look: SurfaceAppearance | undefined,
  photo: THREE.Texture | null,
  roomCenter: THREE.Vector3,
): THREE.Mesh {
  const plain = new THREE.MeshStandardMaterial({ color: look?.hex ?? COLORS.wall });
  let material: THREE.Material | THREE.Material[] = plain;
  if (photo) {
    const faces: THREE.Material[] = [plain, plain, plain, plain, plain, plain];
    faces[inwardFace(s, roomCenter)] = new THREE.MeshStandardMaterial({ map: photo });
    material = faces;
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.dims[0], s.dims[1], thickness), material);
  mesh.position.copy(s.position);
  mesh.quaternion.copy(s.quaternion);
  return mesh;
}

function slab(s: Surface, thickness: number, color: string, opacity = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(s.dims[0], s.dims[1], thickness),
    new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity }),
  );
  mesh.position.copy(s.position);
  mesh.quaternion.copy(s.quaternion);
  return mesh;
}

/** Is this opening in the plane of that wall (its centre within the wall's slab)? */
function inWall(opening: Surface, wall: Surface, thickness: number): boolean {
  const local = wallLocal(opening, wall);
  return Math.abs(local.z) <= thickness / 2 + 0.05
    && Math.abs(local.x) <= wall.dims[0] / 2 + 0.05
    && Math.abs(local.y) <= wall.dims[1] / 2 + 0.05;
}

/** An opening's centre in the wall's own frame (x along the wall, y up, z through it). */
function wallLocal(opening: Surface, wall: Surface): THREE.Vector3 {
  return opening.position.clone().sub(wall.position).applyQuaternion(wall.quaternion.clone().invert());
}

/** The wall as an extruded rectangle with one rectangular hole per opening in it. */
function wallWithHoles(wall: Surface, thickness: number, holes: Surface[]): THREE.Mesh {
  const [w, h] = wall.dims;
  const shape = new THREE.Shape([
    new THREE.Vector2(-w / 2, -h / 2), new THREE.Vector2(w / 2, -h / 2),
    new THREE.Vector2(w / 2, h / 2), new THREE.Vector2(-w / 2, h / 2),
  ]);
  for (const o of holes) {
    const c = wallLocal(o, wall);
    const hw = Math.min(o.dims[0] / 2, w / 2 - 0.01), hh = Math.min(o.dims[1] / 2, h / 2 - 0.01);
    const path = new THREE.Path([
      new THREE.Vector2(c.x - hw, c.y - hh), new THREE.Vector2(c.x + hw, c.y - hh),
      new THREE.Vector2(c.x + hw, c.y + hh), new THREE.Vector2(c.x - hw, c.y + hh),
    ]);
    shape.holes.push(path);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false }).translate(0, 0, -thickness / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: COLORS.wall }));
  mesh.position.copy(wall.position);
  mesh.quaternion.copy(wall.quaternion);
  return mesh;
}

/** A pane of glass in a window hole: mostly see-through with a faint blue tint and a thin frame. */
function glass(s: Surface, wallThickness: number): THREE.Group {
  const g = new THREE.Group();
  const pane = new THREE.Mesh(
    new THREE.BoxGeometry(s.dims[0], s.dims[1], 0.012),
    new THREE.MeshPhysicalMaterial({
      color: COLORS.window, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  g.add(pane);
  const frameDepth = wallThickness + 0.02, bar = 0.04;
  const frame = new THREE.MeshStandardMaterial({ color: '#e8e8e6' });
  const [w, h] = s.dims;
  for (const [bw, bh, x, y] of [[w, bar, 0, h / 2 - bar / 2], [w, bar, 0, -h / 2 + bar / 2], [bar, h, w / 2 - bar / 2, 0], [bar, h, -w / 2 + bar / 2, 0], [bar, h, 0, 0]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, frameDepth), frame);
    m.position.set(x, y, 0);
    g.add(m);
  }
  g.position.copy(s.position);
  g.quaternion.copy(s.quaternion);
  return g;
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
