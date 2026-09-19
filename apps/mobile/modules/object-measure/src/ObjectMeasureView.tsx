import { requireNativeView } from "expo";

import type { ObjectMeasureViewProps } from "./ObjectMeasure.types";

const NativeView = requireNativeView<ObjectMeasureViewProps>("ObjectMeasure");

// Camera passthrough, the measured-box wireframe, and the point-cloud ghost
// — set `wireframeBox` once measure() resolves, and `ghostPoints` from the
// same result. Set `ghostVisible={false}` once the generated GLB lands to
// crossfade it out (plan section 1).
export function ObjectMeasureView(props: ObjectMeasureViewProps) {
  return <NativeView {...props} />;
}
