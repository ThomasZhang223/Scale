import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { withTabFade } from "../../src/ui/TabFade";

import { colors, radius, spacing } from "../../src/theme/tokens";

// Three equal white tiles, centred on the page, no favourite among them.
function CaptureHubScreen() {
  const router = useRouter();

  async function startCapture(path: "/capture/object" | "/capture/object3d" | "/capture/box") {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push(path);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.tiles}>
        <Tile
          title="Photograph the walls"
          detail="One photo per wall, straightened and measured. For rooms the scan can't read."
          icon="square.stack.3d.up.fill"
          onPress={() => startCapture("/capture/box")}
        />
        <Tile
          title="Capture an object in 3D"
          detail="Walk around it. A textured model at true size, built on this phone."
          icon="cube.fill"
          onPress={() => startCapture("/capture/object3d")}
        />
        <Tile
          title="Measure an object"
          detail="Set it on a table, tap it once. A size in under a second, no model."
          icon="ruler.fill"
          onPress={() => startCapture("/capture/object")}
        />
      </View>

    </ScrollView>
  );
}

function Tile({ title, detail, icon, onPress }: { title: string; detail: string; icon: SFSymbol; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [pressed && styles.pressed]}>
      <View style={styles.tile}>
        <SymbolView name={icon} size={30} tintColor={colors.accent} weight="medium" />
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileDetail}>{detail}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#e8edf4" },
  content: { flexGrow: 1, padding: spacing.md, paddingTop: spacing.xl * 2, paddingBottom: spacing.xl * 3, justifyContent: "center" },
  tiles: { gap: spacing.md },
  // Solid white, rounded, a whisper of edge: the glass wrapper was invisible
  // on this backdrop (Liquid Glass with nothing behind it to refract).
  tile: {
    borderRadius: radius.xl,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.86)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(60,60,67,0.12)",
    alignItems: "center",
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: 6,
  },
  tileTitle: { fontSize: 20, fontWeight: "600", color: "#1c1c1e", textAlign: "center", marginTop: 4 },
  tileDetail: { fontSize: 14, color: colors.textMuted, textAlign: "center", lineHeight: 19, maxWidth: 280 },
  pressed: { opacity: 0.8 },
});

export default withTabFade(CaptureHubScreen);
