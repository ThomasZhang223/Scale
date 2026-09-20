// Liquid Glass for the SwiftUI library screens: one gradient backdrop, and
// every section a single glass card. Pair with `glassList` on the List.
//
// Why cards instead of insetGrouped rows: Liquid Glass refracts what is
// behind it, and a flat system-grey list background gives it nothing to
// refract — it reads as plain frosted white. The backdrop is the quiet
// part; the glass is the material. The capture overlays get the same
// material from expo-glass-effect (src/theme/Glass.tsx) because they float
// over RN-hosted camera views instead.
import { Children, Fragment, type ReactNode } from "react";
import { Divider, Host, Section, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import type { HostProps } from "@expo/ui/swift-ui";
import {
  background,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  ignoreSafeArea,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listSectionSpacing,
  listStyle,
  padding,
  scrollContentBackground,
} from "@expo/ui/swift-ui/modifiers";

// Cool, low-saturation wash: enough for the glass to catch, never a poster.
// Same hue family as the LiDAR cyan the capture screens use.
export const backdrop = background({
  type: "linearGradient",
  colors: ["#dfe9f3", "#eef1f6", "#e6e2f2"],
  startPoint: { x: 0, y: 0 },
  endPoint: { x: 1, y: 1 },
});

export const glassList = [listStyle("plain"), scrollContentBackground("hidden"), listSectionSpacing(6)];

const card = [
  frame({ maxWidth: 10000, alignment: "leading" }),
  glassEffect({ glass: { variant: "regular" }, shape: "roundedRectangle", cornerRadius: 22 }),
];

const rowInsets = listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 });

// A List host on the gradient backdrop. Drop-in for `<Host style={{flex:1}}>`.
export function GlassHost({ children, ...rest }: HostProps) {
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement {...rest}>
      <ZStack>
        {/* The gradient alone runs under the status bar and tab bar; the
            content keeps its safe-area insets, so titles never sit under
            the clock. */}
        <VStack modifiers={[frame({ maxWidth: 10000, maxHeight: 10000 }), backdrop, ignoreSafeArea()]}>
          <Spacer />
        </VStack>
        {children}
      </ZStack>
    </Host>
  );
}

export type GlassSectionProps = {
  title?: string;
  footer?: ReactNode;
  // Draw hairlines between rows. Off for sections that are one control.
  divided?: boolean;
  children: ReactNode;
};

export function GlassSection({ title, footer, divided = true, children }: GlassSectionProps) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <Section modifiers={[listRowBackground("clear"), listRowSeparator("hidden"), rowInsets]}>
      {title ? (
        <Text
          modifiers={[
            font({ textStyle: "subheadline", weight: "semibold" }),
            foregroundStyle({ type: "hierarchical", style: "secondary" }),
            padding({ leading: 10, top: 6 }),
          ]}
        >
          {title}
        </Text>
      ) : null}
      <VStack alignment="leading" spacing={0} modifiers={card}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 && divided ? <Divider modifiers={[padding({ leading: 16 })]} /> : null}
            <VStack alignment="leading" modifiers={[padding({ horizontal: 16, vertical: 12 }), frame({ maxWidth: 10000, alignment: "leading" })]}>
              {row}
            </VStack>
          </Fragment>
        ))}
      </VStack>
      {footer ? <VStack modifiers={[padding({ leading: 10, top: 2 })]}>{footer}</VStack> : null}
    </Section>
  );
}
