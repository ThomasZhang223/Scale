import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { WallCaptureModule } from "../../modules/wall-capture";
import type { FaceId, RectifiedPhoto } from "../../modules/wall-capture";
import { postJSON } from "../../src/lib/api";
import { colors, spacing } from "../../src/theme/tokens";
import { Card } from "../../src/ui/Card";
import { FaceNet, FACES, WALL_FACES } from "../../src/ui/FaceNet";
import { roomFromPhotos } from "../../src/ui/roomFromPhotos";
import { rememberRoom, saveRoomFace, saveRoomFaceMeta, saveRoomPhoto } from "../../src/ui/roomPhotos";

type Faces = Partial<Record<FaceId, RectifiedPhoto>>;

// A room from photos you already have: one per face. Each photo is
// straightened by the same four-point transform as the live capture; the
// straightened aspect ratios plus one entered ceiling height give the room
// its size. The six faces are stitched together on the room page.
export default function NewRoomFromPhotosScreen() {
  const [faces, setFaces] = useState<Faces>({});
  const [heightCm, setHeightCm] = useState("");
  const [busyFace, setBusyFace] = useState<FaceId | null>(null);
  const [saving, setSaving] = useState(false);

  const pick = useCallback(async (face: (typeof FACES)[number]) => {
    setBusyFace(face.id);
    try {
      const path = await WallCaptureModule.pickPhoto();
      if (!path) return;
      const photo = await WallCaptureModule.rectifyPhoto(path);
      setFaces((f) => ({ ...f, [face.id]: photo }));
    } catch (e) {
      Alert.alert("Could not use that photo", e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFace(null);
    }
  }, []);

  const wallCount = WALL_FACES.filter((f) => faces[f]).length;
  const heightM = Number(heightCm.replace(",", ".")) / 100;
  const ready = wallCount >= 2 && heightM > 1 && !saving;

  const build = useCallback(async () => {
    setSaving(true);
    try {
      const { room, widthMeters, depthMeters } = roomFromPhotos(faces, heightM);
      const { roomId } = await postJSON<{ roomId: string }>("/rooms", room);
      rememberRoom(roomId);
      const meta: Record<string, { aspect: number; detected: boolean }> = {};
      for (const [face, photo] of Object.entries(faces)) {
        if (!photo) continue;
        try {
          saveRoomFace(roomId, face, photo.imagePath);
          meta[face] = { aspect: photo.aspect, detected: photo.detected };
        } catch {
          // that face is simply absent from the stitched view
        }
      }
      saveRoomFaceMeta(roomId, meta);
      const cover = faces.front?.imagePath ?? Object.values(faces)[0]?.imagePath;
      if (cover) {
        try {
          saveRoomPhoto(roomId, cover);
        } catch {
          // card falls back to the floor plan
        }
      }
      Alert.alert("Room built", `${widthMeters.toFixed(1)} × ${depthMeters.toFixed(1)} m, ${heightM.toFixed(2)} m tall.`);
      router.replace(`/room/${roomId}`);
    } catch (e) {
      Alert.alert("Could not build the room", e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [faces, heightM]);

  const images: Partial<Record<FaceId, string>> = {};
  const captions: Partial<Record<FaceId, string>> = {};
  for (const n of FACES) {
    const p = faces[n.id];
    if (p) {
      images[n.id] = p.imagePath;
      captions[n.id] = p.detected ? "Straightened" : "Whole photo";
    }
    if (busyFace === n.id) captions[n.id] = "Working…";
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic" keyboardDismissMode="on-drag">
      <Text style={styles.lead}>Tap a face and choose a photo of it. Two opposite walls and the ceiling height are enough; six faces give the full stitched room.</Text>

      <FaceNet images={images} captions={captions} onPress={pick} />

      <Card style={styles.card}>
        <Text style={styles.label}>Ceiling height</Text>
        <View style={styles.inputRow}>
          <TextInput
            value={heightCm}
            onChangeText={setHeightCm}
            placeholder="e.g. 260"
            placeholderTextColor="rgba(60,60,67,0.4)"
            keyboardType="decimal-pad"
            style={styles.input}
          />
          <Text style={styles.unit}>cm</Text>
        </View>
        <Text style={styles.hint}>Floor to ceiling. Every wall's width follows from its photo's proportions and this number.</Text>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.status}>{wallCount} of 4 walls{faces.floor ? " · floor" : ""}{faces.ceiling ? " · ceiling" : ""}</Text>
        <Pressable disabled={!ready} onPress={build} style={({ pressed }) => [styles.build, !ready && styles.buildDisabled, pressed && styles.pressed]}>
          <Text style={styles.buildText}>
            {saving ? "Building…" : wallCount < 2 ? "Add two walls to start" : !(heightM > 1) ? "Enter the ceiling height" : "Build the room"}
          </Text>
        </Pressable>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#e8edf4" },
  content: { padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xl * 2 },
  lead: { fontSize: 15, color: colors.textMuted, textAlign: "center", lineHeight: 21 },
  card: { padding: spacing.md, gap: 8 },
  label: { fontSize: 13, fontWeight: "600", color: colors.textMuted },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { flex: 1, fontSize: 28, fontWeight: "600", color: "#1c1c1e", fontVariant: ["tabular-nums"], paddingVertical: 4 },
  unit: { fontSize: 17, color: colors.textMuted },
  hint: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  status: { fontSize: 15, color: colors.textMuted, textAlign: "center" },
  build: { alignSelf: "center", backgroundColor: colors.accent, paddingHorizontal: 22, paddingVertical: 13, borderRadius: 999 },
  buildDisabled: { opacity: 0.45 },
  buildText: { color: "white", fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.8 },
});
