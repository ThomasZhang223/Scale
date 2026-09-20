// The six straightened faces of a photo-built room, stitched: the four walls
// edge to edge in walking order (left, front, right, back), each as wide as
// its real width, with the ceiling above and the floor below the front wall.
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";

import { colors, radius } from "../theme/tokens";
import type { RoomFaceMeta } from "./roomPhotos";

const H = 150;

export function StitchedRoom({ uris, meta }: { uris: Record<string, string>; meta: Record<string, RoomFaceMeta> }) {
  const order = ["left", "front", "right", "back"].filter((f) => uris[f]);
  if (order.length === 0) return null;
  const widthOf = (f: string) => Math.max(80, Math.round(H * (meta[f]?.aspect ?? 1.4)));
  const frontLeft = order.slice(0, order.indexOf("front")).reduce((a, f) => a + widthOf(f), 0);
  const frontW = uris.front ? widthOf("front") : 0;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
      <View>
        {uris.ceiling ? (
          <Image source={{ uri: uris.ceiling }} style={[styles.flat, { marginLeft: frontLeft, width: frontW || widthOf("ceiling") }]} resizeMode="cover" />
        ) : null}
        <View style={styles.walls}>
          {order.map((f) => (
            <View key={f} style={{ width: widthOf(f) }}>
              <Image source={{ uri: uris[f] }} style={styles.wall} resizeMode="cover" />
              <Text style={styles.caption}>{f}</Text>
            </View>
          ))}
        </View>
        {uris.floor ? (
          <Image source={{ uri: uris.floor }} style={[styles.flat, { marginLeft: frontLeft, width: frontW || widthOf("floor") }]} resizeMode="cover" />
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { paddingVertical: 4 },
  walls: { flexDirection: "row", borderRadius: radius.md, overflow: "hidden" },
  wall: { height: H, width: "100%" },
  flat: { height: 70, borderRadius: radius.sm, marginVertical: 4 },
  caption: { position: "absolute", left: 6, bottom: 6, color: "white", fontSize: 11, fontWeight: "600", textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 3 },
});
