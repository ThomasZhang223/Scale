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

// --- ConstraintPlan v1 — PROPOSED, not yet in .claude/contracts.md -------------------------
//
// This is the entire output of the layout agent's language model. It contains no coordinates,
// by construction, because standing rule 3 in CLAUDE.md says an LLM turns intent into an
// objective and constraints, and a solver places things. The tool schema the model is given
// has no field that could hold an x or a z, so the rule is enforced by the type rather than
// by asking the model nicely.
//
// The constraint list is deliberately open. A solver ignores a `kind` it does not implement
// and reports which ones it honoured, so adding a kind never breaks the solver.

export type ConstraintPlanObjective =
  | "maximize_walkway"
  | "maximize_free_floor"
  | "minimize_wall_gap"
  | "group_seating";

export type Constraint =
  | { kind: "min_clearance"; meters: number }
  | { kind: "against_wall"; objectId: string; wallId: string | null }
  | { kind: "keep_clear"; openingId: string }
  | { kind: "near"; objectId: string; otherObjectId: string; maxMeters: number }
  | { kind: "budget"; cents: number };

export interface ConstraintPlanV1 {
  schemaVersion: number;
  objective: ConstraintPlanObjective;
  constraints: Constraint[];
  /** Free text shown to the user. Never parsed. */
  notes: string;
}

/** Request body for POST {solverOrigin}/solve. Fully hydrated: the solver fetches nothing. */
export interface SolveRequest {
  schemaVersion: number;
  room: RoomCaptureV1;
  candidates: ObjectV1[];
  fixed: PlacementV1[];
  plan: ConstraintPlanV1;
}

export interface SolveResponse {
  placements: PlacementV1[];
  objective: number;
  infeasible?: string | null;
}

/** Request body for POST {solverOrigin}/fit. Also fully hydrated. */
export interface FitRequest {
  schemaVersion: number;
  room: RoomCaptureV1;
  placements: PlacementV1[];
}
