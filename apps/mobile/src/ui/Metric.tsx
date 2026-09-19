// A labelled value pair, built on @expo/ui's LabeledContent. Reused across
// the Rooms list (area, wall count, version count), the Objects grid
// (dimensions), the object detail screen (the three measured metrics), and
// the Headset diagnostics section (API base, health, SSE state) — four
// call sites, which is what earns this its own file rather than living
// inline in one screen.
import { LabeledContent, Text } from "@expo/ui/swift-ui";
import type { CommonViewModifierProps } from "@expo/ui/swift-ui";

export type MetricProps = CommonViewModifierProps & {
  label: string;
  value: string;
};

export function Metric({ label, value, ...rest }: MetricProps) {
  return (
    <LabeledContent label={label} {...rest}>
      <Text>{value}</Text>
    </LabeledContent>
  );
}
