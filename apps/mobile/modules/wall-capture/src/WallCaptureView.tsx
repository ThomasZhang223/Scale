import { requireNativeView } from "expo";

import type { WallCaptureViewProps } from "./WallCapture.types";

const NativeView = requireNativeView<WallCaptureViewProps>("WallCapture");

// Camera passthrough with the live green outline of the detected face.
export function WallCaptureView(props: WallCaptureViewProps) {
  return <NativeView {...props} />;
}
