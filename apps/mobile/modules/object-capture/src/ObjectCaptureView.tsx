import { requireNativeView } from "expo";

import type { ObjectCaptureViewProps } from "./ObjectCapture.types";

const NativeView = requireNativeView<ObjectCaptureViewProps>("ObjectCapture");

// Apple's guided-capture camera view. Shows the detection box while
// detecting and the capture dial while capturing; every button lives in JS.
export function ObjectCaptureView(props: ObjectCaptureViewProps) {
  return <NativeView {...props} />;
}
