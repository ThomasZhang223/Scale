// Scanned — every object this phone measured with LiDAR, newest first. Source "scan" only.
// The row's state capsule is the whole generation story: Measured (box only) → Generating →
// 3D ready (a GLB the Quest can load).
import { useRouter } from "expo-router";
import { Host, List, Section, Button, Text } from "@expo/ui/swift-ui";
import { font, foregroundStyle, listStyle, refreshable } from "@expo/ui/swift-ui/modifiers";

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

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  const objects = state.data;
  const ready = objects.filter((o) => o.state === "ready").length;

  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <List modifiers={[listStyle("insetGrouped"), refreshable(async () => retry())]}>
        {objects.length === 0 ? (
          <Section>
            <EmptyState
              title="No scans yet"
              systemImage="cube.transparent"
              description="Point the phone at an object and tap it. It appears here in under a second."
            />
            <Button label="Scan an object" systemImage="viewfinder" onPress={() => router.push("/capture/object")} />
          </Section>
        ) : (
          <Section
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
          </Section>
        )}
      </List>
    </Host>
  );
}
