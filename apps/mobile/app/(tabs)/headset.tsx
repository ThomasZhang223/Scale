import { useEffect, useState } from "react";
import * as Haptics from "expo-haptics";
import { List, Button, Text, Image, HStack, Spacer } from "@expo/ui/swift-ui";

import { GlassHost, GlassSection, glassList } from "../../src/ui/glass";

import { API_BASE, getJSON, postJSON } from "../../src/lib/api";
import { subscribeRoomSync } from "../../src/lib/sse";
import { DEMO_ROOM_ID } from "../../src/ui/demoIds";
import { Metric } from "../../src/ui/Metric";
import type { RoomCaptureV1 } from "../../src/ui/types";

type HealthState =
  | { status: "checking" }
  | { status: "ok"; wallCount: number }
  | { status: "unreachable" };

type SseState = "connecting" | "open" | "error";
type PushState = "idle" | "pushing" | "pushed" | "failed";

// Matches the plan's own verification text (section 10, "Verification"):
// "The Headset tab health row reads 'stub layer OK — 4 walls'." — that
// exact string is what proves the stub layer is reachable at all.
function healthLabel(health: HealthState): string {
  if (health.status === "checking") return "Checking…";
  if (health.status === "unreachable") return "unreachable";
  return `stub layer OK — ${health.wallCount} walls`;
}

export default function HeadsetScreen() {
  const [health, setHealth] = useState<HealthState>({ status: "checking" });
  const [sse, setSse] = useState<SseState>("connecting");
  const [push, setPush] = useState<PushState>("idle");

  useEffect(() => {
    let cancelled = false;
    getJSON<RoomCaptureV1>(`/v1/rooms/${DEMO_ROOM_ID}`, { stub: true, schemaLabel: "RoomCapture v1" })
      .then((room) => {
        if (!cancelled) setHealth({ status: "ok", wallCount: room.walls.length });
      })
      .catch(() => {
        // Unreachable is itself the diagnostic here — CLAUDE.local.md:
        // "If it reads 'unreachable', it is the LAN address, not the code."
        if (!cancelled) setHealth({ status: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSse("connecting");
    const sync = subscribeRoomSync(
      DEMO_ROOM_ID,
      {
        onOpen: () => setSse("open"),
        onError: () => setSse("error"),
      },
      { stub: true }
    );
    return () => sync.close();
  }, []);

  async function pushVersion() {
    setPush("pushing");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      // ceiling: no Version v1 fixture is committed yet
      // (fixtures/README.md lists only four files) and this app has no
      // version-picker UI yet, so there is no real versionId to send here.
      // Placeholder, until app/room/[id].tsx grows a version history to
      // pick a real one from.
      await postJSON(
        `/v1/push/${DEMO_ROOM_ID}`,
        { versionId: "00000000-0000-0000-0000-000000000000" },
        { stub: true }
      );
      setPush("pushed");
    } catch {
      setPush("failed");
    }
  }

  return (
    <GlassHost>
      <List modifiers={glassList}>
        <GlassSection title="Headset" divided={false}>
          <HStack>
            <Spacer />
            <Image systemName="qrcode" size={120} />
            <Spacer />
          </HStack>
          <Text>Scan with the Quest to open this room</Text>
          <Button label="Push this version" systemImage="arrow.up.to.line" onPress={pushVersion} />
          {push !== "idle" ? (
            <Text>{push === "pushing" ? "Pushing…" : push === "pushed" ? "Pushed" : "Failed to push"}</Text>
          ) : null}
        </GlassSection>

        <GlassSection title="Diagnostics">
          <Metric label="API base" value={API_BASE ?? "not set"} />
          <Metric label="Stub layer" value={healthLabel(health)} />
          <Metric label="Sync (SSE)" value={sse} />
        </GlassSection>
      </List>
    </GlassHost>
  );
}
