// A view from inside the room, built from the scan itself when there is no
// photo: one-point perspective of the box — back wall, two side walls, floor,
// ceiling — coloured from `appearance.surfaces` when the scan sampled them,
// neutral otherwise. Plain View transforms, no drawing library needed.
import { StyleSheet, View } from "react-native";

import type { RoomCaptureV1 } from "./types";

export function RoomInsideView({ room, width, height = Math.round(width * 0.62) }: { room: RoomCaptureV1; width: number; height?: number }) {
  // `appearance` is optional on RoomCapture v1 (contracts.md); the app's type omits it.
  const s = (room as RoomCaptureV1 & { appearance?: { surfaces?: Record<string, { hex?: string }> } }).appearance?.surfaces ?? {};
  const wallHexes = room.walls.map((w) => s[w.id]?.hex).filter((h): h is string => !!h);
  const wall = wallHexes[0] ?? "#e6e1d8";
  const wallSide = wallHexes[1] ?? shade(wall, -8);
  const floor = s.floor?.hex ?? "#c9b394";
  const ceiling = s.ceiling?.hex ?? "#f4f4f2";

  // Back wall occupies the middle 46% of the width and 48% of the height.
  const bw = width * 0.46;
  const bh = height * 0.48;
  const bx = (width - bw) / 2;
  const by = (height - bh) / 2;
  const doors = room.openings.filter((o) => o.kind === "door").length;
  const windows = room.openings.filter((o) => o.kind === "window").length;

  return (
    <View style={[styles.box, { width, height, backgroundColor: wall }]}>
      {/* ceiling: a trapezoid via rotateX on a rectangle anchored at the top edge */}
      <View style={[styles.plane, { top: 0, height: by * 1.9, backgroundColor: ceiling, transform: [{ perspective: 600 }, { translateY: -by * 0.95 }, { rotateX: "58deg" }, { translateY: by * 0.95 }] }]} />
      {/* floor */}
      <View style={[styles.plane, { bottom: 0, height: by * 1.9, backgroundColor: floor, transform: [{ perspective: 600 }, { translateY: by * 0.95 }, { rotateX: "-58deg" }, { translateY: -by * 0.95 }] }]} />
      {/* side walls */}
      <View style={[styles.side, { left: 0, width: bx * 1.9, height, backgroundColor: wallSide, transform: [{ perspective: 600 }, { translateX: -bx * 0.95 }, { rotateY: "-58deg" }, { translateX: bx * 0.95 }] }]} />
      <View style={[styles.side, { right: 0, width: bx * 1.9, height, backgroundColor: wallSide, transform: [{ perspective: 600 }, { translateX: bx * 0.95 }, { rotateY: "58deg" }, { translateX: -bx * 0.95 }] }]} />
      {/* back wall, with the openings the scan found drawn on it */}
      <View style={[styles.back, { left: bx, top: by, width: bw, height: bh, backgroundColor: wall }]}>
        {Array.from({ length: Math.min(doors, 2) }).map((_, i) => (
          <View key={`d${i}`} style={[styles.door, { left: bw * (0.12 + i * 0.5), width: bw * 0.18, height: bh * 0.78 }]} />
        ))}
        {Array.from({ length: Math.min(windows, 2) }).map((_, i) => (
          <View key={`w${i}`} style={[styles.window, { right: bw * (0.1 + i * 0.32), width: bw * 0.22, height: bh * 0.34 }]} />
        ))}
      </View>
      <View style={[styles.vignette, { width, height }]} pointerEvents="none" />
    </View>
  );
}

function shade(hex: string, delta: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, v + delta)));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const styles = StyleSheet.create({
  box: { overflow: "hidden" },
  plane: { position: "absolute", left: 0, right: 0 },
  side: { position: "absolute", top: 0 },
  back: { position: "absolute", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(0,0,0,0.08)" },
  door: { position: "absolute", bottom: 0, backgroundColor: "rgba(90,70,50,0.55)", borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  window: { position: "absolute", top: "22%", backgroundColor: "rgba(160,205,240,0.85)", borderWidth: 2, borderColor: "rgba(255,255,255,0.9)" },
  vignette: { position: "absolute", left: 0, top: 0, backgroundColor: "transparent", borderWidth: 18, borderColor: "rgba(0,0,0,0.05)" },
});
