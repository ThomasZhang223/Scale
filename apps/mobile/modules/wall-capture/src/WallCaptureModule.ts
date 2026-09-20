import { NativeModule, requireNativeModule } from "expo";

import type { CapturedFace, QuadEvent } from "./WallCapture.types";

declare class WallCaptureModule extends NativeModule<{ onQuad: (e: QuadEvent) => void }> {
  isSupported(): Promise<boolean>;
  startSession(): Promise<void>;
  stopSession(): Promise<void>;
  // Detects the face's rectangle in the current frame, rectifies it, and
  // raycasts its four corners for metres. Rejects if a corner has no surface.
  capture(vertical: boolean): Promise<CapturedFace>;
}

export default requireNativeModule<WallCaptureModule>("WallCapture");
