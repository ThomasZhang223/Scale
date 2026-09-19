/* Shapes from apps/xr/docs/agent/01_CONTRACT.md and 08_PROTOCOL.md. */

export interface PlacementV1 {
  placementId: string;
  objectId: string;
  p: [number, number, number];
  yawDeg: number;
  scale: number;
  lockedToWallId: string | null;
  flags: string[];
}

export interface VersionV1 {
  schemaVersion: number;
  versionId: string;
  roomId: string;
  parentId: string | null;
  label: string;
  createdAt: string;
  placements: PlacementV1[];
  materials: Record<string, string>;
  contentHash: string;
  status?: 'proposed' | 'current' | 'superseded';
  parentVersionId?: string | null;
  createdBy?: 'user' | 'agent';
  requestId?: string;
}

/** What the headset knows about an object it has placed. */
export interface StateObject {
  name: string;
  category: string;
  bboxMeters: { w: number; h: number; d: number };
  /** scan: a bound GLB; box: only a detected box; local: a file with no detection. */
  source: 'scan' | 'box' | 'local';
  confidence?: 'high' | 'medium' | 'low';
  /** The detected box this object stands in for, if any (w, h, d in metres). */
  detectedDims?: [number, number, number];
}

/** The headset's view of the room, posted to the agent on load and after every change. */
export interface RoomState {
  room: Record<string, unknown>;
  objects: Record<string, StateObject>;
  placements: PlacementV1[];
  fitReport?: { violations?: { kind: string; placementId?: string; geometry?: { type: string; center?: [number, number]; radiusM?: number; startDeg?: number; endDeg?: number } }[] };
}

export type Side = 'north' | 'south' | 'east' | 'west';

export interface RoomFacts {
  units: 'cm';
  room: {
    widthCm: number;
    depthCm: number;
    walls: { id: string; side: Side; lengthCm: number }[];
    doors: { id: string; wall: Side; centerCm: [number, number]; widthCm: number }[];
    windows: { id: string; wall: Side; centerCm: [number, number]; widthCm: number }[];
  };
  objects: {
    id: string;
    category: string;
    sizeCm: [number, number, number];
    atCm: [number, number];
    facing: Side;
    movable: boolean;
    note?: string;
  }[];
  pinned: string[];
  preferences: { text: string }[];
  request: string;
}

export type RuleType = 'pin' | 'against_wall' | 'near' | 'far_from' | 'facing' | 'keep_clear';

export interface Rule {
  id: string;
  type: RuleType;
  a?: string;
  b?: string;
  target?: string;
  wall?: string;
  zone?: string;
  maxCm?: number;
  minCm?: number;
  marginCm?: number;
  priority: 'must' | 'should';
  weight?: number;
  why?: string;
}

export interface Plan {
  summary: string;
  movable?: string[];
  rules: Rule[];
  remember?: { text: string; rule: Rule }[];
}

export type SolverRef = { object: string } | { point: [number, number] };

export interface SolverRule {
  id: string;
  type: RuleType;
  a?: string;
  b?: SolverRef;
  target?: SolverRef;
  wall?: Side | 'any';
  zone?: 'walkway' | { rect: { minX: number; maxX: number; minZ: number; maxZ: number } };
  maxCm?: number;
  minCm?: number;
  marginCm?: number;
  priority: 'must' | 'should';
  weight?: number;
}

export interface SolverObject {
  id: string;
  widthCm: number;
  depthCm: number;
  xCm: number;
  zCm: number;
  rotDeg: number;
  movable: boolean;
}

export interface SolverRequest {
  room: {
    boundsCm: { minX: number; maxX: number; minZ: number; maxZ: number };
    doors: { id: string; keepOut: { minX: number; maxX: number; minZ: number; maxZ: number } }[];
    windows: { id: string; xCm: number; zCm: number; widthCm: number; side: Side }[];
    walls: { id: string; side: Side }[];
  };
  objects: SolverObject[];
  rules: SolverRule[];
  settings: { walkwayCm: number; timeLimitMs: number };
}

export interface SolverResponse {
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'TIMEOUT';
  placements: { id: string; xCm: number; zCm: number; rotDeg: number }[];
  satisfied: string[];
  violated: { ruleId: string; amountCm: number | true }[];
  conflicts: string[];
  movedCm: number;
  solveMs: number;
}

export interface FitViolation {
  kind: 'door_swing' | 'clearance' | 'wall_gap' | 'window_occlusion';
  severity: 'block' | 'warn';
  placementId: string;
  detailMeters: number;
  message: string;
  geometry: unknown;
}

export interface FitReport {
  schemaVersion: number;
  ok: boolean;
  checkedAt: string;
  violations: FitViolation[];
  warnings?: string[];
}

export interface LogEntry {
  at: string;
  kind: 'data' | 'plan' | 'solve' | 'fit' | 'retry' | 'memory' | 'decision';
  message: string;
  severity: 'info' | 'warn';
}

export interface Proposal {
  requestId: string;
  versionId: string;
  baseVersionId: string;
  summary: string;
  explanation: string;
  tradeoffs: string[];
  moves: { objectId: string; from: PlacementV1; to: PlacementV1 }[];
  placements: PlacementV1[];
  fit: { red: number; amber: number };
  unsatisfied: { ruleId: string; why: string }[];
}

export interface Preference {
  id: string;
  text: string;
  rule: Rule;
  source: 'request' | 'undo';
  createdAt: string;
}

export type RequestState = 'queued' | 'reading' | 'planning' | 'solving' | 'checking' | 'proposed' | 'failed';

export const PRESETS: Record<string, string> = {
  reading_corner: 'Reading corner by the window',
  open_floor: 'Open up the floor',
  clear_door: 'Clear the door',
  face_window: 'Face the window',
};

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
