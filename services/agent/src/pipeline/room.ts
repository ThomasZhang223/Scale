import type { PlacementV1, RoomFacts, RoomState, Side, SolverObject, SolverRequest } from './types.ts';

/*
 * The room, three ways: the capture JSON (RoomCapture v1 or raw RoomPlan), the scene the
 * headset shows (metres, floor at 0, footprint centred; scene = capture + offset), and the
 * solver frame (integer cm, main walls on the axes, rotated by -theta). This module is the
 * only place the Worker does geometry. Conventions: apps/xr/docs/agent/08_PROTOCOL.md.
 */

const WALL_THICKNESS = 0.1;
const DEG = 180 / Math.PI;

export interface Wall {
  id: string;
  center: [number, number]; // scene, floor
  along: [number, number]; // unit vector down the wall
  length: number;
  thickness: number;
  side: Side;
  faceOffset: number; // inner face position along the axis the wall spans
}

export interface Opening {
  id: string;
  kind: 'door' | 'window' | 'opening';
  wallId: string;
  center: [number, number]; // scene, on the wall
  width: number;
}

export interface RoomGeometry {
  offset: [number, number, number];
  thetaDeg: number;
  walls: Wall[];
  doors: Opening[];
  windows: Opening[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }; // solver frame, cm
  rectangular: boolean;
  notes: string[];
}

// ---------- reading the capture JSON ----------

type Json = Record<string, unknown>;

function flatMatrix(t: unknown): number[] | null {
  if (!Array.isArray(t)) return null;
  const flat = (t.length === 4 && Array.isArray(t[0]) ? (t as number[][]).flat() : t) as number[];
  return flat.length === 16 && flat.every((n) => typeof n === 'number') ? flat : null;
}

function readDims(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]), Number(v[1]), Number(v[2])];
  if (v && typeof v === 'object' && 'x' in v) {
    const o = v as { x: number; y: number; z: number };
    return [o.x, o.y, o.z];
  }
  return null;
}

interface Surface {
  id: string;
  kind: string;
  wallId?: string;
  dims: [number, number, number];
  pos: [number, number, number];
  along: [number, number];
}

function surfaces(list: unknown, defaultKind: string): Surface[] {
  if (!Array.isArray(list)) return [];
  const out: Surface[] = [];
  for (const item of list as Json[]) {
    const m = flatMatrix(item.transform);
    const dims = readDims(item.dimensions);
    if (!m || !dims) continue;
    const ax = m[0], az = m[2];
    const n = Math.hypot(ax, az) || 1;
    out.push({
      id: String(item.id ?? item.identifier ?? ''),
      kind: typeof item.kind === 'string' ? item.kind : defaultKind,
      wallId: typeof item.wallId === 'string' ? item.wallId : undefined,
      dims,
      pos: [m[12], m[13], m[14]],
      along: [ax / n, az / n],
    });
  }
  return out;
}

export function rotate(x: number, z: number, deg: number): [number, number] {
  const c = Math.cos(deg / DEG), s = Math.sin(deg / DEG);
  return [x * c + z * s, -x * s + z * c]; // three.js rotation.y sense: +90 takes +X to -Z
}

