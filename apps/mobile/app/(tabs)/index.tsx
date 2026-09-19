import { useRouter } from "expo-router";
import { Host, List, Section, Button, VStack, HStack, Text, Image, Spacer } from "@expo/ui/swift-ui";
import { buttonStyle } from "@expo/ui/swift-ui/modifiers";

import { getJSON } from "../../src/lib/api";
import { colors } from "../../src/theme/tokens";
import { DEMO_ROOM_ID } from "../../src/ui/demoIds";
import { EmptyState } from "../../src/ui/EmptyState";
import { ErrorView } from "../../src/ui/ErrorView";
import { LoadingView } from "../../src/ui/LoadingView";
import { Metric } from "../../src/ui/Metric";
import type { RoomCaptureV1, VersionSummary } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";

type RoomsPayload = {
  room: RoomCaptureV1;
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
  return { room, versionCount };
}

export default function RoomsScreen() {
  const router = useRouter();
  const [state, retry] = useFetchState(fetchRoomsPayload, []);

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  const { room, versionCount } = state.data;
  const rooms = [room]; // see DEMO_ROOM_ID ceiling note above

  if (rooms.length === 0) {
    return (
      <Host style={{ flex: 1 }}>
        <EmptyState
          title="No rooms yet"
          systemImage="house"
          description="Scan a room from the Capture tab to see it here."
        />
      </Host>
    );
  }

  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <List>
        <Section title="Rooms">
          {rooms.map((r) => (
            <Button
              key={r.roomId}
              modifiers={[buttonStyle("plain")]}
              onPress={() => router.push({ pathname: "/room/[id]", params: { id: r.roomId } })}
            >
              <VStack alignment="leading" spacing={8}>
                <HStack alignment="center">
                  <VStack alignment="leading">
                    <Text>{`${r.floor.areaM2.toFixed(1)} m² room`}</Text>
                    <Text date={new Date(r.capturedAt)} dateStyle="relative" />
                  </VStack>
                  <Spacer />
                  <Image systemName="chevron.right" color={colors.textMuted} size={14} />
                </HStack>
                <HStack spacing={24}>
                  <Metric label="Area" value={`${r.floor.areaM2.toFixed(1)} m²`} />
                  <Metric label="Walls" value={`${r.walls.length}`} />
                  <Metric label="Versions" value={versionCount === null ? "—" : `${versionCount}`} />
                </HStack>
              </VStack>
            </Button>
          ))}
        </Section>
      </List>
    </Host>
  );
}
