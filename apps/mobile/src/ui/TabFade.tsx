// A fade-in every time a tab gains focus. UITabBarController switches tabs
// with a hard cut and gives us no hook on the outgoing tab, so the incoming
// content eases from transparent over a short beat instead; from a thumb's
// point of view it reads as a crossfade. Reduced-motion users get no fade.
import { useCallback, useRef, type ComponentType } from "react";
import { useFocusEffect } from "expo-router";
import { AccessibilityInfo, Animated, Easing, StyleSheet } from "react-native";

export function withTabFade<P extends object>(Screen: ComponentType<P>): ComponentType<P> {
  function Faded(props: P) {
    const opacity = useRef(new Animated.Value(0)).current;
    const translate = useRef(new Animated.Value(6)).current;

    useFocusEffect(
      useCallback(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
          if (cancelled) return;
          if (reduce) {
            opacity.setValue(1);
            translate.setValue(0);
            return;
          }
          opacity.setValue(0);
          translate.setValue(6);
          Animated.parallel([
            Animated.timing(opacity, { toValue: 1, duration: 520, easing: Easing.out(Easing.quad), useNativeDriver: true }),
            Animated.timing(translate, { toValue: 0, duration: 560, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          ]).start();
        });
        return () => {
          cancelled = true;
          opacity.setValue(0);
        };
      }, [opacity, translate])
    );

    return (
      <Animated.View style={[styles.fill, { opacity, transform: [{ translateY: translate }] }]}>
        <Screen {...props} />
      </Animated.View>
    );
  }
  Faded.displayName = `withTabFade(${Screen.displayName ?? Screen.name ?? "Screen"})`;
  return Faded;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
