// The Scale mark. Colour on light pages, monochrome over camera views.
import { Image, StyleSheet, Text, View, type ImageStyle, type StyleProp } from "react-native";

const COLOR = require("../../assets/scale-logo.png");
const MONO = require("../../assets/scale-logo-mono.png");

export function Logo({ size = 28, mono = false, style }: { size?: number; mono?: boolean; style?: StyleProp<ImageStyle> }) {
  return <Image source={mono ? MONO : COLOR} style={[{ width: size, height: size }, style]} resizeMode="contain" />;
}

/** A page heading with the mark beside it: every library tab opens with one. */
export function PageHeading({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Logo size={46} />
        <Text style={styles.title}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

/** The mark in a stack header, next to the page title. */
export function HeaderTitle({ title }: { title: string }) {
  return (
    <View style={styles.header}>
      <Logo size={28} />
      <Text style={styles.headerText}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", paddingTop: 8, paddingHorizontal: 4 },
  left: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 34, fontWeight: "700", color: "#1c1c1e", letterSpacing: 0.2 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerText: { fontSize: 17, fontWeight: "600", color: "#1c1c1e" },
});
