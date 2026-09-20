// The opening: the mark assembles in the middle of the screen on the app's backdrop, holds
// a beat, and dissolves into the app — unhurried, not slow. Sits over the whole app until
// it is gone, then unmounts so it costs nothing afterwards.
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet } from "react-native";

import { LogoAnimated } from "./LogoAnimated";

const HOLD_MS = 1500;   // assembly (≈1.5 s) is the hold: the app appears as the breathing begins
const FADE_MS = 1100;   // the dissolve

export function Splash() {
  const [done, setDone] = useState(false);
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      const fade = Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: reduce ? 300 : FADE_MS, delay: reduce ? 400 : HOLD_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
        // The mark grows a touch as it fades, as if the app comes forward through it.
        Animated.timing(scale, { toValue: 1.06, duration: reduce ? 300 : FADE_MS, delay: reduce ? 400 : HOLD_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]);
      fade.start(({ finished }) => { if (finished && !cancelled) setDone(true); });
    });
    return () => { cancelled = true; };
  }, [opacity, scale]);

  if (done) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.screen, { opacity }]}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <LogoAnimated size={240} loop={false} />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#e8edf4", alignItems: "center", justifyContent: "center", zIndex: 1000 },
});
