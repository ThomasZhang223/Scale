// The Scale mark, assembled: the base plate rises in, the glass plate settles, the top plate
// drops on, then the three breathe. A native rendering of logo-animation.html's "assemble"
// and "breathe" modes — same layer geometry, same timings, same easings — for every
// waiting moment in the app. Reduced-motion users see the assembled mark, still.
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native";

const BASE = require("../../assets/logo-anim/base.png");
const GLASS = require("../../assets/logo-anim/glass.png");
const TOP = require("../../assets/logo-anim/top.png");

// Percent of the square stage, from the HTML's .layer rules.
const LAYOUT = {
  base: { left: 0, top: 4.227, width: 98.565, height: 82.297 },
  glass: { left: 5.183, top: 1.675, width: 88.118, height: 94.976 },
  top: { left: 9.011, top: 15.789, width: 87.321, height: 70.574 },
};

const OUT_EXPO = Easing.bezier(0.16, 1, 0.3, 1);
const OVERSHOOT = Easing.bezier(0.3, 1.4, 0.5, 1);
const IN_OUT = Easing.inOut(Easing.sin);

export function LogoAnimated({ size = 160, loop = true }: { size?: number; loop?: boolean }) {
  const [reduce, setReduce] = useState(false);
  const baseIn = useRef(new Animated.Value(0)).current;   // 0 = before riseUp, 1 = assembled
  const glassIn = useRef(new Animated.Value(0)).current;
  const topIn = useRef(new Animated.Value(0)).current;
  const floorIn = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;  // 0 → 1 → 0 each cycle

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((r) => {
      if (cancelled) return;
      if (r) {
        setReduce(true);
        [baseIn, glassIn, topIn, floorIn].forEach((v) => v.setValue(1));
        return;
      }
      const assemble = Animated.parallel([
        Animated.timing(floorIn, { toValue: 1, duration: 900, delay: 280, easing: OUT_EXPO, useNativeDriver: true }),
        Animated.timing(baseIn, { toValue: 1, duration: 950, delay: 50, easing: OUT_EXPO, useNativeDriver: true }),
        Animated.timing(glassIn, { toValue: 1, duration: 1000, delay: 260, easing: OUT_EXPO, useNativeDriver: true }),
        Animated.timing(topIn, { toValue: 1, duration: 1050, delay: 420, easing: OVERSHOOT, useNativeDriver: true }),
      ]);
      const breathing = Animated.loop(
        Animated.sequence([
          Animated.timing(breathe, { toValue: 1, duration: 2100, easing: IN_OUT, useNativeDriver: true }),
          Animated.timing(breathe, { toValue: 0, duration: 2100, easing: IN_OUT, useNativeDriver: true }),
        ])
      );
      assemble.start(({ finished }) => {
        if (finished && loop && !cancelled) breathing.start();
      });
    });
    return () => {
      cancelled = true;
      breathe.stopAnimation();
    };
  }, [baseIn, glassIn, topIn, floorIn, breathe, loop]);

  const px = (pct: number) => (size * pct) / 100;
  const box = (l: { left: number; top: number; width: number; height: number }) => ({
    position: "absolute" as const,
    left: px(l.left),
    top: px(l.top),
    width: px(l.width),
    height: px(l.height),
  });

  // riseUp: from translateY +0.22S, scale .94, opacity 0. settle: from scale .8. dropIn: from
  // translateY −0.30S, scale 1.04. breathe: base +0.05S, glass ×1.035, top −0.06S.
  const baseStyle = {
    opacity: baseIn,
    transform: [
      { translateY: Animated.add(baseIn.interpolate({ inputRange: [0, 1], outputRange: [size * 0.22, 0] }), breathe.interpolate({ inputRange: [0, 1], outputRange: [0, size * 0.05] })) },
      { scale: baseIn.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
    ],
  };
  const glassStyle = {
    opacity: glassIn.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] }),
    transform: [
      { scale: Animated.multiply(glassIn.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }), breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] })) },
    ],
  };
  const topStyle = {
    opacity: topIn,
    transform: [
      { translateY: Animated.add(topIn.interpolate({ inputRange: [0, 1], outputRange: [-size * 0.3, 0] }), breathe.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.06] })) },
      { scale: topIn.interpolate({ inputRange: [0, 1], outputRange: [1.04, 1] }) },
    ],
  };
  const floorStyle = {
    opacity: floorIn.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
    transform: [{ scale: floorIn.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }],
  };

  return (
    <View style={{ width: size, height: size }} accessibilityLabel="Scale" accessible>
      <Animated.View style={[styles.floor, { left: px(12), top: px(63), width: px(76), height: px(26), borderRadius: px(38) }, reduce ? undefined : floorStyle]} />
      <Animated.Image source={BASE} style={[box(LAYOUT.base), reduce ? undefined : baseStyle]} resizeMode="contain" />
      <Animated.Image source={GLASS} style={[box(LAYOUT.glass), reduce ? undefined : glassStyle]} resizeMode="contain" />
      <Animated.Image source={TOP} style={[box(LAYOUT.top), reduce ? undefined : topStyle]} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  // The soft floor shadow under the stack: a low-alpha ellipse stands in for the blurred radial.
  floor: { position: "absolute", backgroundColor: "rgba(11,60,140,0.16)" },
});
