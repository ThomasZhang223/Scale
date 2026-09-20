import { requireNativeViewManager } from "expo-modules-core";
import type { ViewProps } from "react-native";

export type ModelPreviewViewProps = ViewProps & {
  // file:// URI (or plain path) of a USDZ on this phone.
  url: string | null;
};

const NativeView = requireNativeViewManager<ModelPreviewViewProps>("ObjectCapture", "ModelPreviewView");

// SceneKit rendering of a captured object's USDZ: textured, lit, drag to orbit.
export function ModelPreviewView(props: ModelPreviewViewProps) {
  return <NativeView {...props} />;
}
