import { NativeModule, requireNativeModule } from "expo";

import type { CapturedFace, QuadEvent, RectifiedPhoto } from "./WallCapture.types";

declare class WallCaptureModule extends NativeModule<{ onQuad: (e: QuadEvent) => void }> {
  isSupported(): Promise<boolean>;
  startSession(): Promise<void>;
  stopSession(): Promise<void>;
  // Detects the face's rectangle in the current frame, rectifies it, and
  // raycasts its four corners for metres. Rejects if a corner has no surface.
  capture(vertical: boolean): Promise<CapturedFace>;
  // Apple's photo picker. Resolves to a local path, or null if cancelled.
  pickPhoto(): Promise<string | null>;
  // Straightens a library photo; rejects if it cannot be read.
  rectifyPhoto(path: string): Promise<RectifiedPhoto>;
}

export default requireNativeModule<WallCaptureModule>("WallCapture");
