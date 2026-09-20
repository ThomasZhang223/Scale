// Scanned — every object this phone measured or captured, newest first. Source "scan" only.
// The state capsule is the whole generation story: Measured (box only) → Generating →
// 3D ready (a GLB the Quest can load).
import { useCallback } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { withTabFade } from "../../src/ui/TabFade";

import { Card } from "../../src/ui/Card";
import { colors, radius, spacing } from "../../src/theme/tokens";
import { ErrorView } from "../../src/ui/ErrorView";
import { LoadingView } from "../../src/ui/LoadingView";
import { ObjectCard } from "../../src/ui/ObjectCard";
import { listObjects } from "../../src/ui/objectsApi";
import { useFetchState } from "../../src/ui/useFetchState";

function subtitleFor(method: string, confidence: number): string {
  const pct = Math.round(confidence * 100);
  return `${method === "lidar" ? "LiDAR" : method} · ${pct}% confidence`;
}

function ScannedScreen() {
  const router = useRouter();
  const [state, retry] = useFetchState(() => listObjects("scan"), []);

  // A scan made on another tab lands here on the next visit, not on the next app launch.
  useFocusEffect(
    useCallback(() => {
      retry();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  const objects = state.data;
  const ready = objects.filter((o) => o.state === "ready").length;

  if (objects.length === 0) {
    // Flat on the backdrop, centred: an invitation, not a card.
    return (
      <View style={styles.empty}>
        <SymbolView name="cube.transparent" size={56} tintColor="rgba(60,60,67,0.45)" weight="light" />
        <Text style={styles.emptyTitle}>No scans yet</Text>
        <Text style={styles.emptyText}>Capture an object in 3D or measure one with a tap. It appears here right away.</Text>
        <Pressable onPress={() => router.push("/capture/object3d")} style={({ pressed }) => [styles.emptyButton, pressed && styles.pressed]}>
          <SymbolView name="viewfinder" size={16} tintColor="white" weight="semibold" />
          <Text style={styles.emptyButtonText}>Capture an object</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={false} onRefresh={retry} />}
    >
      <Text style={styles.heading}>Scanned</Text>
      <Card style={styles.card}>
        {objects.map((object, i) => (
          <View key={object.objectId} style={i > 0 && styles.divider}>
            <ObjectCard
              object={object}
              subtitle={subtitleFor(object.measure.method, object.measure.confidence)}
              onPress={() => router.push({ pathname: "/object/[id]", params: { id: object.objectId } })}
            />
          </View>
        ))}
      </Card>
      <Text style={styles.footer}>{`${objects.length} object${objects.length === 1 ? "" : "s"} · ${ready} with 3D`}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#e8edf4" },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl * 2 },
  heading: { fontSize: 34, fontWeight: "700", color: "#1c1c1e", letterSpacing: 0.2, paddingHorizontal: 4, paddingTop: spacing.sm, marginBottom: 4 },
  card: {},
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(60,60,67,0.18)" },
  footer: { fontSize: 13, color: colors.textMuted, paddingHorizontal: 10, paddingTop: 4 },
  empty: { flex: 1, backgroundColor: "#e8edf4", alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: 22, fontWeight: "600", color: "#1c1c1e", marginTop: spacing.sm },
  emptyText: { fontSize: 15, color: colors.textMuted, textAlign: "center", lineHeight: 21, maxWidth: 300 },
  emptyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    marginTop: spacing.md,
  },
  emptyButtonText: { color: "white", fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.8 },
});

export default withTabFade(ScannedScreen);
