import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { RoomCaptureModule, RoomCaptureView } from "../../modules/room-capture";
import type { RoomCaptureProgressEvent, RoomCaptureV1 } from "../../modules/room-capture";
import { postJSON } from "../../src/lib/api";
import { Glass } from "../../src/theme/Glass";
import { colors, radius, spacing } from "../../src/theme/tokens";

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
    let room: RoomCaptureV1;
    try {
      room = await RoomCaptureModule.stopSession();
    } catch (error) {
      Alert.alert("Scan failed", error instanceof Error ? error.message : String(error));
      setIsFinishing(false);
      return;
    }
    setIsScanning(false);

    try {
      const { roomId } = await postJSON<{ roomId: string }>("/rooms", room);
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
      <SafeAreaView style={styles.footer} pointerEvents="box-none">
        <Glass style={styles.counterPill}>
          <Text style={styles.counterText}>
            {progress.wallCount} walls · {progress.openingCount} openings · {progress.objectCount} objects
          </Text>
        </Glass>
        <Pressable
          style={[styles.finishButton, (!isScanning || isFinishing) && styles.finishButtonDisabled]}
          disabled={!isScanning || isFinishing}
          onPress={finish}
        >
          <Text style={styles.finishButtonText}>{isFinishing ? "Finishing…" : "Finish scan"}</Text>
        </Pressable>
      </SafeAreaView>
    </>
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
  counterPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  counterText: { color: "white", fontSize: 13, fontWeight: "500" },
  finishButton: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
  },
  finishButtonDisabled: { opacity: 0.4 },
  finishButtonText: { color: "white", fontSize: 17, fontWeight: "600" },
});
