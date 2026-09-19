// The guaranteed-safe object preview: plain React Native, no WebGL context
// at all, so it renders correctly regardless of whether GlbPreview.tsx's
// expo-gl + @react-three/fiber path actually draws anything on a given
// device. This is what app/object/[id].tsx wires in today — see the
// ceiling comment there and in GlbPreview.tsx for why.
//
// Draws a dashed rectangle at the object's true front-view aspect ratio
// (width x height), so even the safe fallback carries a little of "the
// size is real" — the same idea as GlbPreview's wireframe box, just in 2D
// and needing nothing more than a View.
import { View, StyleSheet } from "react-native";
import { SymbolView } from "expo-symbols";

import { colors, radius } from "../theme/tokens";

export type StaticThumbnailProps = {
  bboxMeters: { w: number; h: number; d: number };
  size?: number;
};

export function StaticThumbnail({ bboxMeters, size = 220 }: StaticThumbnailProps) {
  const fit = size * 0.7;
  const largest = Math.max(bboxMeters.w, bboxMeters.h);
  const rectWidth = largest > 0 ? (bboxMeters.w / largest) * fit : fit;
  const rectHeight = largest > 0 ? (bboxMeters.h / largest) * fit : fit;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <View style={[styles.silhouette, { width: rectWidth, height: rectHeight }]}>
        <SymbolView name="cube.transparent" size={28} tintColor={colors.accent} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceFallback,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  silhouette: {
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.accent,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
});
