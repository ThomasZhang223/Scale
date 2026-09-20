// The library card: solid white, rounded, a hairline edge. One component so
// every tab's boxes match. Liquid Glass stays on the capture overlays, where
// there is a camera image behind it to refract; on the flat library
// backdrop it rendered as nothing at all.
import { StyleSheet, View, type ViewProps } from "react-native";

import { radius } from "../theme/tokens";

export function Card({ style, children, ...rest }: ViewProps) {
  return (
    <View style={[styles.card, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.86)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(60,60,67,0.12)",
  },
});
