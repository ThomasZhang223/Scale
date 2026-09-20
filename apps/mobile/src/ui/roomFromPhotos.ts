// A box room from six library photos plus one measurement. Each straightened
// wall photo carries the wall's true width-to-height ratio (the four-point
// transform preserves it), so a single entered ceiling height in metres
// gives every wall its width. Nothing is guessed: with no height there is no
// room, and a missing pair of opposite walls is an error, not a default.
import type { FaceId, RectifiedPhoto } from "../../modules/wall-capture";
import { wallTransformFrom } from "./roomFromFaces";
import type { RoomCaptureV1 } from "./types";

export type PhotoFaces = Partial<Record<FaceId, RectifiedPhoto>>;

export type PhotoRoom = {
  room: RoomCaptureV1;
  widthMeters: number; // along front/back
  depthMeters: number; // along left/right
  heightMeters: number;
  // Names of faces whose size came from the whole photo or a non-metric ratio: the room's
  // size is approximate along that axis. Said out loud, never hidden.
  approximate: string[];
};

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

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function roomFromPhotos(faces: PhotoFaces, heightMeters: number): PhotoRoom {
  if (!(heightMeters >= 1 && heightMeters <= 10)) throw new Error("Ceiling height must be between 100 and 1000 cm.");
  // A face whose rectangle was found with a metric aspect is exact; the rest are approximate.
  // Exact faces win the axis when present; approximate ones are used only when nothing better
  // exists, and reported.
  const approximate: string[] = [];
  const axis = (ids: ("front" | "back" | "left" | "right")[]): number | null => {
    const present = ids.filter((id) => faces[id]);
    const exact = present.filter((id) => faces[id]!.detected && faces[id]!.aspectIsMetric);
    const use = exact.length ? exact : present;
    if (!exact.length) approximate.push(...present);
    return mean(use.map((id) => faces[id]!.aspect * heightMeters));
  };
  const W = axis(["front", "back"]);
  const D = axis(["left", "right"]);
  if (W === null || D === null) throw new Error("Add one of front/back and one of left/right so the room has a width and a depth.");

  const H = heightMeters;
  const placements: Record<"front" | "back" | "left" | "right", { center: { x: number; y: number; z: number }; yawDeg: number; width: number }> = {
    front: { center: { x: 0, y: H / 2, z: -D / 2 }, yawDeg: 0, width: W },
    back: { center: { x: 0, y: H / 2, z: D / 2 }, yawDeg: 180, width: W },
    left: { center: { x: -W / 2, y: H / 2, z: 0 }, yawDeg: 90, width: D },
    right: { center: { x: W / 2, y: H / 2, z: 0 }, yawDeg: -90, width: D },
  };
  const walls = (Object.keys(placements) as (keyof typeof placements)[]).map((id) => {
    const p = placements[id];
    const photo = faces[id];
    return {
      id: uuid(),
      transform: wallTransformFrom(p.center, p.yawDeg),
      dimensions: [p.width, H, 0.1] as [number, number, number],
      // A wall whose photo was found and straightened is medium; one inferred from its
      // opposite is low. Nothing here is a LiDAR measurement, so never high.
      confidence: (photo?.detected ? "medium" : "low") as "medium" | "low",
    };
  });
  const polygon: [number, number][] = [
    [-W / 2, -D / 2],
    [W / 2, -D / 2],
    [W / 2, D / 2],
    [-W / 2, D / 2],
  ];
  return {
    room: {
      schemaVersion: 1,
      roomId: uuid(),
      capturedAt: new Date().toISOString(),
      worldAlignment: "gravityAndHeading",
      // ceiling: photos carry no heading; 0 says "not measured", matching the fallback path.
      northBearingDeg: 0,
      floor: { polygon, areaM2: W * D },
      walls,
      openings: [],
      objects: [],
    },
    widthMeters: W,
    depthMeters: D,
    heightMeters: H,
    approximate,
  };
}
