// One library row, plain React Native: a photo slot, name, secondary line,
// price or size on the right, and the state capsule. Replaces the SwiftUI
// ObjectRow for the Scanned and Furniture tabs, because the SwiftUI Image in
// @expo/ui draws only SF Symbols — a product photo needs RN's Image.
import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";

import { formatDimensionsCm } from "../lib/units";
import { colors } from "../theme/tokens";
import { catalogImage, catalogImageSync } from "./catalogImages";
import { objectPhotoUri } from "./objectFiles";
import type { ObjectV1 } from "./types";

export type ObjectCardProps = {
  object: ObjectV1;
  subtitle: string;
  trailing?: string | null;
  onPress: () => void;
};

const STATE: Record<ObjectV1["state"], { bg: string; fg: string; label: string }> = {
  measured: { bg: "rgba(120,120,128,0.16)", fg: "#636366", label: "Measured" },
  generating: { bg: "#dbe9ff", fg: "#1f5fd1", label: "Generating" },
  ready: { bg: "#d9f2df", fg: "#248a3d", label: "3D ready" },
  failed: { bg: "#fbdad8", fg: "#c62d25", label: "Failed" },
};

// A category icon stands in until the row has a photo. ceiling: Object v1
// carries no image field yet; catalog ingest sees an imageUrl per product
// but does not publish it (workers/, Paul + Thomas). When it does, `imageUrl`
// below lights up with no further change here.
function iconFor(category: string): SFSymbol {
  const c = category.toLowerCase();
  if (c.includes("chair") || c.includes("seat")) return "chair.fill";
  if (c.includes("sofa") || c.includes("couch")) return "sofa.fill";
  if (c.includes("bed")) return "bed.double.fill";
  if (c.includes("table") || c.includes("desk")) return "table.furniture.fill";
  if (c.includes("lamp") || c.includes("light")) return "lamp.floor.fill";
  if (c.includes("storage") || c.includes("dresser") || c.includes("shelf") || c.includes("cabinet")) return "cabinet.fill";
  if (c.includes("laptop")) return "laptopcomputer";
  return "cube.fill";
}

export function ObjectCard({ object, subtitle, trailing, onPress }: ObjectCardProps) {
  const { w, h, d } = object.bboxMeters;
  const tone = STATE[object.state] ?? STATE.measured;
  // This phone's own photo first, then the server's, then the Shopify product photo found
  // through the manifest or the store's own product JSON (src/ui/catalogImages.ts).
  const serverUrl = (object as ObjectV1 & { imageUrl?: string | null }).imageUrl ?? null;
  const [resolved, setResolved] = useState<string | null>(() => objectPhotoUri(object.objectId) ?? serverUrl ?? catalogImageSync(object.productUrl));
  useEffect(() => {
    if (resolved || object.source !== "catalog") return;
    let live = true;
    catalogImage(object.productUrl).then((u) => { if (live && u) setResolved(u); });
    return () => { live = false; };
  }, [object.objectId, object.productUrl, object.source, resolved]);
  const imageUrl = resolved;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.thumb}>
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={styles.thumbImage} resizeMode="cover" />
        ) : (
          <SymbolView name={iconFor(object.category)} size={26} tintColor={colors.accent} weight="medium" />
        )}
      </View>
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>{object.name}</Text>
        <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
        <View style={[styles.badge, { backgroundColor: tone.bg }]}>
          <Text style={[styles.badgeText, { color: tone.fg }]}>{tone.label}</Text>
        </View>
      </View>
      <View style={styles.trailing}>
        {trailing ? <Text style={styles.price}>{trailing}</Text> : null}
        <Text style={styles.dims}>{formatDimensionsCm(w, h, d)}</Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColor="rgba(60,60,67,0.3)" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: 14,
    backgroundColor: "rgba(58,134,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbImage: { width: "100%", height: "100%" },
  text: { flex: 1, gap: 3 },
  name: { fontSize: 17, fontWeight: "600", color: "#1c1c1e" },
  subtitle: { fontSize: 14, color: colors.textMuted },
  badge: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, marginTop: 2 },
  badgeText: { fontSize: 12, fontWeight: "600" },
  trailing: { alignItems: "flex-end", gap: 3 },
  price: { fontSize: 16, fontWeight: "600", color: "#1c1c1e" },
  dims: { fontSize: 12, color: colors.textMuted, fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.75 },
});
