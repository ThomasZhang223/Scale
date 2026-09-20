import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { WallCaptureModule, WallCaptureView } from "../../modules/wall-capture";
import type { CapturedFace, FaceId } from "../../modules/wall-capture";
import { postJSON } from "../../src/lib/api";
import { CameraGlass, GlassButton, GlassCloseButton } from "../../src/theme/Glass";
import { colors, radius, spacing } from "../../src/theme/tokens";
import { Card } from "../../src/ui/Card";
import { Logo } from "../../src/ui/Logo";
import { FaceNet, FACES as NET } from "../../src/ui/FaceNet";
import { ReadoutHint } from "../../src/ui/Readout";
import { roomFromFaces } from "../../src/ui/roomFromFaces";
import { saveRoomPhoto } from "../../src/ui/roomPhotos";

type Faces = Partial<Record<FaceId, CapturedFace>>;

// Photograph-the-walls capture: the RoomPlan fallback. Pick a face, frame the
// whole of it, capture; the module finds the rectangle, straightens it, and
// measures it. Four walls make a room.
export default function CaptureBoxScreen() {
  const [faces, setFaces] = useState<Faces>({});
  const [active, setActive] = useState<(typeof NET)[number] | null>(null);
  const [found, setFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const sessionRef = useRef(false);

  useEffect(() => {
    const sub = WallCaptureModule.addListener("onQuad", ({ found }) => setFound(found));
    return () => sub.remove();
  }, []);

  const openCamera = useCallback(async (face: (typeof NET)[number]) => {
    try {
      if (!(await WallCaptureModule.isSupported())) {
        Alert.alert("Not supported", "This needs an iPhone with LiDAR.");
        return;
      }
      if (!sessionRef.current) {
        await WallCaptureModule.startSession();
        sessionRef.current = true;
      }
      setActive(face);
    } catch (e) {
      Alert.alert("Could not start the camera", e instanceof Error ? e.message : String(e));
    }
  }, []);

  const closeCamera = useCallback(async () => {
    setActive(null);
    if (sessionRef.current) {
      sessionRef.current = false;
      await WallCaptureModule.stopSession().catch(() => {});
    }
  }, []);

  useEffect(() => () => void WallCaptureModule.stopSession().catch(() => {}), []);

  const capture = useCallback(async () => {
    if (!active || busy) return;
    setBusy(true);
    try {
      const face = await WallCaptureModule.capture(active.vertical);
      setFaces((f) => ({ ...f, [active.id]: face }));
      await closeCamera();
    } catch (e) {
      Alert.alert("Try again", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [active, busy, closeCamera]);

  const wallCount = NET.filter((n) => n.vertical && faces[n.id]).length;

  const buildRoom = useCallback(async () => {
    setSaving(true);
    try {
      const room = roomFromFaces(faces);
      const { roomId } = await postJSON<{ roomId: string }>("/rooms", room);
      const photo = faces.front?.imagePath ?? Object.values(faces)[0]?.imagePath;
      if (photo) {
        try {
          saveRoomPhoto(roomId, photo);
        } catch {
          // card falls back to the floor plan
        }
      }
      router.replace(`/room/${roomId}`);
    } catch (e) {
      Alert.alert("Could not save the room", e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [faces]);

  if (active) {
    return (
      <View style={styles.camera}>
        <WallCaptureView style={StyleSheet.absoluteFill} />
        <SafeAreaView style={styles.chrome} pointerEvents="box-none">
          <View style={styles.top} pointerEvents="box-none">
            <GlassCloseButton onPress={closeCamera} />
            <CameraGlass style={styles.facePill}>
              <Text style={styles.facePillText}>{active.label}</Text>
            </CameraGlass>
          </View>
          <View style={styles.footer} pointerEvents="box-none">
            <ReadoutHint
              text={
                found
                  ? `Got the ${active.label.toLowerCase()}. Hold steady and capture.`
                  : `Step back until the whole ${active.label.toLowerCase()} fits the frame`
              }
            />
            <GlassButton
              label={busy ? "Capturing…" : found ? "Capture" : "Capture anyway"}
              icon="camera.fill"
              prominent
              tint={found ? colors.accent : "#636366"}
              disabled={busy}
              onPress={capture}
            />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <GlassCloseButton dark onPress={() => router.back()} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Logo size={24} />
            <Text style={styles.title}>Photograph the walls</Text>
          </View>
          <View style={{ width: 40 }} />
        </View>
        <Text style={styles.lead}>Tap a face, fit the whole of it in the frame, capture. Four walls make a room.</Text>

        <FaceNet
          images={Object.fromEntries(Object.entries(faces).map(([k, v]) => [k, v!.imagePath]))}
          captions={Object.fromEntries(Object.entries(faces).map(([k, v]) => [k, `${Math.round(v!.widthMeters * 100)} × ${Math.round(v!.heightMeters * 100)} cm`]))}
          onPress={openCamera}
        />

        <Card style={styles.status}>
          <Text style={styles.statusText}>
            {wallCount} of 4 walls captured{faces.floor ? " · floor" : ""}{faces.ceiling ? " · ceiling" : ""}
          </Text>
          <Pressable
            disabled={wallCount < 3 || saving}
            onPress={buildRoom}
            style={({ pressed }) => [styles.build, (wallCount < 3 || saving) && styles.buildDisabled, pressed && styles.pressed]}
          >
            <Text style={styles.buildText}>{saving ? "Saving…" : wallCount < 3 ? "Capture at least 3 walls" : "Build the room"}</Text>
          </Pressable>
        </Card>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#e8edf4" },
  safe: { flex: 1, paddingHorizontal: spacing.md, gap: spacing.md },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: spacing.sm },
  title: { fontSize: 20, fontWeight: "600", color: "#1c1c1e" },
  lead: { fontSize: 15, color: colors.textMuted, textAlign: "center", lineHeight: 21 },
  status: { padding: spacing.md, gap: spacing.sm, alignItems: "center", marginTop: "auto", marginBottom: spacing.md },
  statusText: { fontSize: 15, color: colors.textMuted },
  build: { backgroundColor: colors.accent, paddingHorizontal: 22, paddingVertical: 13, borderRadius: 999 },
  buildDisabled: { opacity: 0.45 },
  buildText: { color: "white", fontSize: 16, fontWeight: "600" },
  camera: { flex: 1, backgroundColor: "black" },
  chrome: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "space-between" },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  facePill: { paddingHorizontal: spacing.md, paddingVertical: 10 },
  facePillText: { color: "white", fontSize: 15, fontWeight: "600" },
  footer: { alignItems: "center", paddingHorizontal: spacing.md, paddingBottom: spacing.lg, gap: spacing.md },
  pressed: { opacity: 0.8 },
});
