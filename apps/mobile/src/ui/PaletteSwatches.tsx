// A row of small colour circles from Object v1's `palette` field (hex
// strings). Used by the Objects grid tile and the object detail screen.
//
// Plain React Native, not @expo/ui: a coloured circle is one View with a
// backgroundColor and a borderRadius, and @expo/ui has no simpler native
// primitive for it than that.
import { View, StyleSheet } from "react-native";

export type PaletteSwatchesProps = {
  colors: string[];
  size?: number;
};

export function PaletteSwatches({ colors, size = 16 }: PaletteSwatchesProps) {
  return (
    <View style={styles.row}>
      {colors.map((hex, i) => (
        <View
          key={`${hex}-${i}`}
          style={[
            styles.swatch,
            { width: size, height: size, borderRadius: size / 2, backgroundColor: hex },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 6,
  },
  swatch: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.1)",
  },
});
