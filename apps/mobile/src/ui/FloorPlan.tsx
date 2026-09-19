// A 2D top-down floor plan drawn straight from RoomCapture v1 — no SVG or
// canvas dependency (none is installed; see CLAUDE.md, "every dependency you
// need is ALREADY in package.json"). Every wall, and every opening cut into
// one, is a rectangle: a plain RN <View> sized in pixels and rotated with
// the `transform: [{ rotate }]` style, which is all a rectangle needs.
//
// The top-down view plots world X across and world Z down, unflipped: since
// contracts.md's axes convention makes -Z true north, smaller-Z already
// reads as "up" on screen for a room captured with northBearingDeg near 0,
// which is the common case and the one in fixtures/room-demo.json.
import { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";

import { colors } from "../theme/tokens";
import type { Opening, RoomCaptureV1, RoomObject, Wall } from "./types";

export type FloorPlanProps = {
  room: RoomCaptureV1;
  width: number;
};

type Rect = {
  centerX: number;
  centerZ: number;
  length: number; // along the transform's local X axis
  depth: number; // along the transform's local Z axis
  angleDeg: number;
};

// contracts.md: column-major 16 floats, so column 0 (indices 0-2) is the
// local X basis vector and column 3 (indices 12-14) is the translation.
// Local Y (indices 4-6) is always world up for a .gravityAndHeading capture
// — the plan's own "three assertions to write on day one" — so a wall's
// local X and Z axes are always horizontal, and the plan angle is just the
// angle of that local X axis in the world XZ plane.
function rectFromTransform(transform: number[], length: number, depth: number): Rect {
  const angleDeg = (Math.atan2(transform[2], transform[0]) * 180) / Math.PI;
  return { centerX: transform[12], centerZ: transform[14], length, depth, angleDeg };
}

function rectStyle(rect: Rect, scale: number, originXM: number, originZM: number) {
  const widthPx = rect.length * scale;
  const heightPx = rect.depth * scale;
  const leftPx = (rect.centerX - originXM) * scale - widthPx / 2;
  const topPx = (rect.centerZ - originZM) * scale - heightPx / 2;
  return {
    position: "absolute" as const,
    left: leftPx,
    top: topPx,
    width: Math.max(widthPx, 1),
    height: Math.max(heightPx, 1),
    transform: [{ rotate: `${rect.angleDeg}deg` }],
  };
}

// ceiling: the floor is drawn as the axis-aligned bounding box of
// floor.polygon, not the true polygon outline. Exact for the rectangular
// fixture room. An L-shaped room would need a real polygon fill, which
// needs react-native-svg or similar — not a current dependency, and not
// worth adding for a shape no fixture exercises yet.
function polygonBounds(polygon: [number, number][]) {
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

export function FloorPlan({ room, width }: FloorPlanProps) {
  const layout = useMemo(() => {
    const bounds = polygonBounds(room.floor.polygon);
    // Padding covers a wall's own thickness overhanging the floor polygon's
    // edge (a wall's outer face sits half its thickness outside the floor
    // line) plus a little breathing room, so nothing clips at the canvas
    // edge.
    const paddingM = 0.25;
    const spanXM = bounds.maxX - bounds.minX + paddingM * 2;
    const spanZM = bounds.maxZ - bounds.minZ + paddingM * 2;
    const scale = width / spanXM;
    return {
      originXM: bounds.minX - paddingM,
      originZM: bounds.minZ - paddingM,
      scale,
      height: spanZM * scale,
    };
  }, [room.floor.polygon, width]);

  const wallsById = useMemo(() => new Map(room.walls.map((w) => [w.id, w])), [room.walls]);

  return (
    <View style={[styles.canvas, { width, height: layout.height }]}>
      {/* Floor */}
      <View style={StyleSheet.absoluteFill} />

      {/* Walls */}
      {room.walls.map((wall) => (
        <WallShape key={wall.id} wall={wall} layout={layout} />
      ))}

      {/* Openings — gaps cut into their parent wall */}
      {room.openings.map((opening) => {
        const parentWall = wallsById.get(opening.wallId);
        if (!parentWall) {
          // Fail loud: an opening pointing at a wall that isn't in this
          // same document is a producer bug, not a shape to render around.
          throw new Error(
            `RoomCapture v1: opening ${opening.id} references wallId ${opening.wallId}, which is not in walls[]`
          );
        }
        return (
          <OpeningShape key={opening.id} opening={opening} parentWall={parentWall} layout={layout} />
        );
      })}

      {/* Furniture, as light boxes */}
      {room.objects.map((object) => (
        <ObjectShape key={object.id} object={object} layout={layout} />
      ))}
    </View>
  );
}

type Layout = { originXM: number; originZM: number; scale: number; height: number };

function WallShape({ wall, layout }: { wall: Wall; layout: Layout }) {
  const rect = rectFromTransform(wall.transform, wall.dimensions[0], wall.dimensions[2]);
  return (
    <View style={[rectStyle(rect, layout.scale, layout.originXM, layout.originZM), styles.wall]} />
  );
}

function OpeningShape({
  opening,
  parentWall,
  layout,
}: {
  opening: Opening;
  parentWall: Wall;
  layout: Layout;
}) {
  // The opening's own transform gives its true position and orientation;
  // its dimensions[2] is 0 by contract (a plane, not a box), so the parent
  // wall's thickness is what makes the gap visually cut all the way
  // through the wall it sits in.
  const rect = rectFromTransform(opening.transform, opening.dimensions[0], parentWall.dimensions[2]);
  const style = opening.kind === "window" ? styles.window : styles.doorGap;
  return <View style={[rectStyle(rect, layout.scale, layout.originXM, layout.originZM), style]} />;
}

function ObjectShape({ object, layout }: { object: RoomObject; layout: Layout }) {
  const rect = rectFromTransform(object.transform, object.dimensions[0], object.dimensions[2]);
  return (
    <View style={[rectStyle(rect, layout.scale, layout.originXM, layout.originZM), styles.object]}>
      <Text numberOfLines={1} style={styles.objectLabel}>
        {object.category}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    backgroundColor: "#efe9dd", // a floor tone, distinct from the walls
    borderRadius: 4,
    overflow: "hidden",
  },
  wall: {
    backgroundColor: "#8a8a8e",
  },
  doorGap: {
    backgroundColor: "#efe9dd", // matches the floor — a true cut-through
  },
  window: {
    backgroundColor: "rgba(58,134,255,0.35)", // tinted glass, not walkable
  },
  object: {
    backgroundColor: "rgba(60,60,67,0.12)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(60,60,67,0.3)",
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  objectLabel: {
    fontSize: 8,
    color: colors.textMuted,
    textTransform: "capitalize",
  },
});
