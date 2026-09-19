import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { API_BASE, getJSON } from "../src/lib/api";

// The home screen exists to prove the app boots and can reach the Worker.
// Replace the two actions with the real capture flows; keep the health row
// until the backend is stable, it answers "is it me or is it the server".
export default function Home() {
  const [health, setHealth] = useState("checking…");

  useEffect(() => {
    getJSON("/rooms/demo-room", { stub: true })
      .then((r) => setHealth(`stub layer OK — ${r.walls?.length ?? 0} walls`))
      .catch((e) => setHealth(`unreachable: ${e.message}`));
  }, []);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.page}>
      <Text style={styles.lead}>
        Scan a room, scan anything you want to put in it, and check at true measured scale
        whether it fits.
      </Text>

      <Action title="Scan a room" detail="RoomPlan → RoomCapture v1" />
      <Action title="Scan an object" detail="LiDAR box in under 1s, mesh follows" />

      <View style={styles.health}>
        <Text style={styles.healthLabel}>API</Text>
        <Text style={styles.healthValue}>{health}</Text>
        <Text style={styles.healthBase}>{API_BASE}</Text>
      </View>
    </ScrollView>
  );
}

function Action({ title, detail }) {
  return (
    <Pressable style={styles.action}>
      <Text style={styles.actionTitle}>{title}</Text>
      <Text style={styles.actionDetail}>{detail}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 20 },
  lead: { fontSize: 15, lineHeight: 21, opacity: 0.7, marginTop: 8, marginBottom: 24 },
  action: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(128,128,128,0.4)",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  actionTitle: { fontSize: 17, fontWeight: "600" },
  actionDetail: { fontSize: 13, opacity: 0.6, marginTop: 4 },
  health: { marginTop: 24, marginBottom: 48 },
  healthLabel: { fontSize: 11, letterSpacing: 1, opacity: 0.5 },
  healthValue: { fontSize: 14, marginTop: 4 },
  healthBase: { fontSize: 11, opacity: 0.4, marginTop: 2 },
});
