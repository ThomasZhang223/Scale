import type { ViewProps } from "react-native";

// Mirrors ObjectCaptureSession.CaptureState, as strings.
export type ObjectCaptureState =
  | "initializing"
  | "ready"
  | "detecting"
  | "capturing"
  | "finishing"
  | "completed"
  | "failed"
  | "unknown";

// ObjectCaptureSession.Feedback case names, e.g. "objectTooClose",
// "movingTooFast", "environmentTooDark", "outOfFieldOfView".
export type ObjectCaptureFeedback = string;

export type ObjectCaptureStateEvent = { state: ObjectCaptureState };
export type ObjectCaptureFeedbackEvent = { feedback: ObjectCaptureFeedback[] };
export type ObjectCaptureShotsEvent = { taken: number; max: number };
export type ReconstructionProgressEvent = { fraction: number; phase: "reconstructing" | "exporting" };

export type ReconstructionDetail = "preview" | "reduced" | "medium";

export interface ReconstructionResult {
  // Local paths. The USDZ is for QuickLook AR on the phone; the GLB is what
  // gets uploaded for the headset. Both are true-size metres.
  usdzPath: string;
  glbPath: string;
  bboxMeters: { w: number; h: number; d: number };
  imageCount: number;
  // A downscaled JPEG from the capture itself, for the library row.
  photoPath: string | null;
}

export interface ObjectCaptureViewProps extends ViewProps {}
