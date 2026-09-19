// Type mirrors of .claude/contracts.md. That file is the authority; if these disagree with it,
// it wins and this file is the bug.
//
// ConstraintPlan v1 at the bottom is the one NEW schema this branch introduces. It is a
// proposal to Thomas, not yet in contracts.md — see workers/DEPLOY.md "Schema proposals".

export const SCHEMA_VERSION = 1;

export interface BBoxMeters {
  w: number;
  h: number;
  d: number;
}

export interface ObjectV1 {
  schemaVersion: number;
  objectId: string;
  source: "scan" | "catalog" | "primitive";
  state: "measured" | "generating" | "ready" | "failed";
  name: string;
  category: string;
  glbUrl: string | null;
  bboxMeters: BBoxMeters;
  measure: { method: "lidar" | "extracted" | "declared"; confidence: number };
  caption: string | null;
  palette: string[] | null;
  price: { cents: number; currency: string } | null;
  productUrl: string | null;
  merchant: string | null;
  createdAt: string;
}

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
}

export interface RoomCaptureV1 {
  schemaVersion: number;
  roomId: string;
  capturedAt: string;
  worldAlignment: string;
  northBearingDeg: number;
  floor: { polygon: [number, number][]; areaM2: number };
  walls: unknown[];
  openings: unknown[];
  objects: unknown[];
  /** Optional appearance layer. Never a source of dimensions — the parametric wall wins. */
  appearance?: unknown;
}

export interface FitReportV1 {
  schemaVersion: number;
  ok: boolean;
  checkedAt: string;
  violations: unknown[];
}

// --- The layout solver contract — Justin's, and now the authority -------------------------
//
// Source: apps/xr/docs/agent/01_CONTRACT.md section 6, and 02_LAYOUT_SOLVER.md. This replaces
// the ConstraintPlan v1 that was proposed from this side. Thomas settled it: where the two
// disagreed, Justin's shape wins, because his OR-Tools model is the thing that actually has to
// be satisfiable, and it was specified first and in more detail.
//
// TWO CONVERSIONS THE WORKER OWNS, stated here because both fail silently if they are missed.
//
// 1. UNITS. The solver speaks INTEGER CENTIMETRES; everything else in this project speaks
//    metres (CLAUDE.md standing rule 1). "The Worker does all coordinate conversion" is his
//    contract's wording, so this is the UI edge the rule allows converting at, and it is the
//    only place in the codebase where centimetres may appear.
//
// 2. ROTATION. His frame puts an object's front at +Z when rotDeg is 0. Ours puts the front at
//    −Z (the mesh normalisation contract). Working the four quarter-turns through both
//    conventions gives rotDeg = (yawDeg + 180) % 360, which is its own inverse. A missed 180°
//    turns every chair to face the wall, and nothing throws.

export type LayoutRuleType = "pin" | "against_wall" | "near" | "far_from" | "facing" | "keep_clear";

/** A rule as the model writes it. Targets are object ids, or door:{id} / window:{id} / wall:{id} / center. */
export interface LayoutRule {
  id: string;
  type: LayoutRuleType;
  a?: string;
  b?: string;
  wall?: string;
  target?: string;
  zone?: string;
  maxCm?: number;
  minCm?: number;
  marginCm?: number;
  /** "must" is a hard constraint. "should" is soft, weight 1-10, and the solver may break it. */
  priority: "must" | "should";
  weight?: number;
  why?: string;
}

/** What the language model outputs. It still cannot express a coordinate. */
export interface LayoutPlan {
  summary: string;
  /** Optional. Default is every object that is not pinned. */
  movable?: string[];
  rules: LayoutRule[];
}

export interface SolveRequest {
  room: {
    boundsCm: { minX: number; maxX: number; minZ: number; maxZ: number };
    doors: { id: string; keepOut: { minX: number; maxX: number; minZ: number; maxZ: number } }[];
    windows: { id: string; xCm: number; zCm: number; widthCm: number; side: string }[];
    walls: { id: string; side: string }[];
  };
  objects: {
    id: string;
    widthCm: number;
    depthCm: number;
    xCm: number;
    zCm: number;
    rotDeg: number;
    movable: boolean;
  }[];
  rules: LayoutRule[];
  settings: { walkwayCm: number; timeLimitMs: number };
}

export interface SolveResponse {
  status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "TIMEOUT";
  placements: { id: string; xCm: number; zCm: number; rotDeg: number }[];
  satisfied: string[];
  violated: { ruleId: string; amountCm: number }[];
  /** When INFEASIBLE: a small set of must-rules that cannot all hold. */
  conflicts: string[];
  movedCm?: number;
  solveMs?: number;
}

/** Request body for POST {solverOrigin}/fit. Unchanged — the validator is a separate service. */
export interface FitRequest {
  schemaVersion: number;
  room: RoomCaptureV1;
  placements: PlacementV1[];
}
