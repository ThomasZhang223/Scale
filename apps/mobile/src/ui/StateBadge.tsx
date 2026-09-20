// A capsule for Object v1's `state` — the perceived-latency machine from contracts.md. Same
// construction as ConfidenceBadge so the two read as one family on a row.
import { Text } from "@expo/ui/swift-ui";
import { background, font, foregroundStyle, padding, shapes } from "@expo/ui/swift-ui/modifiers";

import type { ObjectV1 } from "./types";

const TONE: Record<ObjectV1["state"], { bg: string; fg: string; label: string }> = {
  measured: { bg: "rgba(120,120,128,0.16)", fg: "#636366", label: "Measured" },
  generating: { bg: "#dbe9ff", fg: "#1f5fd1", label: "Generating" },
  ready: { bg: "#d9f2df", fg: "#248a3d", label: "3D ready" },
  failed: { bg: "#fbdad8", fg: "#c62d25", label: "Failed" },
};

export function StateBadge({ state }: { state: ObjectV1["state"] }) {
  const tone = TONE[state] ?? TONE.measured;
  return (
    <Text
      modifiers={[
        font({ textStyle: "caption", weight: "semibold" }),
        foregroundStyle(tone.fg),
        padding({ horizontal: 8, vertical: 3 }),
        background(tone.bg, shapes.capsule()),
      ]}
    >
      {tone.label}
    </Text>
  );
}
