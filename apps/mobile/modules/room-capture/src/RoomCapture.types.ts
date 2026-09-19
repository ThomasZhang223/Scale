import type { ViewProps } from "react-native";

// Mirrors .claude/contracts.md's RoomCapture v1. Do not rename a field here
// without updating contracts.md first — contracts.md wins on a disagreement.
export type Confidence = "high" | "medium" | "low";

export type Transform16 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export interface RoomCaptureWall {
  id: string;
  transform: Transform16;
  dimensions: [number, number, number];
  confidence: Confidence;
}

export interface RoomCaptureOpening {
  id: string;
  kind: "door" | "window" | "opening";
  wallId: string;
  transform: Transform16;
  dimensions: [number, number, number];
  hingeSide: "left" | "right" | "unknown";
  swingDeg: number;
}

export interface RoomCaptureObject {
  id: string;
  category: string;
  transform: Transform16;
  dimensions: [number, number, number];
  confidence: Confidence;
}

export interface RoomCaptureV1 {
  schemaVersion: 1;
  roomId: string;
  capturedAt: string;
  worldAlignment: "gravityAndHeading";
  northBearingDeg: number;
  floor: { polygon: [number, number][]; areaM2: number };
  walls: RoomCaptureWall[];
  openings: RoomCaptureOpening[];
  objects: RoomCaptureObject[];
}

export type RoomCaptureInstruction =
  | "normal"
  | "moveCloseToWall"
  | "moveAwayFromWall"
  | "turnOnLight"
  | "slowDown"
  | "lowTexture";

export interface RoomCaptureInstructionEvent {
  instruction: RoomCaptureInstruction;
}

export interface RoomCaptureProgressEvent {
  wallCount: number;
  openingCount: number;
  objectCount: number;
}

export type RoomCaptureViewProps = ViewProps;
