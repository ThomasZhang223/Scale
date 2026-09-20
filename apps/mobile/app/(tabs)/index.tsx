import { useCallback, useMemo, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SymbolView } from "expo-symbols";
import { withTabFade } from "../../src/ui/TabFade";

import { getJSON } from "../../src/lib/api";
import { Card } from "../../src/ui/Card";
import { colors, radius, spacing } from "../../src/theme/tokens";
import { DEMO_ROOM_ID, SEED_ROOM_IDS } from "../../src/ui/demoIds";
import { EmptyState } from "../../src/ui/EmptyState";
import { ErrorView } from "../../src/ui/ErrorView";
import { RoomInsideView } from "../../src/ui/RoomInsideView";
import { GlassHost } from "../../src/ui/glass";
import { LoadingView } from "../../src/ui/LoadingView";
import { activeRoomId, localRoomIds, roomPhotoSource, setActiveRoomId } from "../../src/ui/roomPhotos";
import { setActiveRoomOnHeadset } from "../../src/lib/devServer";
import { SymbolView as Symbol } from "expo-symbols";
import { PageHeading } from "../../src/ui/Logo";
import type { RoomCaptureV1, VersionSummary } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";

type RoomsPayload = {
  rooms: RoomCaptureV1[];
  versionCount: Record<string, number | null>;
  failed: { id: string; error: string }[];
};

async function versionCountFor(roomId: string, stub: boolean): Promise<number | null> {
  try {
    const versions = await getJSON<VersionSummary[]>(`/v1/rooms/${roomId}/versions`, { stub });
    return versions.length;
  } catch {
    // Missing data, not a guessed decision: the metric reads "—".
    return null;
  }
}

async function fetchRoomsPayload(): Promise<RoomsPayload> {
  // Best-effort: fixtures/README.md commits only four fixtures, and this
  // endpoint's stub answer isn't one of them, so its exact shape is
  // whatever Panel C's Worker improvises. A failure here degrades the
  // version-count metric to "unknown" rather than breaking the screen —
  // this is missing data, not a guessed decision (CLAUDE.md "Fail loud"
  // targets the latter).
  // Rooms built on this phone (photo upload, wall capture) and the seeded rooms: live reads, newest
  // first, then the demo fixture. One failing id — the demo fixture included — does not hide the
  // rest, but it is reported, not dropped (CLAUDE.md "Fail loud").
  const localIds = localRoomIds();
  const targets = [
    ...[...localIds, ...SEED_ROOM_IDS.filter((id) => !localIds.includes(id))].map((id) => ({ id, stub: false })),
    { id: DEMO_ROOM_ID, stub: true },
  ];
  const settled = await Promise.all(
    targets.map(({ id, stub }) =>
      getJSON<RoomCaptureV1>(`/v1/rooms/${id}`, { stub, schemaLabel: "RoomCapture v1" }).then(
        (r) => ({ room: r }),
        (err: unknown) => ({ id, error: err instanceof Error ? err.message : String(err) })
      )
    )
  );
  const rooms = settled.flatMap((r) => ("room" in r ? [r.room] : []));
  const failed = settled.flatMap((r) => ("error" in r ? [r] : []));
  // Every room failing is an error screen with the reason, not an empty list that reads "no rooms".
  if (rooms.length === 0 && failed.length > 0) throw new Error(failed[0].error);
  const counts = await Promise.all(rooms.map((r) => versionCountFor(r.roomId, r.roomId === DEMO_ROOM_ID)));
  const versionCount = Object.fromEntries(rooms.map((r, i) => [r.roomId, counts[i]]));
  return { rooms, versionCount, failed };
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
  // The last list that loaded. A refresh that fails (a dropped connection on tab focus) keeps showing
  // it under a warning, instead of swapping a list you were just reading for a full-screen error.
  const lastGood = useRef<RoomsPayload | null>(null);
  if (state.status === "ready") lastGood.current = state.data;
  const shown = state.status === "ready" ? state.data : lastGood.current;
  // roomPhotoSource stats the documents folder synchronously; do it once per fetched list, not on
  // every render of five cards.
  const photos = useMemo(
    () => Object.fromEntries((shown?.rooms ?? []).map((r) => [r.roomId, roomPhotoSource(r.roomId)])),
    [shown]
  );
  const [selected, setSelected] = useState<string | null>(() => activeRoomId());
  const [sending, setSending] = useState<string | null>(null);

  // Picking a room makes it the headset's surroundings: remembered here, and posted to the
  // XR dev server the Quest polls (src/lib/devServer.ts).
  const choose = useCallback(async (roomId: string) => {
    setSelected(roomId);
    setActiveRoomId(roomId);
    setSending(roomId);
    try {
      await setActiveRoomOnHeadset(roomId);
    } catch (e) {
      Alert.alert("Selected on the phone, not on the headset", e instanceof Error ? e.message : String(e));
    } finally {
      setSending(null);
    }
  }, []);

  // A scan made on another tab lands here on the next visit, not on the next app launch.
  useFocusEffect(
    useCallback(() => {
      retry();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  if (!shown) {
    if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;
    return <LoadingView />;
  }

  const { rooms, versionCount, failed } = shown;

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
      <PageHeading
        title="Rooms"
        right={
          <Pressable onPress={() => router.push("/room/new")} style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}>
            <Symbol name="photo.on.rectangle.angled" size={15} tintColor="white" weight="semibold" />
            <Text style={styles.newButtonText}>New from photos</Text>
          </Pressable>
        }
      />
      {state.status === "error" ? <Text style={styles.warn}>{`Could not refresh: ${state.message}`}</Text> : null}
      {failed.length > 0 ? (
        <Text style={styles.warn}>{`${failed.length} room${failed.length === 1 ? "" : "s"} on this phone could not be loaded: ${failed[0].error}`}</Text>
      ) : null}
      {rooms.map((r) => {
        const photo = photos[r.roomId];
        const isSelected = selected === r.roomId;
        return (
          <Pressable
            key={r.roomId}
            onPress={() => router.push({ pathname: "/room/[id]", params: { id: r.roomId } })}
            onLongPress={() => choose(r.roomId)}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <Card style={[styles.card, isSelected && styles.cardSelected]}>
              <View style={styles.header}>
                {photo ? (
                  <Image source={photo} style={styles.photo} resizeMode="cover" />
                ) : (
                  <RoomInsideView room={r} width={cardWidth} />
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
                  <Metric label="Versions" value={versionCount[r.roomId] == null ? "—" : `${versionCount[r.roomId]}`} />
                </View>
                <Pressable
                  onPress={() => choose(r.roomId)}
                  disabled={sending === r.roomId}
                  style={({ pressed }) => [styles.useButton, isSelected && styles.useButtonSelected, pressed && styles.pressed]}
                >
                  <SymbolView name={isSelected ? "checkmark.circle.fill" : "visionpro"} size={16} tintColor={isSelected ? "white" : colors.accent} weight="semibold" />
                  <Text style={[styles.useButtonText, isSelected && styles.useButtonTextSelected]}>
                    {sending === r.roomId ? "Sending to headset…" : isSelected ? "In the headset" : "Use in headset"}
                  </Text>
                </Pressable>
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
  warn: { fontSize: 13, color: colors.danger, paddingHorizontal: 4 },
  cardSelected: { borderWidth: 3, borderColor: colors.accent },
  useButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 999,
    paddingVertical: 11,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  useButtonSelected: { backgroundColor: colors.accent },
  useButtonText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  useButtonTextSelected: { color: "white" },
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
