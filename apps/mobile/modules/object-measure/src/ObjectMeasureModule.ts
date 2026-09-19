import { NativeModule, requireNativeModule } from "expo";

import type { NormalizedTapPoint, ObjectMeasureResult } from "./ObjectMeasure.types";

declare class ObjectMeasureModule extends NativeModule<{}> {
  isSupported(): Promise<boolean>;
  startSession(): Promise<void>;
  stopSession(): Promise<void>;
  // Rejects rather than resolving a partial or zero measurement — no plane
  // found, tracking lost, or too few surviving samples all throw. Fail
  // loud: never a guessed number (.claude/CLAUDE.md, "Fail loud").
  measure(tap: NormalizedTapPoint): Promise<ObjectMeasureResult>;
}

export default requireNativeModule<ObjectMeasureModule>("ObjectMeasure");
