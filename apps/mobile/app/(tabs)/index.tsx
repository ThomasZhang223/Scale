import { useCallback } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SymbolView } from "expo-symbols";
import { withTabFade } from "../../src/ui/TabFade";

import { getJSON } from "../../src/lib/api";
import { Card } from "../../src/ui/Card";
import { colors, radius, spacing } from "../../src/theme/tokens";
import { DEMO_ROOM_ID } from "../../src/ui/demoIds";
import { EmptyState } from "../../src/ui/EmptyState";
import { ErrorView } from "../../src/ui/ErrorView";
import { FloorPlan } from "../../src/ui/FloorPlan";
import { GlassHost } from "../../src/ui/glass";
import { LoadingView } from "../../src/ui/LoadingView";
import { localRoomIds, roomPhotoUri } from "../../src/ui/roomPhotos";
import { SymbolView as Symbol } from "expo-symbols";
import type { RoomCaptureV1, VersionSummary } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";

type RoomsPayload = {
  rooms: RoomCaptureV1[];
  versionCount: number | null;
};

async function fetchRoomsPayload(): Promise<RoomsPayload> {
  const room = await getJSON<RoomCaptureV1>(`/v1/rooms/${DEMO_ROOM_ID}`, {
    stub: true,
    schemaLabel: "RoomCapture v1",
  });
  // Best-effort: fixtures/README.md commits only four fixtures, and this
  // endpoint's stub answer isn't one of them, so its exact shape is
  // whatever Panel C's Worker improvises. A failure here degrades the
  // version-count metric to "unknown" rather than breaking the screen —
  // this is missing data, not a guessed decision (CLAUDE.md "Fail loud"
  // targets the latter).
  let versionCount: number | null = null;
  try {
    const versions = await getJSON<VersionSummary[]>(`/v1/rooms/${DEMO_ROOM_ID}/versions`, {
      stub: true,
    });
    versionCount = versions.length;
  } catch {
    versionCount = null;
  }
  // Rooms built on this phone (photo upload, wall capture): live reads, newest first. One
  // failing id does not hide the rest.
  const local = await Promise.all(
    localRoomIds().map((id) => getJSON<RoomCaptureV1>(`/v1/rooms/${id}`, { schemaLabel: "RoomCapture v1" }).catch(() => null))
  );
  return { rooms: [...local.filter((r): r is RoomCaptureV1 => r !== null), room], versionCount };
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Plain React Native on purpose: the card's header is a photo (RN Image)
// or the FloorPlan drawing, neither of which can live inside a SwiftUI
// Host. The glass comes from expo-glass-effect instead — same material as
// the capture overlays.
function RoomsScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [state, retry] = useFetchState(fetchRoomsPayload, []);

  // A scan made on another tab lands here on the next visit, not on the next app launch.
  useFocusEffect(
    useCallback(() => {
      retry();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  const { rooms, versionCount } = state.data;

  if (rooms.length === 0) {
    return (
      <GlassHost>
        <EmptyState
          title="No rooms yet"
          systemImage="house"
          description="Scan a room from the Capture tab to see it here."
        />
      </GlassHost>
    );
  }

  const cardWidth = width - spacing.md * 2;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.headingRow}>
        <Text style={styles.heading}>Rooms</Text>
        <Pressable onPress={() => router.push("/room/new")} style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}>
          <Symbol name="photo.on.rectangle.angled" size={15} tintColor="white" weight="semibold" />
          <Text style={styles.newButtonText}>New from photos</Text>
        </Pressable>
      </View>
      {rooms.map((r) => {
        const photo = roomPhotoUri(r.roomId);
        return (
          <Pressable
            key={r.roomId}
            onPress={() => router.push({ pathname: "/room/[id]", params: { id: r.roomId } })}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <Card style={styles.card}>
              <View style={styles.header}>
                {photo ? (
                  <Image source={{ uri: photo }} style={styles.photo} resizeMode="cover" />
                ) : (
                  <View style={styles.planWrap}>
                    <FloorPlan room={r} width={cardWidth - spacing.lg * 2} />
                  </View>
                )}
              </View>
              <View style={styles.body}>
                <View style={styles.titleRow}>
                  <View style={styles.titleCol}>
                    <Text style={styles.title}>{`${r.floor.areaM2.toFixed(1)} m² room`}</Text>
                    <Text style={styles.subtitle}>{timeAgo(r.capturedAt)}</Text>
                  </View>
                  <SymbolView name="chevron.right" size={14} tintColor="rgba(60,60,67,0.3)" />
                </View>
                <View style={styles.metrics}>
                  <Metric label="Area" value={`${r.floor.areaM2.toFixed(1)} m²`} />
                  <Metric label="Walls" value={`${r.walls.length}`} />
                  <Metric label="Openings" value={`${r.openings.length}`} />
                  <Metric label="Versions" value={versionCount === null ? "—" : `${versionCount}`} />
                </View>
              </View>
            </Card>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#e8edf4" },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl * 2 },
  headingRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", paddingTop: spacing.sm, paddingHorizontal: 4 },
  heading: { fontSize: 34, fontWeight: "700", color: "#1c1c1e", letterSpacing: 0.2 },
  newButton: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.accent, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, marginBottom: 6 },
  newButtonText: { color: "white", fontSize: 14, fontWeight: "600" },
  card: {},
  header: { backgroundColor: "rgba(255,255,255,0.35)" },
  photo: { width: "100%", aspectRatio: 4 / 3 },
  planWrap: { alignItems: "center", justifyContent: "center", paddingVertical: spacing.lg },
  body: { padding: spacing.md, gap: spacing.md },
  titleRow: { flexDirection: "row", alignItems: "center" },
  titleCol: { flex: 1, gap: 2 },
  title: { fontSize: 20, fontWeight: "600", color: "#1c1c1e" },
  subtitle: { fontSize: 14, color: colors.textMuted },
  metrics: { flexDirection: "row", justifyContent: "space-between" },
  metric: { alignItems: "flex-start", minWidth: 64 },
  metricValue: { fontSize: 17, fontWeight: "600", color: "#1c1c1e", fontVariant: ["tabular-nums"] },
  metricLabel: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  pressed: { opacity: 0.85 },
});

export default withTabFade(RoomsScreen);
