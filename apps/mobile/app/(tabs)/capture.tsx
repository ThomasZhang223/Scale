import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { Host, VStack, HStack, List, Section, Button, Text, Image, Spacer, ProgressView, GlassEffectContainer } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, font, foregroundStyle, frame, glassEffect, listRowBackground, padding } from "@expo/ui/swift-ui/modifiers";

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

// The two entry points, as two glass tiles rather than two list rows: this
// tab exists for exactly these two taps, so they get the room. Room scan is
// the prominent one because it comes first in every demo run.
function CaptureTile({
  title,
  detail,
  systemImage,
  prominent,
  onPress,
}: {
  title: string;
  detail: string;
  systemImage: "house.fill" | "cube.fill" | "ruler.fill";
  prominent?: boolean;
  onPress: () => void;
}) {
  return (
    <Button modifiers={[buttonStyle("plain")]} onPress={onPress}>
      <HStack
        spacing={14}
        alignment="center"
        modifiers={[
          padding({ horizontal: 18, vertical: 16 }),
          frame({ maxWidth: 10000, alignment: "leading" }),
          glassEffect({
            glass: { variant: "regular", interactive: true, tint: prominent ? "#3a86ff" : undefined },
            shape: "roundedRectangle",
            cornerRadius: 24,
          }),
        ]}
      >
        <Image systemName={systemImage} size={30} modifiers={[foregroundStyle(prominent ? "white" : "#3a86ff")]} />
        <VStack alignment="leading" spacing={3}>
          <Text modifiers={[font({ textStyle: "title3", weight: "semibold" }), foregroundStyle(prominent ? "white" : "primary")]}>
            {title}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: "footnote" }),
              foregroundStyle(prominent ? "rgba(255,255,255,0.8)" : { type: "hierarchical", style: "secondary" }),
            ]}
          >
            {detail}
          </Text>
        </VStack>
        <Spacer />
        <Image systemName="chevron.right" size={14} modifiers={[foregroundStyle(prominent ? "rgba(255,255,255,0.7)" : { type: "hierarchical", style: "tertiary" })]} />
      </HStack>
    </Button>
  );
}

export default function CaptureHubScreen() {
  const router = useRouter();
  const [state, retry] = useFetchState(() => fetchRecents(router), []);

  async function startCapture(path: "/capture/room" | "/capture/object" | "/capture/object3d") {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push(path);
  }

  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <List>
        <Section modifiers={[listRowBackground("clear")]}>
          <GlassEffectContainer spacing={12}>
            <VStack spacing={12}>
              <CaptureTile
                title="Scan a room"
                detail="Walk the walls. Doors, windows and furniture are picked up as you go."
                systemImage="house.fill"
                prominent
                onPress={() => startCapture("/capture/room")}
              />
              <CaptureTile
                title="Capture an object in 3D"
                detail="Walk around it. A textured model at true size, built on this phone."
                systemImage="cube.fill"
                onPress={() => startCapture("/capture/object3d")}
              />
              <CaptureTile
                title="Measure an object"
                detail="Set it on a table, tap it once. A size in under a second, no model."
                systemImage="ruler.fill"
                onPress={() => startCapture("/capture/object")}
              />
            </VStack>
          </GlassEffectContainer>
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
