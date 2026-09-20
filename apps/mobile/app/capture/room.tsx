import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { RoomCaptureModule, RoomCaptureView } from "../../modules/room-capture";
import type { RoomCaptureProgressEvent, RoomCaptureResult } from "../../modules/room-capture";
import { postJSON } from "../../src/lib/api";
import { CameraGlass, GlassButton, GlassCloseButton } from "../../src/theme/Glass";
import { spacing } from "../../src/theme/tokens";
import { saveRoomPhoto } from "../../src/ui/roomPhotos";

// Full-screen RoomPlan sweep. The camera feed and the instruction text are
// drawn by the native view itself (see modules/room-capture) — this screen
// only owns the session lifecycle, the wall/opening/object counter, and
// handing the finished RoomCapture v1 to the Worker.
export default function CaptureRoomScreen() {
  const [isScanning, setIsScanning] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [progress, setProgress] = useState<RoomCaptureProgressEvent>({
    wallCount: 0,
    openingCount: 0,
    objectCount: 0,
  });
  const startedRef = useRef(false);

  useEffect(() => {
    const subscription = RoomCaptureModule.addListener("onProgress", setProgress);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    RoomCaptureModule.isSupported()
      .then((supported) => {
        if (!supported) {
          Alert.alert("Not supported", "This device has no LiDAR sensor.", [
            { text: "OK", onPress: () => router.back() },
          ]);
          return;
        }
        return RoomCaptureModule.startSession().then(() => setIsScanning(true));
      })
      .catch((error: Error) => {
        Alert.alert("Could not start scan", error.message, [{ text: "OK", onPress: () => router.back() }]);
      });

    return () => {
      // Best-effort: if the screen unmounts mid-scan (back button), stop the
      // session so the next visit starts clean. Errors here are expected
      // when the sweep already finished normally.
      RoomCaptureModule.stopSession().catch(() => {});
    };
  }, []);

  const finish = useCallback(async () => {
    setIsFinishing(true);
    let result: RoomCaptureResult;
    try {
      result = await RoomCaptureModule.stopSession();
    } catch (error) {
      Alert.alert("Scan failed", error instanceof Error ? error.message : String(error));
      setIsFinishing(false);
      return;
    }
    setIsScanning(false);

    const { photoPath, ...room } = result;
    try {
      const { roomId } = await postJSON<{ roomId: string }>("/rooms", room);
      if (photoPath) {
        try {
          saveRoomPhoto(roomId, photoPath);
        } catch {
          // The card falls back to the floor plan; the scan itself is saved.
        }
      }
      router.replace(`/room/${roomId}`);
    } catch (error) {
      // The scan itself succeeded — do not throw it away because the upload
      // failed. Let the presenter retry the upload rather than re-scanning.
      Alert.alert(
        "Scan complete, upload failed",
        error instanceof Error ? error.message : String(error)
      );
      setIsFinishing(false);
    }
  }, []);

  return (
    <>
      <RoomCaptureView style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.chrome} pointerEvents="box-none">
        <View style={styles.top} pointerEvents="box-none">
          <GlassCloseButton onPress={() => router.back()} />
        </View>

        <View style={styles.footer} pointerEvents="box-none">
          <CameraGlass style={styles.counter}>
            <Count value={progress.wallCount} label="walls" />
            <View style={styles.divider} />
            <Count value={progress.openingCount} label="openings" />
            <View style={styles.divider} />
            <Count value={progress.objectCount} label="objects" />
          </CameraGlass>
          <GlassButton
            label={isFinishing ? "Finishing…" : "Finish scan"}
            icon="checkmark"
            prominent
            disabled={!isScanning || isFinishing}
            onPress={finish}
          />
        </View>
      </SafeAreaView>
    </>
  );
}

// One number per thing RoomPlan has found so far. Tabular digits so the
// pill does not jitter as counts tick up mid-sweep.
function Count({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.count}>
      <Text style={styles.countValue}>{value}</Text>
      <Text style={styles.countLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chrome: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "space-between" },
  top: { flexDirection: "row", justifyContent: "flex-start", paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  footer: {
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  counter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    gap: spacing.md,
  },
  count: { alignItems: "center", minWidth: 56 },
  countValue: { color: "white", fontSize: 26, fontWeight: "600", fontVariant: ["tabular-nums"], lineHeight: 30 },
  countLabel: { color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: "500" },
  divider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: "rgba(255,255,255,0.25)" },
});
