import { NativeModule, requireNativeModule } from "expo";

import type {
  ObjectCaptureFeedbackEvent,
  ObjectCaptureShotsEvent,
  ObjectCaptureStateEvent,
  ReconstructionDetail,
  ReconstructionProgressEvent,
  ReconstructionResult,
} from "./ObjectCapture.types";

type ObjectCaptureModuleEvents = {
  onState: (event: ObjectCaptureStateEvent) => void;
  onFeedback: (event: ObjectCaptureFeedbackEvent) => void;
  onShots: (event: ObjectCaptureShotsEvent) => void;
  onReconstructionProgress: (event: ReconstructionProgressEvent) => void;
};

declare class ObjectCaptureModule extends NativeModule<ObjectCaptureModuleEvents> {
  isSupported(): Promise<boolean>;
  startSession(): Promise<void>;
  // ready → detecting. Rejects if the session could not lock onto an object.
  startDetecting(): Promise<void>;
  // detecting → capturing.
  startCapturing(): Promise<void>;
  // capturing → finishing → completed. Resolves once all images are on disk.
  finishCapture(): Promise<void>;
  cancelSession(): Promise<void>;
  // Runs PhotogrammetrySession on-device. Minutes. Rejects rather than
  // resolving a partial model.
  reconstruct(detail: ReconstructionDetail): Promise<ReconstructionResult>;
}

export default requireNativeModule<ObjectCaptureModule>("ObjectCapture");
