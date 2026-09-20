// The six faces of a box room laid out as a cube net: ceiling above, the
// four walls in a strip, floor below the front. Shared by the camera capture
// (app/capture/box.tsx) and the photo upload (app/room/new.tsx).
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";

import type { FaceId } from "../../modules/wall-capture";
import { colors, radius } from "../theme/tokens";

export const FACES: { id: FaceId; label: string; col: number; row: number; vertical: boolean }[] = [
  { id: "ceiling", label: "Ceiling", col: 1, row: 0, vertical: false },
  { id: "left", label: "Left wall", col: 0, row: 1, vertical: true },
  { id: "front", label: "Front wall", col: 1, row: 1, vertical: true },
  { id: "right", label: "Right wall", col: 2, row: 1, vertical: true },
  { id: "back", label: "Back wall", col: 3, row: 1, vertical: true },
  { id: "floor", label: "Floor", col: 1, row: 2, vertical: false },
];

export const WALL_FACES: FaceId[] = ["front", "right", "back", "left"];

const FACE = 82;
const GAP = 8;

export type FaceNetProps = {
  // Image path per captured face, and an optional caption replacing the label.
  images: Partial<Record<FaceId, string>>;
  captions?: Partial<Record<FaceId, string>>;
  onPress: (face: (typeof FACES)[number]) => void;
};

export function FaceNet({ images, captions, onPress }: FaceNetProps) {
  return (
    <View style={styles.net}>
      {FACES.map((n) => {
        const image = images[n.id];
        return (
          <Pressable
            key={n.id}
            onPress={() => onPress(n)}
            style={({ pressed }) => [
              styles.face,
              { left: n.col * (FACE + GAP), top: n.row * (FACE + GAP) },
              image && styles.faceDone,
              pressed && styles.pressed,
            ]}
          >
            {image ? (
              <Image source={{ uri: image.startsWith("file://") ? image : `file://${image}` }} style={styles.faceImage} resizeMode="cover" />
            ) : (
              <SymbolView name={n.vertical ? "rectangle.portrait" : "rectangle"} size={26} tintColor={colors.accent} weight="light" />
            )}
            <View style={styles.faceLabelWrap}>
              <Text style={styles.faceLabel} numberOfLines={1}>
                {captions?.[n.id] ?? n.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  net: { alignSelf: "center", width: FACE * 4 + GAP * 3, height: FACE * 3 + GAP * 2 },
  face: {
    position: "absolute",
    width: FACE,
    height: FACE,
    borderRadius: radius.md,
    backgroundColor: "rgba(255,255,255,0.86)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(60,60,67,0.12)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  faceDone: { borderColor: colors.accent, borderWidth: 2 },
  faceImage: { width: "100%", height: "100%" },
  faceLabelWrap: { position: "absolute", left: 0, right: 0, bottom: 0, paddingVertical: 4, paddingHorizontal: 4, backgroundColor: "rgba(255,255,255,0.8)" },
  faceLabel: { fontSize: 11, fontWeight: "500", color: "#1c1c1e", textAlign: "center", fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.8 },
});
