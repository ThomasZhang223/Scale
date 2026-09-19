import { useLocalSearchParams, useRouter } from "expo-router";
import { View, StyleSheet } from "react-native";
import { Host, List, Section, Button, Gauge, Text } from "@expo/ui/swift-ui";

import { getJSON } from "../../src/lib/api";
import { spacing } from "../../src/theme/tokens";
import { ErrorView } from "../../src/ui/ErrorView";
import { LoadingView } from "../../src/ui/LoadingView";
import { Metric } from "../../src/ui/Metric";
import { PaletteSwatches } from "../../src/ui/PaletteSwatches";
import type { ObjectV1 } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";
import { formatLengthCm } from "../../src/lib/units";
// ceiling: StaticThumbnail, not GlbPreview — see src/three/GlbPreview.tsx's
// own header comment. The real GLB preview is written but unverified on a
// device (no Xcode 26.4 / simulator / device in this session, and no real
// mesh-macbook.glb to load yet either). Swap the import below once someone
// with a real device confirms GlbPreview actually renders.
import { StaticThumbnail } from "../../src/three/StaticThumbnail";

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
    // Plain RN outer container: StaticThumbnail is a plain RN view (needs
    // no WebGL), which can't nest inside the Host/List's SwiftUI tree any
    // more than FloorPlan.tsx could in app/room/[id].tsx — same rule, see
    // that file's comment. It sits as a fixed header above the List, which
    // stays independently scrollable (an outer ScrollView here would nest
    // two scroll views, unlike room detail's non-scrolling metrics List).
    <View style={styles.screen}>
      <View style={styles.previewWrap}>
        <StaticThumbnail bboxMeters={object.bboxMeters} />
      </View>

      <Host style={styles.host} useViewportSizeMeasurement>
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
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  previewWrap: {
    alignItems: "center",
    paddingVertical: spacing.md,
  },
  host: {
    flex: 1,
  },
});
