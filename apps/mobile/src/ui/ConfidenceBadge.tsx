// A small coloured pill for a "high" | "medium" | "low" confidence value.
// RoomCapture v1 puts this on every wall and object; Object v1 puts a
// separate 0-1 confidence float on `measure` instead (contracts.md), so the
// object detail screen buckets that float into the same three labels
// before handing it to this component — see toConfidenceLevel below.
//
// Built on @expo/ui's Text + modifiers, not a plain RN View + Text: this
// nests inside a SwiftUI HStack/VStack (see PaletteSwatches.tsx for why a
// bare RN view can't).
import { Text } from "@expo/ui/swift-ui";
import { background, foregroundStyle, padding, shapes } from "@expo/ui/swift-ui/modifiers";

import { colors } from "../theme/tokens";

export type ConfidenceLevel = "high" | "medium" | "low";

export function toConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

const TONE: Record<ConfidenceLevel, { bg: string; fg: string }> = {
  high: { bg: "#d9f2df", fg: "#248a3d" },
  medium: { bg: "#fdead0", fg: "#a15c00" },
  low: { bg: "#fbdad8", fg: colors.danger },
};

export function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  const tone = TONE[level];
  const label = level.charAt(0).toUpperCase() + level.slice(1);
  return (
    <Text
      modifiers={[
        foregroundStyle(tone.fg),
        padding({ horizontal: 8, vertical: 2 }),
        background(tone.bg, shapes.capsule()),
      ]}
    >
      {label}
    </Text>
  );
}
