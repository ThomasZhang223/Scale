import type { ViewProps } from "react-native";

export interface NormalizedTapPoint {
  x: number;
  y: number;
  // The size in points of the view the tap landed in. The native side needs
  // the aspect ratio to map a portrait view point onto the landscape camera
  // image (ARFrame.displayTransform).
  viewWidth: number;
  viewHeight: number;
}

// Mirrors the measured shape of .claude/contracts.md's Object v1 —
// bboxMeters and measure. Everything else (name, category, price, ...) is
// filled in later, by the Worker or the user, not by this module.
export interface ObjectMeasureResult {
  bboxMeters: { w: number; h: number; d: number };
  // World-space centre, in the ARKit world frame this session ran in. Only
  // meaningful while that same session (and its ObjectMeasureView) is still
  // alive — it is not something to store alongside Object v1.
  center: { x: number; y: number; z: number };
  yawDeg: number;
  // measure.confidence in contracts.md: the surviving-sample fraction.
  confidence: number;
  // Local file paths, already written to disk, sharpest first. The caller
  // uploads these via POST /uploads + the presigned PUT, then reports the
  // resulting keys in frameKeys[] on POST /objects — this module never
  // talks to the Worker itself.
  framePaths: string[];
  ambientIntensityLux: number | null;
  ambientColorTemperatureK: number | null;
  // For the point-cloud ghost. [x, y, z] world-space metres per point.
  ghostPoints: [number, number, number][];
}

export interface WireframeBox {
  centerX: number;
  centerY: number;
  centerZ: number;
  widthMeters: number;
  heightMeters: number;
  depthMeters: number;
  yawDeg: number;
}

export interface ObjectMeasureViewProps extends ViewProps {
  wireframeBox?: WireframeBox;
  ghostPoints?: [number, number, number][];
  ghostVisible?: boolean;
}
