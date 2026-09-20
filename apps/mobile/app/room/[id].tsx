import { useLocalSearchParams } from "expo-router";
import { Image, ScrollView, View, StyleSheet, useWindowDimensions } from "react-native";
import { Host, List, LabeledContent } from "@expo/ui/swift-ui";

import { GlassSection, glassList } from "../../src/ui/glass";

import { getJSON } from "../../src/lib/api";
import { spacing } from "../../src/theme/tokens";
import { ConfidenceBadge } from "../../src/ui/ConfidenceBadge";
import { ErrorView } from "../../src/ui/ErrorView";
import { FloorPlan } from "../../src/ui/FloorPlan";
import { LoadingView } from "../../src/ui/LoadingView";
import { Metric } from "../../src/ui/Metric";
import { roomFaces, roomPhotoUri } from "../../src/ui/roomPhotos";
import { StitchedRoom } from "../../src/ui/StitchedRoom";
import { RoomInsideView } from "../../src/ui/RoomInsideView";
import { ApiError } from "../../src/lib/api";
import type { RoomCaptureV1 } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";

// Room-scale measurements (doors, windows, walls, floor area) read in
// metres directly, unlike src/lib/units.ts's centimetre formatting for
// small objects — a 0.9 m door is legible in metres; a 1.55 cm laptop
// thickness is not. This is plain display formatting of an
// already-metric value, not a unit conversion, so it doesn't belong in
// units.ts (contracts.md, "Global conventions": convert at the UI edge,
// which this already is).
function formatMeters(value: number): string {
  return `${value.toFixed(1)} m`;
}

export default function RoomDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();
  // Live first (rooms made on this phone exist only there); the stub answers the demo room.
  const [state, retry] = useFetchState(
    () =>
      getJSON<RoomCaptureV1>(`/v1/rooms/${id}`, { schemaLabel: "RoomCapture v1" }).catch((err: unknown) => {
        if (err instanceof ApiError) return getJSON<RoomCaptureV1>(`/v1/rooms/${id}`, { stub: true, schemaLabel: "RoomCapture v1" });
        throw err;
      }),
    [id]
  );

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  const room = state.data;
  const doors = room.openings.filter((o) => o.kind === "door");
  const windows = room.openings.filter((o) => o.kind === "window");
  const planWidth = width - spacing.md * 2;
  const photo = roomPhotoUri(room.roomId);
  const faces = roomFaces(room.roomId);
  const stitched = Object.keys(faces.uris).length > 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      {stitched ? (
        <StitchedRoom uris={faces.uris} meta={faces.meta} />
      ) : photo ? (
        <Image source={{ uri: photo }} style={styles.photo} resizeMode="cover" />
      ) : (
        <View style={styles.inside}>
          <RoomInsideView room={room} width={planWidth} />
        </View>
      )}
      {/* Plain RN: FloorPlan draws with absolute-positioned, rotated Views,
          which is not SwiftUI content and can't nest inside a Host's tree
          (see FloorPlan.tsx / PaletteSwatches.tsx for the same rule from
          the other direction). It sits as a sibling of the Host sections
          below, inside this screen's own plain RN ScrollView. */}
      <View style={styles.planWrap}>
        <FloorPlan room={room} width={planWidth} />
      </View>

      <Host style={styles.hostAuto} matchContents>
        <List modifiers={glassList}>
          <GlassSection title="Room">
            <Metric label="Area" value={`${room.floor.areaM2.toFixed(1)} m²`} />
          </GlassSection>

          <GlassSection title="Openings">
            {doors.map((door) => (
              <Metric key={door.id} label="Door" value={formatMeters(door.dimensions[0])} />
            ))}
            {windows.map((window) => (
              <Metric key={window.id} label="Window" value={formatMeters(window.dimensions[0])} />
            ))}
          </GlassSection>

          <GlassSection title="Walls">
            {room.walls.map((wall, i) => (
              <LabeledContent key={wall.id} label={`Wall ${i + 1}`}>
                <ConfidenceBadge level={wall.confidence} />
              </LabeledContent>
            ))}
          </GlassSection>
        </List>
      </Host>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#e8edf4",
  },
  content: {
    padding: spacing.md,
    gap: spacing.md,
  },
  planWrap: {
    alignItems: "center",
  },
  photo: { width: "100%", aspectRatio: 4 / 3, borderRadius: spacing.lg, overflow: "hidden" },
  inside: { borderRadius: spacing.lg, overflow: "hidden" },
  hostAuto: {
    width: "100%",
  },
});
