import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ObjectMeasureModule, ObjectMeasureView } from "../../modules/object-measure";
import type { ObjectMeasureResult } from "../../modules/object-measure";
import { postJSON, putUpload } from "../../src/lib/api";
import { Glass } from "../../src/theme/Glass";
import { colors, radius, spacing } from "../../src/theme/tokens";

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
      // Every frame first through POST /uploads for a presigned R2 target,
      // then straight to R2 — the Worker never sees the bytes.
      const frameKeys: string[] = [];
      for (const framePath of result.framePaths) {
        const { key, putUrl } = await postJSON<{ key: string; putUrl: string }>("/uploads", {
          kind: "object-frame",
          ext: "jpg",
        });
        await putUpload(framePath, putUrl, "image/jpeg");
        frameKeys.push(key);
      }

      // state:"measured" comes back from this call in under a second per
      // contracts.md — the mesh follows later, over SSE.
      const object = await postJSON<{ objectId: string }>("/objects", {
        source: "scan",
        name: "Scanned object",
        category: "unknown",
        bboxMeters: result.bboxMeters,
        measure: { method: "lidar", confidence: result.confidence },
        frameKeys,
      });

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
      <SafeAreaView style={styles.footer} pointerEvents="box-none">
        {phase === "idle" && (
          <Glass style={styles.hintPill}>
            <Text style={styles.hintText}>Tap the object to measure it</Text>
          </Glass>
        )}
        {result && phase !== "idle" && (
          <Glass style={styles.hintPill}>
            <Text style={styles.hintText}>
              {(result.bboxMeters.w * 100).toFixed(0)} × {(result.bboxMeters.h * 100).toFixed(0)} ×{" "}
              {(result.bboxMeters.d * 100).toFixed(0)} cm · {(result.confidence * 100).toFixed(0)}% confidence
            </Text>
          </Glass>
        )}
        {phase === "measured" && (
          <Pressable style={styles.confirmButton} onPress={confirm}>
            <Text style={styles.confirmButtonText}>Use this measurement</Text>
          </Pressable>
        )}
        {phase === "measured" && (
          <Pressable onPress={retry}>
            <Text style={styles.retryText}>Measure again</Text>
          </Pressable>
        )}
        {phase === "uploading" && <Text style={styles.uploadingText}>Uploading…</Text>}
      </SafeAreaView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  hintPill: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  hintText: { color: "white", fontSize: 13, fontWeight: "500" },
  confirmButton: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
  },
  confirmButtonText: { color: "white", fontSize: 17, fontWeight: "600" },
  retryText: { color: "white", fontSize: 15, opacity: 0.8 },
  uploadingText: { color: "white", fontSize: 15 },
});