/** Everything the agent needs to know about the room, from either capture format. */
export function readRoom(capture: Json): RoomGeometry {
  const notes: string[] = [];
  const walls = surfaces(capture.walls, 'wall');
  if (!walls.length) throw new Error('the room has no walls');
  const listed = surfaces(capture.openings, 'opening');
  const doors = [...surfaces(capture.doors, 'door'), ...listed.filter((s) => s.kind === 'door')];
  const windows = [...surfaces(capture.windows, 'window'), ...listed.filter((s) => s.kind === 'window')];

  // Recenter exactly like the headset: floor to 0, footprint (wall ends) centred.
  let floorY = Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const w of walls) {
    floorY = Math.min(floorY, w.pos[1] - w.dims[1] / 2);
    for (const s of [-1, 1]) {
      const x = w.pos[0] + w.along[0] * s * w.dims[0] / 2;
      const z = w.pos[2] + w.along[1] * s * w.dims[0] / 2;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  const tidy = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
  const offset: [number, number, number] = [tidy(-(minX + maxX) / 2), tidy(-floorY), tidy(-(minZ + maxZ) / 2)];

  // theta: the longest wall's angle, reduced to -45..45.
  const longest = walls.reduce((a, b) => (b.dims[0] > a.dims[0] ? b : a));
  let theta = Math.atan2(-longest.along[1], longest.along[0]) * DEG; // angle in the contract's sense
  theta = ((theta % 90) + 90) % 90;
  if (theta > 45) theta -= 90;
  if (Math.abs(theta) < 0.5) theta = 0;
  else notes.push(`Room is rotated ${theta.toFixed(0)}°: solving in wall-aligned space.`);

  const toSolver = (x: number, z: number): [number, number] => rotate(x + offset[0], z + offset[2], -theta);

  const geoWalls: Wall[] = walls.map((w, i) => {
    const center = toSolver(w.pos[0], w.pos[2]);
    const [ax, az] = rotate(w.along[0], w.along[1], -theta);
    const thickness = w.dims[2] > 0 ? w.dims[2] : WALL_THICKNESS;
    // Normal pointing toward the room centre (origin) decides the side.
    const nx0 = -az, nz0 = ax;
    const dot = nx0 * -center[0] + nz0 * -center[1];
    const [nx, nz] = dot >= 0 ? [nx0, nz0] : [-nx0, -nz0];
    let side: Side;
    if (Math.abs(nz) >= Math.abs(nx)) side = nz > 0 ? 'north' : 'south';
    else side = nx > 0 ? 'west' : 'east';
    const faceOffset = side === 'north' || side === 'south' ? center[1] + nz * thickness / 2 : center[0] + nx * thickness / 2;
    return { id: w.id || `wall-${i}`, center, along: [ax, az], length: w.dims[0], thickness, side, faceOffset };
  });

  // Short, stable ids by side (n1, s1, e1, w1; d1; win1): the planner reads them, and they
  // don't depend on which capture format the room came in.
  const counts: Record<string, number> = {};
  const originalWallIds = geoWalls.map((w) => w.id);
  for (const w of geoWalls) {
    const letter = w.side[0];
    counts[letter] = (counts[letter] ?? 0) + 1;
    w.id = `${letter}${counts[letter]}`;
  }
  const renamedWall = (original: string) => {
    const i = originalWallIds.indexOf(original);
    return i >= 0 ? geoWalls[i].id : undefined;
  };

  const face = (side: Side, pick: (a: number, b: number) => number, fallback: number) => {
    const c = geoWalls.filter((w) => w.side === side);
    return c.length ? c.map((w) => w.faceOffset).reduce(pick) : fallback;
  };
  const rectangular = walls.length === 4 && (['north', 'south', 'east', 'west'] as Side[]).every((s) => geoWalls.some((w) => w.side === s));
  if (!rectangular) notes.push(`Walls aren't a plain rectangle (${walls.length} walls): using the main axis-aligned area.`);
  const bounds = {
    minX: Math.round(face('west', Math.max, minX + offset[0]) * 100),
    maxX: Math.round(face('east', Math.min, maxX + offset[0]) * 100),
    minZ: Math.round(face('north', Math.max, minZ + offset[2]) * 100),
    maxZ: Math.round(face('south', Math.min, maxZ + offset[2]) * 100),
  };

  const nearestWall = (s: Surface) => {
    const c = toSolver(s.pos[0], s.pos[2]);
    return geoWalls.reduce((best, w) => (Math.hypot(w.center[0] - c[0], w.center[1] - c[1]) < Math.hypot(best.center[0] - c[0], best.center[1] - c[1]) ? w : best));
  };
  const opening = (s: Surface, kind: Opening['kind'], id: string): Opening => {
    const linked = s.wallId ? renamedWall(s.wallId) : undefined;
    const wall = (linked ? geoWalls.find((w) => w.id === linked) : undefined) ?? nearestWall(s);
    return { id, kind, wallId: wall.id, center: toSolver(s.pos[0], s.pos[2]), width: s.dims[0] };
  };
  return {
    offset,
    thetaDeg: theta,
    walls: geoWalls,
    doors: doors.map((d, i) => opening(d, 'door', `d${i + 1}`)),
    windows: windows.map((w, i) => opening(w, 'window', `win${i + 1}`)),
    bounds,
    rectangular,
    notes,
  };
}

// ---------- poses ----------

export const FACING: Side[] = ['south', 'east', 'north', 'west']; // front at 0°, 90°, 180°, 270°

export function placementToSolver(p: PlacementV1, geo: RoomGeometry): { xCm: number; zCm: number; rotDeg: number; exactDeg: number } {
  const [x, z] = rotate(p.p[0] + geo.offset[0], p.p[2] + geo.offset[2], -geo.thetaDeg);
  const exactDeg = ((p.yawDeg - geo.thetaDeg) % 360 + 360) % 360;
  const rotDeg = (Math.round(exactDeg / 90) * 90) % 360;
  return { xCm: Math.round(x * 100) + 0, zCm: Math.round(z * 100) + 0, rotDeg, exactDeg };
}

export function solverToPlacement(
  original: PlacementV1,
  input: { xCm: number; zCm: number; rotDeg: number },
  output: { xCm: number; zCm: number; rotDeg: number },
  geo: RoomGeometry,
): PlacementV1 {
  // Unmoved objects keep their exact original pose: no 1 cm jumps, no snapping odd angles.
  if (input.xCm === output.xCm && input.zCm === output.zCm && input.rotDeg === output.rotDeg) return original;
  const [sx, sz] = rotate(output.xCm / 100, output.zCm / 100, geo.thetaDeg);
  const yawDeg = (((output.rotDeg + geo.thetaDeg) % 360) + 360) % 360;
  return {
    ...original,
    p: [round4(sx - geo.offset[0]), original.p[1], round4(sz - geo.offset[2])],
    yawDeg: round4(yawDeg),
  };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4 + 0;

// ---------- room facts (what the planner reads) and the solver room ----------

export function wallSide(geo: RoomGeometry, wallId: string): Side {
  return geo.walls.find((w) => w.id === wallId)?.side ?? 'north';
}

export function solverRoom(geo: RoomGeometry, doorKeepOutGrowCm = 0): SolverRequest['room'] {
  const doors = geo.doors.map((d) => {
    const side = wallSide(geo, d.wallId);
    const cx = Math.round(d.center[0] * 100), cz = Math.round(d.center[1] * 100);
    const half = Math.round(d.width * 50);
    const depth = Math.round(d.width * 100) + doorKeepOutGrowCm;
    const b = geo.bounds;
    const keepOut =
      side === 'south' ? { minX: cx - half, maxX: cx + half, minZ: b.maxZ - depth, maxZ: b.maxZ }
      : side === 'north' ? { minX: cx - half, maxX: cx + half, minZ: b.minZ, maxZ: b.minZ + depth }
      : side === 'east' ? { minX: b.maxX - depth, maxX: b.maxX, minZ: cz - half, maxZ: cz + half }
      : { minX: b.minX, maxX: b.minX + depth, minZ: cz - half, maxZ: cz + half };
    return { id: d.id, keepOut };
  });
  const windows = geo.windows.map((w) => {
    const side = wallSide(geo, w.wallId);
    const b = geo.bounds;
    const onFace = side === 'north' ? b.minZ : side === 'south' ? b.maxZ : side === 'east' ? b.maxX : b.minX;
    return {
      id: w.id,
      xCm: side === 'north' || side === 'south' ? Math.round(w.center[0] * 100) : onFace,
      zCm: side === 'north' || side === 'south' ? onFace : Math.round(w.center[1] * 100),
      widthCm: Math.round(w.width * 100),
      side,
    };
  });
  return { boundsCm: geo.bounds, doors, windows, walls: geo.walls.map((w) => ({ id: w.id, side: w.side })) };
}

export interface FactsInput {
  state: RoomState;
  geo: RoomGeometry;
  pins: string[];
  preferences: { text: string }[];
  request: string;
  /** Per-object decisions from the cleaning step. */
  movable: Record<string, { movable: boolean; note?: string; sizeCm?: [number, number, number] }>;
}

export function roomFacts(input: FactsInput): RoomFacts {
  const { state, geo } = input;
  const room = solverRoom(geo);
  const b = geo.bounds;
  const doors = room.doors.map((d) => {
    const src = geo.doors.find((x) => x.id === d.id)!;
    const side = wallSide(geo, src.wallId);
    const c = d.keepOut;
    const centerCm: [number, number] = side === 'south' ? [(c.minX + c.maxX) / 2, b.maxZ] : side === 'north' ? [(c.minX + c.maxX) / 2, b.minZ] : side === 'east' ? [b.maxX, (c.minZ + c.maxZ) / 2] : [b.minX, (c.minZ + c.maxZ) / 2];
    return { id: d.id, wall: side, centerCm, widthCm: Math.round(src.width * 100) };
  });
  const objects: RoomFacts['objects'] = [];
  for (const p of state.placements) {
    const o = state.objects[p.objectId];
    const decision = input.movable[p.objectId];
    if (!o || !decision) continue;
    const pose = placementToSolver(p, geo);
    const size = decision.sizeCm ?? [Math.round(o.bboxMeters.w * 100), Math.round(o.bboxMeters.d * 100), Math.round(o.bboxMeters.h * 100)];
    const entry: RoomFacts['objects'][number] = { id: p.objectId, category: o.category, sizeCm: size, atCm: [pose.xCm, pose.zCm], facing: FACING[pose.rotDeg / 90], movable: decision.movable };
    if (decision.note) entry.note = decision.note;
    objects.push(entry);
  }
  return {
    units: 'cm',
    room: {
      widthCm: b.maxX - b.minX,
      depthCm: b.maxZ - b.minZ,
      walls: geo.walls.map((w) => ({ id: w.id, side: w.side, lengthCm: w.side === 'north' || w.side === 'south' ? b.maxX - b.minX : b.maxZ - b.minZ })),
      doors,
      windows: room.windows.map((w) => ({ id: w.id, wall: w.side, centerCm: [w.xCm, w.zCm] as [number, number], widthCm: w.widthCm })),
    },
    objects,
    pinned: input.pins,
    preferences: input.preferences,
    request: input.request,
  };
}

export function solverObjects(facts: RoomFacts, geo: RoomGeometry, state: RoomState): SolverObject[] {
  return facts.objects.map((o) => {
    const p = state.placements.find((x) => x.objectId === o.id)!;
    const pose = placementToSolver(p, geo);
    return { id: o.id, widthCm: o.sizeCm[0], depthCm: o.sizeCm[1], xCm: pose.xCm, zCm: pose.zCm, rotDeg: pose.rotDeg, movable: o.movable };
  });
}
