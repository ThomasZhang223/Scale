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

type BuildProgressProps = {
  fraction: number; // 0..1
  title: string;
  detail: string;
};

const RING = 148;
const STROKE = 10;

export function BuildProgress({ fraction, title, detail }: BuildProgressProps) {
  const spin = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const width = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true })
    );
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    breathe.start();
    return () => {
      loop.stop();
      breathe.stop();
    };
  }, [spin, pulse]);

  useEffect(() => {
    Animated.timing(width, {
      toValue: Math.max(0.02, Math.min(1, fraction)),
      duration: 350,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [fraction, width]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  const pct = Math.round(fraction * 100);

  return (
    <View style={styles.screen}>
      <View style={styles.center}>
        {/* A spinning arc around a breathing disc: motion that says "working",
            with the number inside so the eye has one place to rest. */}
        <View style={styles.ringWrap}>
          <Animated.View style={[styles.arc, { transform: [{ rotate }] }]} />
          <Animated.View style={[styles.disc, { transform: [{ scale }] }]}>
            <Text style={styles.pct}>{pct}%</Text>
          </Animated.View>
        </View>

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
  ringWrap: { width: RING, height: RING, alignItems: "center", justifyContent: "center", marginBottom: spacing.md },
  arc: {
    position: "absolute",
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: STROKE,
    borderColor: "rgba(90,200,250,0.18)",
    borderTopColor: colors.lidar,
    borderRightColor: colors.accent,
  },
  disc: {
    width: RING - STROKE * 2 - 14,
    height: RING - STROKE * 2 - 14,
    borderRadius: RING,
    backgroundColor: "white",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#1c1c1e",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  pct: { fontSize: 32, fontWeight: "600", color: "#1c1c1e", fontVariant: ["tabular-nums"], letterSpacing: -0.5 },
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
