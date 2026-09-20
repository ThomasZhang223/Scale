import { GlassView, isLiquidGlassAvailable, type GlassViewProps } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { colors, radius, spacing } from "./tokens";

// The one place that checks isLiquidGlassAvailable(). Every screen renders
// through these wrappers instead of importing expo-glass-effect directly, so
// the pre-iOS-26 fallback lives in exactly one file.
//
// Everything here is plain React Native, on purpose: these controls float
// over the AR camera views (modules/room-capture, modules/object-measure),
// which are RN-hosted native views. @expo/ui's SwiftUI tree cannot be
// layered over them, so the capture overlays get their glass from
// expo-glass-effect instead of from the glassEffect() SwiftUI modifier the
// library screens use. Same material, two hosts.

export function Glass({ style, children, colorScheme, ...rest }: GlassViewProps) {
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView style={style} colorScheme={colorScheme} {...rest}>
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[styles.fallback, colorScheme === "dark" && styles.fallbackDark, style]}>
      {children}
    </View>
  );
}

// Over a live camera feed the background is anything: a white table, a dark
// doorway, a red chair. Forcing the glass into its dark appearance is what
// keeps white text legible on all of them — the first on-device screenshot
// had white digits on light glass over a grey desk, and they vanished.
export function CameraGlass({ style, children, ...rest }: GlassViewProps) {
  return (
    <Glass style={[styles.cameraGlass, style]} colorScheme="dark" {...rest}>
      {children}
    </Glass>
  );
}

type GlassButtonProps = {
  label: string;
  onPress: () => void | Promise<void>;
  // Prominent = tinted, the one action the screen is for. At most one per
  // screen. Quiet = clear glass, for "measure again" and friends.
  prominent?: boolean;
  tint?: string;
  icon?: SFSymbol;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function GlassButton({ label, onPress, prominent, tint, icon, disabled, style }: GlassButtonProps) {
  const tintColor = prominent ? (tint ?? colors.accent) : undefined;
  return (
    <Pressable
      disabled={disabled}
      onPress={async () => {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        await onPress();
      }}
      style={({ pressed }) => [pressed && styles.pressed, disabled && styles.disabled, style]}
    >
      <CameraGlass
        isInteractive
        tintColor={tintColor}
        glassEffectStyle={prominent ? "regular" : "clear"}
        style={[styles.button, prominent && styles.buttonProminent]}
      >
        {icon ? <SymbolView name={icon} tintColor="white" size={17} weight="semibold" /> : null}
        <Text style={[styles.buttonLabel, prominent && styles.buttonLabelProminent]}>{label}</Text>
      </CameraGlass>
    </Pressable>
  );
}

// The round "x" in the top corner of both capture screens. Before this the
// only way out of a scan was the status-bar back link.
// `dark` = the icon is dark, for the light build/result screens.
export function GlassCloseButton({ onPress, style, dark }: { onPress: () => void; style?: StyleProp<ViewStyle>; dark?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Close"
      hitSlop={12}
      style={({ pressed }) => [pressed && styles.pressed, style]}
    >
      {dark ? (
        <Glass isInteractive style={[styles.cameraGlass, styles.closeButton]}>
          <SymbolView name="xmark" tintColor="#1c1c1e" size={15} weight="bold" />
        </Glass>
      ) : (
        <CameraGlass isInteractive style={styles.closeButton}>
          <SymbolView name="xmark" tintColor="white" size={15} weight="bold" />
        </CameraGlass>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: colors.surfaceFallback,
    borderRadius: radius.md,
  },
  fallbackDark: {
    backgroundColor: "rgba(28,28,30,0.72)",
  },
  cameraGlass: {
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  buttonProminent: {
    paddingHorizontal: spacing.xl,
  },
  buttonLabel: { color: "white", fontSize: 16, fontWeight: "600" },
  buttonLabelProminent: { fontSize: 17 },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { transform: [{ scale: 0.97 }] },
  disabled: { opacity: 0.45 },
});
