// Assembles a RoomCapture v1 from faces captured by modules/wall-capture.
// One wall per vertical face; the floor is the polygon through the walls'
// bottom corners; openings and objects are empty (this path detects
// neither). Metres in, metres out.
import type { CapturedFace, FaceId } from "../../modules/wall-capture";
import type { RoomCaptureV1 } from "./types";

type Transform16 = RoomCaptureV1["walls"][number]["transform"];

function uuid(): string {
  const h = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
    else if (i === 14) s += "4";
    else if (i === 19) s += h[8 + Math.floor(Math.random() * 4)];
    else s += h[Math.floor(Math.random() * 16)];
  }
  return s;
}

// Column-major 4×4: local X along the wall's width, Y up, Z out of the wall.
export function wallTransformFrom(c: { x: number; y: number; z: number }, yawDeg: number): Transform16 {
  const yaw = (yawDeg * Math.PI) / 180;
  const dx = Math.cos(yaw);
  const dz = -Math.sin(yaw);
  return [dx, 0, dz, 0, 0, 1, 0, 0, -dz, 0, dx, 0, c.x, c.y, c.z, 1];
}

function wallTransform(face: CapturedFace): Transform16 {
  return wallTransformFrom(face.center, face.yawDeg);
}

function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length < 3) return pts;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function area(poly: [number, number][]): number {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    s += ax * by - bx * ay;
  }
  return Math.abs(s) / 2;
}

const WALL_FACES: FaceId[] = ["front", "right", "back", "left"];

export function roomFromFaces(faces: Partial<Record<FaceId, CapturedFace>>): RoomCaptureV1 {
  const walls = WALL_FACES.filter((f) => faces[f]).map((f) => {
    const face = faces[f]!;
    return {
      id: uuid(),
      transform: wallTransform(face),
      // width, height, thickness — a photographed wall has no measured thickness; 0.1 m is
      // the RoomPlan default for the same reason.
      dimensions: [face.widthMeters, face.heightMeters, 0.1] as [number, number, number],
      confidence: (face.detected && face.confidence > 0.7 ? "high" : face.detected ? "medium" : "low") as "high" | "medium" | "low",
    };
  });
  if (walls.length < 3) throw new Error(`A room needs at least 3 walls; ${walls.length} captured.`);

  const bottoms: [number, number][] = WALL_FACES.filter((f) => faces[f]).flatMap((f) => {
    const c = faces[f]!.cornersWorld;
    return [c[2], c[3]].map((p) => [p[0], p[2]] as [number, number]);
  });
  const polygon = convexHull(bottoms);

  return {
    schemaVersion: 1,
    roomId: uuid(),
    capturedAt: new Date().toISOString(),
    worldAlignment: "gravityAndHeading",
    // ceiling: the session is heading-aligned so yaws are true-north relative, but the
    // compass cross-check value is not read on this path.
    northBearingDeg: 0,
    floor: { polygon, areaM2: area(polygon) },
    walls,
    openings: [],
    objects: [],
  };
}
