import { requireNativeView } from "expo";

import type { RoomCaptureViewProps } from "./RoomCapture.types";

const NativeView = requireNativeView<RoomCaptureViewProps>("RoomCapture");

// The live camera feed plus our own instruction overlay — never Apple's
// RoomCaptureView. See modules/room-capture/README.md.
export function RoomCaptureView(props: RoomCaptureViewProps) {
  return <NativeView {...props} />;
}
