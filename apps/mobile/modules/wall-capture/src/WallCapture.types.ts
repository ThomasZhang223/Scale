import type { ViewProps } from "react-native";

export type FaceId = "front" | "right" | "back" | "left" | "floor" | "ceiling";

export interface CapturedFace {
  // Local JPEG of the rectified (straight-on) face.
  imagePath: string;
  // World-space metres, ARKit frame of this session: top-left, top-right, bottom-right, bottom-left.
  cornersWorld: [number, number, number][];
  widthMeters: number;
  heightMeters: number;
  center: { x: number; y: number; z: number };
  yawDeg: number; // CCW seen from +Y, walls only; 0 for floor and ceiling
  detected: boolean; // false: no rectangle found, the full frame was used
  confidence: number;
}

export type QuadEvent = { found: boolean; confidence: number };
export type WallCaptureViewProps = ViewProps;
