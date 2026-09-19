// A small coloured pill for a "high" | "medium" | "low" confidence value.
// RoomCapture v1 puts this on every wall and object; Object v1 puts a
// separate 0-1 confidence float on `measure` instead (contracts.md), so the
// object detail screen buckets that float into the same three labels
// before handing it to this component — see toConfidenceLevel below.
import { Text, View, StyleSheet } from "react-native";

import { colors, radius, spacing } from "../theme/tokens";

export type ConfidenceLevel = "high" | "medium" | "low";

export function toConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

const TONE: Record<ConfidenceLevel, { bg: string; fg: string }> = {
  high: { bg: "rgba(52,199,89,0.16)", fg: "#248a3d" },
  medium: { bg: "rgba(255,159,10,0.16)", fg: "#a15c00" },
  low: { bg: "rgba(255,59,48,0.16)", fg: colors.danger },
};

export function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  const tone = TONE[level];
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <Text style={[styles.label, { color: tone.fg }]}>{level}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    alignSelf: "flex-start",
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "capitalize",
  },
});
