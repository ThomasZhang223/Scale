import { useCallback } from "react";
// Scanned — every object this phone measured with LiDAR, newest first. Source "scan" only.
// The row's state capsule is the whole generation story: Measured (box only) → Generating →
// 3D ready (a GLB the Quest can load).
import { useFocusEffect, useRouter } from "expo-router";
import { List, Button, Text } from "@expo/ui/swift-ui";
import { font, foregroundStyle, refreshable } from "@expo/ui/swift-ui/modifiers";

import { GlassHost, GlassSection, glassList } from "../../src/ui/glass";

import { EmptyState } from "../../src/ui/EmptyState";
import { ErrorView } from "../../src/ui/ErrorView";
import { LoadingView } from "../../src/ui/LoadingView";
import { ObjectRow } from "../../src/ui/ObjectRow";
import { listObjects } from "../../src/ui/objectsApi";
import { useFetchState } from "../../src/ui/useFetchState";

function subtitleFor(method: string, confidence: number): string {
  const pct = Math.round(confidence * 100);
  return `${method === "lidar" ? "LiDAR" : method} · ${pct}% confidence`;
}

export default function ScannedScreen() {
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

  return (
    <GlassHost>
      <List modifiers={[...glassList, refreshable(async () => retry())]}>
        {objects.length === 0 ? (
          <GlassSection divided={false}>
            <EmptyState
              title="No scans yet"
              systemImage="cube.transparent"
              description="Point the phone at an object and tap it. It appears here in under a second."
            />
            <Button label="Scan an object" systemImage="viewfinder" onPress={() => router.push("/capture/object3d")} />
          </GlassSection>
        ) : (
          <GlassSection
            title="Scanned"
            footer={
              <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle({ type: "hierarchical", style: "secondary" })]}>
                {`${objects.length} object${objects.length === 1 ? "" : "s"} · ${ready} with 3D`}
              </Text>
            }
          >
            {objects.map((object) => (
              <ObjectRow
                key={object.objectId}
                object={object}
                subtitle={subtitleFor(object.measure.method, object.measure.confidence)}
                onPress={() => router.push({ pathname: "/object/[id]", params: { id: object.objectId } })}
              />
            ))}
          </GlassSection>
        )}
      </List>
    </GlassHost>
  );
}
