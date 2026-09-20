// One library row: name, a secondary line, measured size on the right, and the state capsule.
// Used by the Scanned and Furniture tabs. Plain SwiftUI text hierarchy — headline / subheadline
// / secondary — so it reads like Settings or Files, not like a card grid.
import { Button, HStack, Spacer, Text, VStack, Image } from "@expo/ui/swift-ui";
import { buttonStyle, font, foregroundStyle, lineLimit } from "@expo/ui/swift-ui/modifiers";

import { formatDimensionsCm } from "../lib/units";
import { StateBadge } from "./StateBadge";
import type { ObjectV1 } from "./types";

export type ObjectRowProps = {
  object: ObjectV1;
  // The secondary line, e.g. "Cedar Home · side table" or "lidar · 94%".
  subtitle: string;
  // Right column, top line. Price for catalog rows; nothing for scans.
  trailing?: string | null;
  onPress: () => void;
};

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });

export function ObjectRow({ object, subtitle, trailing, onPress }: ObjectRowProps) {
  const { w, h, d } = object.bboxMeters;
  return (
    <Button modifiers={[buttonStyle("plain")]} onPress={onPress}>
      <HStack spacing={12} alignment="center">
        <VStack alignment="leading" spacing={3}>
          <Text modifiers={[font({ textStyle: "headline" }), lineLimit(1)]}>{object.name}</Text>
          <Text modifiers={[font({ textStyle: "subheadline" }), secondary, lineLimit(1)]}>{subtitle}</Text>
          <StateBadge state={object.state} />
        </VStack>
        <Spacer />
        <VStack alignment="trailing" spacing={3}>
          {trailing ? <Text modifiers={[font({ textStyle: "body", weight: "semibold" })]}>{trailing}</Text> : null}
          <Text modifiers={[font({ textStyle: "footnote" }), secondary]}>{formatDimensionsCm(w, h, d)}</Text>
        </VStack>
        <Image systemName="chevron.right" size={13} color="#c7c7cc" />
      </HStack>
    </Button>
  );
}
