import { NativeModule, requireNativeModule } from "expo";

import type {
  RoomCaptureInstructionEvent,
  RoomCaptureProgressEvent,
  RoomCaptureResult,
} from "./RoomCapture.types";

type RoomCaptureModuleEvents = {
  onInstruction: (event: RoomCaptureInstructionEvent) => void;
  onProgress: (event: RoomCaptureProgressEvent) => void;
};

declare class RoomCaptureModule extends NativeModule<RoomCaptureModuleEvents> {
  isSupported(): Promise<boolean>;
  startSession(): Promise<void>;
  // Stops a sweep and discards it. For leaving the screen early.
  cancelSession(): Promise<void>;
  // Ends the sweep and returns RoomCapture v1. Rejects rather than resolving
  // a partial room — the caller sees a real error, never a guessed capture.
  stopSession(): Promise<RoomCaptureResult>;
}

export default requireNativeModule<RoomCaptureModule>("RoomCapture");
