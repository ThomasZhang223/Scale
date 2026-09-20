import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ObjectMeasureModule, ObjectMeasureView } from "../../modules/object-measure";
import type { ObjectMeasureResult } from "../../modules/object-measure";
import { postJSON, putUpload } from "../../src/lib/api";
import { GlassButton, GlassCloseButton } from "../../src/theme/Glass";
import { spacing } from "../../src/theme/tokens";
import { saveObjectPhoto } from "../../src/ui/objectFiles";
import { Logo } from "../../src/ui/Logo";
import { Readout, ReadoutHint } from "../../src/ui/Readout";

type Phase = "idle" | "measuring" | "measured" | "uploading";

// Tap the object on the table to measure it. The wireframe box and the
// point-cloud ghost are drawn by the native view; this screen owns the tap
// gesture, the measure()/upload sequence, and handing the result to the
// Worker as an Object v1.
export default function CaptureObjectScreen() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ObjectMeasureResult | null>(null);
  const [layoutSize, setLayoutSize] = useState({ width: 1, height: 1 });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    ObjectMeasureModule.isSupported()
      .then((supported) => {
        if (!supported) {
          Alert.alert("Not supported", "This device has no LiDAR sensor.", [
            { text: "OK", onPress: () => router.back() },
          ]);
          return;
        }
        return ObjectMeasureModule.startSession();
      })
      .catch((error: Error) => {
        Alert.alert("Could not start", error.message, [{ text: "OK", onPress: () => router.back() }]);
      });

    return () => {
      ObjectMeasureModule.stopSession().catch(() => {});
    };
  }, []);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setLayoutSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
  }, []);

  const onTap = useCallback(
    async (event: GestureResponderEvent) => {
      if (phase === "measuring" || phase === "uploading") return;
      setPhase("measuring");
      try {
        const measured = await ObjectMeasureModule.measure({
          x: event.nativeEvent.locationX / layoutSize.width,
          y: event.nativeEvent.locationY / layoutSize.height,
          viewWidth: layoutSize.width,
          viewHeight: layoutSize.height,
        });
        setResult(measured);
        setPhase("measured");
      } catch (error) {
        Alert.alert("Measurement failed", error instanceof Error ? error.message : String(error));
        setPhase("idle");
      }
    },
    [phase, layoutSize]
  );

  const confirm = useCallback(async () => {
    if (!result) return;
    setPhase("uploading");
    try {
      // The Worker keys frames by objectId (objects/{id}/frames/{n}.jpg), so
      // the object row has to exist before the first frame can be granted a
      // key. Row first, then the frames. The earlier order — frames first,
      // with kind "object-frame" — was the HTTP 400 seen on device.
      const object = await postJSON<{ objectId: string }>("/objects", {
        source: "scan",
        name: "Scanned object",
        category: "unknown",
        bboxMeters: result.bboxMeters,
        measure: { method: "lidar", confidence: result.confidence },
      });
      // Sharpest frame first: that one is the row's photo on this phone.
      if (result.framePaths[0]) {
        try {
          saveObjectPhoto(object.objectId, result.framePaths[0]);
        } catch {
          // Row falls back to the category icon.
        }
      }
      // ceiling: the Worker stores no record of which frames exist — there is no frame_keys column
      // (workers/src/schema.sql). The keys are derivable (objects/{objectId}/frames/{n}.jpg) and R2
      // supports prefix listing, so the generator can find them. If that ever stops being true, add
      // the column rather than re-sending the keys.
      for (const [n, framePath] of result.framePaths.entries()) {
        const { putUrl } = await postJSON<{ key: string; putUrl: string }>("/uploads", {
          kind: "objectFrame",
          objectId: object.objectId,
          n,
        });
        await putUpload(framePath, putUrl, "image/jpeg");
      }

      router.replace(`/object/${object.objectId}`);
    } catch (error) {
      Alert.alert("Upload failed", error instanceof Error ? error.message : String(error));
      setPhase("measured");
    }
  }, [result]);

  const retry = useCallback(() => {
    setResult(null);
    setPhase("idle");
  }, []);

  return (
    <Pressable style={StyleSheet.absoluteFill} onLayout={onLayout} onPress={onTap}>
      <ObjectMeasureView
        style={StyleSheet.absoluteFill}
        wireframeBox={
          result
            ? {
                centerX: result.center.x,
                centerY: result.center.y,
                centerZ: result.center.z,
                widthMeters: result.bboxMeters.w,
                heightMeters: result.bboxMeters.h,
                depthMeters: result.bboxMeters.d,
                yawDeg: result.yawDeg,
              }
            : undefined
        }
        ghostPoints={result?.ghostPoints}
      />
      <SafeAreaView style={styles.chrome} pointerEvents="box-none">
        <View style={styles.top} pointerEvents="box-none">
          <GlassCloseButton onPress={() => router.back()} />
          <Logo size={26} mono style={styles.mark} />
        </View>

        <View style={styles.footer} pointerEvents="box-none">
          {phase === "idle" && <ReadoutHint text="Tap the object to measure it" />}
          {phase === "measuring" && <ReadoutHint text="Hold still, reading depth…" />}
          {result && (phase === "measured" || phase === "uploading") && (
            <Readout bboxMeters={result.bboxMeters} confidence={result.confidence} />
          )}
          {phase === "measured" && (
            <View style={styles.actions}>
              <GlassButton label="Measure again" icon="arrow.counterclockwise" onPress={retry} />
              <GlassButton label="Use this measurement" icon="checkmark" prominent onPress={confirm} />
            </View>
          )}
          {phase === "uploading" && <ReadoutHint text="Saving to your library…" />}
        </View>
      </SafeAreaView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chrome: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "space-between" },
  mark: { position: "absolute", left: 0, right: 0, top: spacing.sm + 7, alignSelf: "center", marginHorizontal: "auto" },
  top: { flexDirection: "row", justifyContent: "flex-start", paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  footer: {
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  actions: { flexDirection: "row", gap: spacing.sm, justifyContent: "center", flexWrap: "wrap" },
});
