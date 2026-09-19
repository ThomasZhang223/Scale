import { useLocalSearchParams, useRouter } from "expo-router";
import { Host, List, Section, Button, Gauge, Text } from "@expo/ui/swift-ui";

import { getJSON } from "../../src/lib/api";
import { ErrorView } from "../../src/ui/ErrorView";
import { LoadingView } from "../../src/ui/LoadingView";
import { Metric } from "../../src/ui/Metric";
import { PaletteSwatches } from "../../src/ui/PaletteSwatches";
import type { ObjectV1 } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";
import { formatLengthCm } from "../../src/lib/units";

// ceiling: Object v1 has no live progressPct — that lives on GET
// /jobs/{id}, keyed by a jobId that POST /objects/{id}/generate mints per
// request and that Object v1 never stores. This buckets the coarser
// `state` machine into an approximate gauge instead. Upgrade path: store
// the active jobId on Object v1 (or add GET /objects/{id}/job) so this can
// show a real percentage.
function progressForState(state: ObjectV1["state"]): number {
  switch (state) {
    case "measured":
      return 0.33;
    case "generating":
      return 0.66;
    case "ready":
      return 1.0;
    case "failed":
      return 0;
  }
}

export default function ObjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [state, retry] = useFetchState(
    () => getJSON<ObjectV1>(`/v1/objects/${id}`, { stub: true, schemaLabel: "Object v1" }),
    [id]
  );

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  const object = state.data;
  const progress = progressForState(object.state);

  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <List>
        <Section title={object.name}>
          <Metric label="Width" value={formatLengthCm(object.bboxMeters.w)} />
          <Metric label="Height" value={formatLengthCm(object.bboxMeters.h)} />
          <Metric label="Depth" value={formatLengthCm(object.bboxMeters.d)} />
        </Section>

        <Section title="Palette">
          <PaletteSwatches colors={object.palette} size={24} />
        </Section>

        <Section title="Caption">
          <Text>{object.caption}</Text>
        </Section>

        <Section title="Generation">
          <Gauge value={progress} currentValueLabel={<Text>{`${Math.round(progress * 100)}%`}</Text>}>
            <Text>{object.state}</Text>
          </Gauge>
        </Section>

        <Section>
          <Button
            label="View in AR at 1:1"
            systemImage="arkit"
            onPress={() =>
              router.push({ pathname: "/ar/[objectId]", params: { objectId: object.objectId } })
            }
          />
        </Section>
      </List>
    </Host>
  );
}
