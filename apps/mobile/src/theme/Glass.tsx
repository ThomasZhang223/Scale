import { GlassView, isLiquidGlassAvailable, type GlassViewProps } from "expo-glass-effect";
import { View, StyleSheet } from "react-native";

import { colors, radius } from "./tokens";

// The one place that checks isLiquidGlassAvailable(). Every screen renders
// through this wrapper instead of importing expo-glass-effect directly, so
// the pre-iOS-26 fallback lives in exactly one file.
export function Glass({ style, children, ...rest }: GlassViewProps) {
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView style={style} {...rest}>
        {children}
      </GlassView>
    );
  }
  return <View style={[styles.fallback, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: colors.surfaceFallback,
    borderRadius: radius.md,
  },
});
