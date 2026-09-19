import { useMemo, useState } from "react";
import { useRouter } from "expo-router";
import {
  Host,
  ScrollView,
  VStack,
  HStack,
  Grid,
  Button,
  Picker,
  Text,
} from "@expo/ui/swift-ui";
import { buttonStyle, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";

import { getJSON } from "../../src/lib/api";
import { spacing } from "../../src/theme/tokens";
import { ConfidenceBadge, toConfidenceLevel } from "../../src/ui/ConfidenceBadge";
import { DEMO_OBJECT_ID } from "../../src/ui/demoIds";
import { EmptyState } from "../../src/ui/EmptyState";
import { ErrorView } from "../../src/ui/ErrorView";
import { LoadingView } from "../../src/ui/LoadingView";
import { PaletteSwatches } from "../../src/ui/PaletteSwatches";
import type { ObjectV1 } from "../../src/ui/types";
import { useFetchState } from "../../src/ui/useFetchState";
import { formatDimensionsCm } from "../../src/lib/units";

type Filter = "all" | "scanned" | "catalog";

function matchesFilter(object: ObjectV1, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "scanned") return object.source === "scan";
  return object.source === "catalog";
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

async function fetchObjects(): Promise<ObjectV1[]> {
  const object = await getJSON<ObjectV1>(`/v1/objects/${DEMO_OBJECT_ID}`, {
    stub: true,
    schemaLabel: "Object v1",
  });
  return [object]; // see DEMO_OBJECT_ID ceiling note above
}

export default function ObjectsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [state, retry] = useFetchState(fetchObjects, []);

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  const filtered = useMemo(
    () => state.data.filter((o) => matchesFilter(o, filter)),
    [state.data, filter]
  );
  const rows = chunk(filtered, 2);

  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <VStack spacing={spacing.md} alignment="leading">
        <Picker selection={filter} onSelectionChange={(v) => setFilter(v)} modifiers={[pickerStyle("segmented")]}>
          <Text modifiers={[tag("all")]}>All</Text>
          <Text modifiers={[tag("scanned")]}>Scanned</Text>
          <Text modifiers={[tag("catalog")]}>Catalog</Text>
        </Picker>

        {filtered.length === 0 ? (
          <EmptyState
            title="No objects"
            systemImage="cube"
            description="Scan an object from the Capture tab, or switch filters."
          />
        ) : (
          <ScrollView>
            <Grid horizontalSpacing={spacing.md} verticalSpacing={spacing.md}>
              {rows.map((row, rowIndex) => (
                <Grid.Row key={rowIndex}>
                  {row.map((object) => (
                    <ObjectTile
                      key={object.objectId}
                      object={object}
                      onPress={() => router.push({ pathname: "/object/[id]", params: { id: object.objectId } })}
                    />
                  ))}
                </Grid.Row>
              ))}
            </Grid>
          </ScrollView>
        )}
      </VStack>
    </Host>
  );
}

function ObjectTile({ object, onPress }: { object: ObjectV1; onPress: () => void }) {
  return (
    <Button modifiers={[buttonStyle("plain")]} onPress={onPress}>
      <VStack alignment="leading" spacing={6}>
        <Text>{object.name}</Text>
        <Text>{formatDimensionsCm(object.bboxMeters.w, object.bboxMeters.h, object.bboxMeters.d)}</Text>
        <HStack spacing={8}>
          <ConfidenceBadge level={toConfidenceLevel(object.measure.confidence)} />
        </HStack>
        <PaletteSwatches colors={object.palette} size={14} />
      </VStack>
    </Button>
  );
}
