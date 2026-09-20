import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { View, StyleSheet } from "react-native";
import { Host, List, Button, Gauge, Text, Link, ZStack } from "@expo/ui/swift-ui";

import { GlassSection, backdrop, glassList } from "../../src/ui/glass";
import { font, foregroundStyle, ignoreSafeArea } from "@expo/ui/swift-ui/modifiers";

import { formatPrice, getJob, getObject, startGenerate } from "../../src/ui/objectsApi";
import { StateBadge } from "../../src/ui/StateBadge";
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
  const [state, retry] = useFetchState(() => getObject(id), [id]);
  const [job, setJob] = useState<{ jobId: string; progressPct: number; error: string | null } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Generate → poll GET /jobs/{id} every 2 s → refetch the object when the job finishes so the
  // row's state and glbUrl come from the server, not from a client-side guess.
  useEffect(() => {
    if (!job) return;
    pollRef.current = setInterval(async () => {
      try {
        const j = await getJob(job.jobId);
        setJob({ jobId: job.jobId, progressPct: j.progressPct ?? 0, error: j.error ?? null });
        if (j.state === "done" || j.state === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setJob(null);
          retry();
        }
      } catch (err) {
        if (pollRef.current) clearInterval(pollRef.current);
        setJob({ jobId: job.jobId, progressPct: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId]);

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.message} onRetry={retry} />;

  const object = state.data;
  const progress = job ? Math.max(0.05, job.progressPct / 100) : progressForState(object.state);
  const canGenerate = !job && (object.state === "measured" || object.state === "failed");
  const price = formatPrice(object.price);

  async function onGenerate() {
    try {
      const jobId = await startGenerate(object.objectId);
      setJob({ jobId, progressPct: 0, error: null });
    } catch (err) {
      setJob({ jobId: "", progressPct: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

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
        <ZStack modifiers={[backdrop, ignoreSafeArea()]}>
        <List modifiers={glassList}>
          <GlassSection title={object.name}>
            <StateBadge state={object.state} />
            <Metric label="Width" value={formatLengthCm(object.bboxMeters.w)} />
            <Metric label="Height" value={formatLengthCm(object.bboxMeters.h)} />
            <Metric label="Depth" value={formatLengthCm(object.bboxMeters.d)} />
          </GlassSection>

          {object.source === "catalog" ? (
            <GlassSection title="Listing">
              {object.merchant ? <Metric label="Merchant" value={object.merchant} /> : null}
              {price ? <Metric label="Price" value={price} /> : null}
              <Metric label="Category" value={object.category} />
              {object.productUrl ? (
                <Link destination={object.productUrl}>
                  <Text>Open listing</Text>
                </Link>
              ) : null}
            </GlassSection>
          ) : null}

          {object.palette && object.palette.length > 0 ? (
            <GlassSection title="Palette">
              <PaletteSwatches colors={object.palette} size={24} />
            </GlassSection>
          ) : null}

          {object.caption ? (
            <GlassSection title="Caption">
              <Text>{object.caption}</Text>
            </GlassSection>
          ) : null}

          <GlassSection title="3D model">
            <Gauge value={progress} currentValueLabel={<Text>{`${Math.round(progress * 100)}%`}</Text>}>
              <Text>{job ? "Generating" : object.state === "ready" ? "Ready for the headset" : object.state}</Text>
            </Gauge>
            {canGenerate ? (
              <Button
                label={object.state === "failed" ? "Retry 3D generation" : "Generate 3D model"}
                systemImage="sparkles"
                onPress={onGenerate}
              />
            ) : null}
            {job?.error ? (
              <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle("#c62d25")]}>{job.error}</Text>
            ) : null}
          </GlassSection>

          <GlassSection divided={false}>
            <Button
              label="View in AR at 1:1"
              systemImage="arkit"
              onPress={() =>
                router.push({ pathname: "/ar/[objectId]", params: { objectId: object.objectId } })
              }
            />
          </GlassSection>
        </List>
        </ZStack>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#e8edf4",
  },
  previewWrap: {
    alignItems: "center",
    paddingVertical: spacing.md,
  },
  host: {
    flex: 1,
  },
});
