// Full-screen "building the model" state for the 3D capture. Shown once the
// camera session is done and photogrammetry is running, when the capture
// view underneath has nothing to show. Light, not black: the phone is doing
// work, not failing.
//
// Plain React Native + Animated (no reanimated worklets), because this sits
// in the RN-hosted capture screen rather than a SwiftUI Host.
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";

import { colors, spacing } from "../theme/tokens";
import { LogoAnimated } from "./LogoAnimated";

type BuildProgressProps = {
  fraction: number; // 0..1
  title: string;
  detail: string;
};

const RING = 148;
const STROKE = 10;

export function BuildProgress({ fraction, title, detail }: BuildProgressProps) {
  const width = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(width, {
      toValue: Math.max(0.02, Math.min(1, fraction)),
      duration: 350,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [fraction, width]);

  const pct = Math.round(fraction * 100);

  return (
    <View style={styles.screen}>
      <View style={styles.center}>
        {/* The mark assembling and breathing: the app's own "working" motion. */}
        <LogoAnimated size={RING} />
        <Text style={styles.pct}>{pct}%</Text>

        <Text style={styles.title}>{title}</Text>
        <Text style={styles.detail}>{detail}</Text>

        <View style={styles.track}>
          <Animated.View
            style={[
              styles.fill,
              { width: width.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) },
            ]}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#f6f8fb" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  pct: { fontSize: 32, fontWeight: "600", color: "#1c1c1e", fontVariant: ["tabular-nums"], letterSpacing: -0.5, marginTop: spacing.sm },
  title: { fontSize: 20, fontWeight: "600", color: "#1c1c1e", textAlign: "center" },
  detail: { fontSize: 15, color: "rgba(60,60,67,0.6)", textAlign: "center", lineHeight: 21 },
  track: {
    alignSelf: "stretch",
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(120,120,128,0.16)",
    marginTop: spacing.lg,
    overflow: "hidden",
  },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.lidar },
});
