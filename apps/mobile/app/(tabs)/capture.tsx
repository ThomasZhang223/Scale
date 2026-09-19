import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { Host, VStack, List, Section, Button, Text, ProgressView } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize } from "@expo/ui/swift-ui/modifiers";

import { getJSON } from "../../src/lib/api";
import { spacing } from "../../src/theme/tokens";
import { DEMO_OBJECT_ID, DEMO_ROOM_ID } from "../../src/ui/demoIds";
import { EmptyState } from "../../src/ui/EmptyState";
import type { ObjectV1, RoomCaptureV1 } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";

type RecentItem = {
  key: string;
  title: string;
  timestamp: string;
  onPress: () => void;
};

// ceiling: .claude/contracts.md has no "recent activity" endpoint. This
// reuses the same two known fixture-backed items every other screen reads
// (see src/ui/demoIds.ts) and sorts them by their own timestamps — true
// content, not invented data, just not sourced from a dedicated endpoint
// yet. Upgrade path: a real GET /recent once room/object creation isn't
// limited to the two demo fixtures.
async function fetchRecents(router: ReturnType<typeof useRouter>): Promise<RecentItem[]> {
  const [room, object] = await Promise.all([
    getJSON<RoomCaptureV1>(`/v1/rooms/${DEMO_ROOM_ID}`, { stub: true, schemaLabel: "RoomCapture v1" }),
    getJSON<ObjectV1>(`/v1/objects/${DEMO_OBJECT_ID}`, { stub: true, schemaLabel: "Object v1" }),
  ]);
  const items: RecentItem[] = [
    {
      key: `room-${room.roomId}`,
      title: `${room.floor.areaM2.toFixed(1)} m² room`,
      timestamp: room.capturedAt,
      onPress: () => router.push({ pathname: "/room/[id]", params: { id: room.roomId } }),
    },
    {
      key: `object-${object.objectId}`,
      title: object.name,
      timestamp: object.createdAt,
      onPress: () => router.push({ pathname: "/object/[id]", params: { id: object.objectId } }),
    },
  ];
  return items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export default function CaptureHubScreen() {
  const router = useRouter();
  const [state, retry] = useFetchState(() => fetchRecents(router), []);

  async function startCapture(path: "/capture/room" | "/capture/object") {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push(path);
  }

  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <List>
        <Section>
          <Button
            label="Scan a room"
            systemImage="house"
            modifiers={[buttonStyle("borderedProminent"), controlSize("large")]}
            onPress={() => startCapture("/capture/room")}
          />
          <Button
            label="Scan an object"
            systemImage="cube"
            modifiers={[buttonStyle("bordered"), controlSize("large")]}
            onPress={() => startCapture("/capture/object")}
          />
        </Section>

        <Section title="Recent">
          {state.status === "loading" ? (
            <ProgressView />
          ) : state.status === "error" ? (
            <VStack alignment="leading" spacing={8}>
              <Text>{state.message}</Text>
              <Button label="Try again" onPress={retry} />
            </VStack>
          ) : state.data.length === 0 ? (
            <EmptyState
              title="Nothing yet"
              systemImage="clock"
              description="Scans you make will show up here."
            />
          ) : (
            state.data.map((item) => (
              <Button key={item.key} modifiers={[buttonStyle("plain")]} onPress={item.onPress}>
                <VStack alignment="leading">
                  <Text>{item.title}</Text>
                  <Text date={new Date(item.timestamp)} dateStyle="relative" />
                </VStack>
              </Button>
            ))
          )}
        </Section>
      </List>
    </Host>
  );
}
