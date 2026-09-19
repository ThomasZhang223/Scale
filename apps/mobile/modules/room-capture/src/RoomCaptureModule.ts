import { NativeModule, requireNativeModule } from "expo";

import type {
  RoomCaptureInstructionEvent,
  RoomCaptureProgressEvent,
  RoomCaptureV1,
} from "./RoomCapture.types";

type RoomCaptureModuleEvents = {
  onInstruction: (event: RoomCaptureInstructionEvent) => void;
  onProgress: (event: RoomCaptureProgressEvent) => void;
};

declare class RoomCaptureModule extends NativeModule<RoomCaptureModuleEvents> {
  isSupported(): Promise<boolean>;
  startSession(): Promise<void>;
  // Ends the sweep and returns RoomCapture v1. Rejects rather than resolving
  // a partial room — the caller sees a real error, never a guessed capture.
  stopSession(): Promise<RoomCaptureV1>;
}

export default requireNativeModule<RoomCaptureModule>("RoomCapture");
