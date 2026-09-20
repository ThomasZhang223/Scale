// The caliper readout on the object capture screen: three measured lengths
// in large tabular digits on dark glass, with the confidence underneath.
// Plain React Native because it floats over the AR view (see
// src/theme/Glass.tsx). Metres in, centimetres shown — the UI edge is the
// only place that conversion happens (CLAUDE.md, "Metres everywhere").
import { StyleSheet, Text, View } from "react-native";

import { CameraGlass } from "../theme/Glass";
import { colors, spacing } from "../theme/tokens";

type ReadoutProps = {
  bboxMeters: { w: number; h: number; d: number };
  confidence: number; // 0..1
};

function cm(m: number): string {
  return Math.round(m * 100).toString();
}

export function Readout({ bboxMeters, confidence }: ReadoutProps) {
  const pct = Math.round(confidence * 100);
  const tone = pct >= 60 ? colors.lidar : pct >= 25 ? colors.warning : colors.danger;
  return (
    <CameraGlass style={styles.panel}>
      <View style={styles.row}>
        <Dim value={cm(bboxMeters.w)} label="wide" />
        <Text style={styles.times}>×</Text>
        <Dim value={cm(bboxMeters.h)} label="tall" />
        <Text style={styles.times}>×</Text>
        <Dim value={cm(bboxMeters.d)} label="deep" />
        <Text style={styles.unit}>cm</Text>
      </View>
      <View style={styles.confidenceRow}>
        <View style={[styles.dot, { backgroundColor: tone }]} />
        <Text style={styles.confidence}>{pct}% of LiDAR samples agree</Text>
      </View>
    </CameraGlass>
  );
}

function Dim({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.dim}>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

// Live hint while nothing is measured yet, same material, smaller.
export function ReadoutHint({ text }: { text: string }) {
  return (
    <CameraGlass style={styles.hint}>
      <Text style={styles.hintText}>{text}</Text>
    </CameraGlass>
  );
}

const styles = StyleSheet.create({
  panel: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
    gap: spacing.sm,
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  dim: { alignItems: "center", minWidth: 44 },
  value: {
    color: "white",
    fontSize: 34,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.5,
    lineHeight: 38,
  },
  label: { color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: "500" },
  times: { color: "rgba(255,255,255,0.45)", fontSize: 22, lineHeight: 38, marginBottom: 14 },
  unit: { color: "rgba(255,255,255,0.7)", fontSize: 15, fontWeight: "500", lineHeight: 38, marginBottom: 14, marginLeft: 2 },
  confidenceRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  confidence: { color: "rgba(255,255,255,0.75)", fontSize: 13, fontVariant: ["tabular-nums"] },
  hint: { paddingHorizontal: spacing.lg, paddingVertical: 12 },
  hintText: { color: "white", fontSize: 15, fontWeight: "500" },
});
