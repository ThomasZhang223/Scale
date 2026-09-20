import { useLocalSearchParams } from "expo-router";
import ExpoQuickLook from "@magrinj/expo-quick-look";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { ModelPreviewView } from "../../modules/object-capture";
import { getJSON } from "../../src/lib/api";
import { colors, spacing } from "../../src/theme/tokens";
import { StaticThumbnail } from "../../src/three/StaticThumbnail";
import { objectUsdzUri } from "../../src/ui/objectFiles";

interface ObjectSummary {
  objectId: string;
  name: string;
  bboxMeters: { w: number; h: number; d: number };
}

// AR at 1:1 through QuickLook, over the USDZ this phone built for the object
// (src/ui/objectFiles.ts). RealityKit supplies the camera, the plane
// placement, the lighting and the grounding shadow; the model is already
// true size. An object with no local USDZ — a catalog row, or a capture from
// another phone — gets the measured box and a line saying why.
//
// The previous version drew a three.js box through expo-gl. three's renderer
// asks for `document` on construction, which React Native does not have; it
// threw before drawing a pixel on the first real device. Nothing here needs
// a browser runtime.
export default function ArObjectScreen() {
  const { objectId } = useLocalSearchParams<{ objectId: string }>();
  const [object, setObject] = useState<ObjectSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usdz = objectId ? objectUsdzUri(objectId) : null;

  useEffect(() => {
    if (!objectId) return;
    getJSON<ObjectSummary>(`/objects/${objectId}`)
      .then(setObject)
      .catch((e: Error) => setError(e.message));
  }, [objectId]);

  useEffect(() => {
    if (!usdz) return;
    ExpoQuickLook.previewFile({ uri: usdz }).catch((e: Error) => setError(e.message));
  }, [usdz]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!object) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (usdz) {
    // QuickLook owns the screen while open; underneath, the same model spins
    // so returning from AR lands on something, not a blank page.
    return (
      <View style={styles.screen}>
        <ModelPreviewView url={usdz} style={styles.model} />
        <Text style={styles.note}>Placed at true size. Close AR to come back here.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.boxWrap}>
        <StaticThumbnail bboxMeters={object.bboxMeters} />
      </View>
      <Text style={styles.title}>{object.name}</Text>
      <Text style={styles.note}>
        AR at 1:1 needs a model captured on this phone. Open Capture, choose "Capture an object in 3D", and it will
        be placeable here.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#e8edf4", alignItems: "center", padding: spacing.lg, gap: spacing.md },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#e8edf4", padding: spacing.lg },
  model: { width: "100%", aspectRatio: 1 },
  boxWrap: { paddingTop: spacing.lg },
  title: { fontSize: 20, fontWeight: "600", color: "#1c1c1e" },
  note: { fontSize: 15, color: colors.textMuted, textAlign: "center", lineHeight: 21, maxWidth: 320 },
  errorText: { color: colors.danger, textAlign: "center" },
});
