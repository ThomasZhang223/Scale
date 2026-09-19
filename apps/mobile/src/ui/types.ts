// TypeScript mirrors of the .claude/contracts.md schemas this app's screens
// render. Kept here (src/ui/**, Panel B's wildcard) rather than under
// src/lib/, because src/lib/api.ts and src/lib/sse.ts are the only two
// src/lib files Panel B owns — see CLAUDE.md file ownership. sse.ts's own
// ObjectV1/FitReportV1 types stay separate and minimal on purpose: they
// only exist there to type SSE transport, not full screen rendering.
//
// contracts.md, "The one line of code that makes this loud": every one of
// these is read back with assertSchema() at the fetch site, never trusted
// on shape alone.

export type Confidence = "high" | "medium" | "low";

// 16 floats, column-major — contracts.md, "Global conventions": matches
// simd_float4x4 memory order, load with no transpose.
export type Transform16 = number[];

export type Wall = {
  id: string;
  transform: Transform16;
  dimensions: [number, number, number]; // width, height, thickness
  confidence: Confidence;
};

export type Opening = {
  id: string;
  kind: "door" | "window" | "opening";
  wallId: string;
  transform: Transform16;
  dimensions: [number, number, number]; // width, height, 0 — a plane, not a box
  hingeSide: "left" | "right" | "unknown";
  swingDeg: number;
};

export type RoomObject = {
  id: string;
  category: string;
  transform: Transform16;
  dimensions: [number, number, number];
  confidence: Confidence;
};

export type RoomCaptureV1 = {
  schemaVersion: number;
  roomId: string;
  capturedAt: string;
  worldAlignment: string;
  northBearingDeg: number;
  floor: { polygon: [number, number][]; areaM2: number };
  walls: Wall[];
  openings: Opening[];
  objects: RoomObject[];
};

export type ObjectV1 = {
  schemaVersion: number;
  objectId: string;
  source: "scan" | "catalog" | "primitive";
  state: "measured" | "generating" | "ready" | "failed";
  name: string;
  category: string;
  glbUrl: string | null;
  bboxMeters: { w: number; h: number; d: number };
  measure: { method: "lidar" | "extracted" | "declared"; confidence: number };
  caption: string;
  palette: string[];
  price: { cents: number; currency: string } | null;
  productUrl: string | null;
  merchant: string | null;
  createdAt: string;
};

export type FitViolation = {
  kind: "door_swing" | "clearance" | "wall_gap" | "window_occlusion";
  severity: "block" | "warn";
  placementId: string;
  detailMeters: number;
  message: string;
  geometry: { type: "arc" | "polyline" | "rect"; [key: string]: unknown };
};

export type FitReportV1 = {
  schemaVersion: number;
  ok: boolean;
  checkedAt: string;
  violations: FitViolation[];
};

export type VersionSummary = {
  versionId: string;
  label: string;
  createdAt: string;
  parentId: string | null;
};
