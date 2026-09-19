// A row of small colour circles from Object v1's `palette` field (hex
// strings). Used by the Objects grid tile and the object detail screen.
//
// Built on @expo/ui's Circle shape, not a plain RN View: this nests inside
// a SwiftUI HStack/VStack, and a plain RN view cannot — @expo/ui's SwiftUI
// tree only accepts its own primitives (or RNHostView, its explicit escape
// hatch) as children, never a bare react-native View.
import { HStack, Circle } from "@expo/ui/swift-ui";
import { foregroundStyle, frame } from "@expo/ui/swift-ui/modifiers";

export type PaletteSwatchesProps = {
  colors: string[];
  size?: number;
};

export function PaletteSwatches({ colors, size = 16 }: PaletteSwatchesProps) {
  return (
    <HStack spacing={6}>
      {colors.map((hex, i) => (
        <Circle key={`${hex}-${i}`} modifiers={[foregroundStyle(hex), frame({ width: size, height: size })]} />
      ))}
    </HStack>
  );
}
