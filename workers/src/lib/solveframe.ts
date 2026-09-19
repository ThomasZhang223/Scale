// The one place metres become centimetres, and the one place our rotation convention becomes
// Justin's. Both directions live here so a reader can check them against each other.
//
// His contract (apps/xr/docs/agent/01_CONTRACT.md §6) says "The Worker does all coordinate
// conversion; the solver only sees integer centimeters". That makes this file the UI edge that
// CLAUDE.md standing rule 1 permits converting at, and the only file in the project allowed to
// mention centimetres.

import type {
  ObjectV1,
  PlacementV1,
  RoomCaptureV1,
  SolveRequest,
  SolveResponse,
} from "./contracts";
import { HttpError } from "./http";
import { uuid } from "./ids";

const M_TO_CM = 100;

/** Metres to whole centimetres. The solver's variables are integers; a float would be rejected. */
function cm(metres: number): number {
  return Math.round(metres * M_TO_CM);
}

/**
 * Our yaw and his rotation disagree about which way "front" points: the mesh normalisation
 * contract puts the front face at −Z, his solver frame puts it at +Z. Working the four
 * quarter-turns through both conventions gives a flat 180° offset, and the mapping is its own
 * inverse — which is why one function serves both directions.
 *
 * Getting this wrong turns every chair to face the wall, and nothing anywhere throws.
 */
export function yawToRotDeg(yawDeg: number): number {
  return (((Math.round(yawDeg / 90) * 90) + 180) % 360 + 360) % 360;
}
export const rotDegToYaw = yawToRotDeg;

/** Translation column of a column-major 4x4. Elements 12, 13, 14 are x, y, z. */
function originOf(transform: unknown): { x: number; z: number } {
  const t = transform as number[] | undefined;
  if (!Array.isArray(t) || t.length !== 16) {
    throw new HttpError(422, "bad_transform", "A wall or opening transform is not 16 floats.");
  }
  return { x: t[12], z: t[14] };
}

/**
 * Axis-aligned room bounds from the floor polygon.
 *
 * ceiling: the bounding rectangle of the polygon, not the polygon itself. His solver takes
 * `boundsCm` as a rectangle, so an L-shaped room would gain floor area it does not have and
 * the solver could place a sofa inside the missing corner. Acceptable while the demo room is
 * rectangular — fixtures/room-demo.json is 4.0 x 3.5 m — and the upgrade is passing the
 * concave corners as keep_clear zones.
 */
function boundsFromFloor(room: RoomCaptureV1) {
  const poly = room?.floor?.polygon;
  if (!Array.isArray(poly) || poly.length < 3) {
    throw new HttpError(422, "bad_floor", "The room capture has no usable floor polygon.");
  }
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  return {
    minX: cm(Math.min(...xs)),
    maxX: cm(Math.max(...xs)),
    minZ: cm(Math.min(...zs)),
    maxZ: cm(Math.max(...zs)),
  };
}

/** Which wall an opening sits on, from its position relative to the room bounds. */
function sideOf(x: number, z: number, b: ReturnType<typeof boundsFromFloor>): string {
  const d = [
    { side: "west", v: Math.abs(x - b.minX) },
    { side: "east", v: Math.abs(x - b.maxX) },
    { side: "north", v: Math.abs(z - b.minZ) },
    { side: "south", v: Math.abs(z - b.maxZ) },
  ];
  d.sort((p, q) => p.v - q.v);
  return d[0].side;
}

interface Opening {
  id: string;
  kind: string;
  transform: number[];
  dimensions: number[];
}

/**
 * Build the solver's view of the room and the furniture in it.
 *
 * `fixed` are placements that already exist; `candidates` supply each object's measured size.
 * An object with no placement starts at the room centre and is movable — the solver's job is
 * to find it a home, and its objective already prefers not moving things far.
 */
export function toSolveRequest(args: {
  room: RoomCaptureV1;
  candidates: ObjectV1[];
  placements: PlacementV1[];
  rules: SolveRequest["rules"];
  movable?: string[];
  walkwayCm?: number;
  timeLimitMs?: number;
}): SolveRequest {
  const b = boundsFromFloor(args.room);
  const openings = (args.room?.openings ?? []) as unknown as Opening[];

  const doors = openings
    .filter((o) => o.kind === "door")
    .map((o) => {
      const { x, z } = originOf(o.transform);
      // The swept area a door needs: its own width, and its height of swing into the room.
      // Depth defaults to the leaf width, which is what a 90-degree swing sweeps.
      const w = cm(o.dimensions?.[0] ?? 0.9);
      const half = Math.round(w / 2);
      return {
        id: o.id,
        keepOut: {
          minX: cm(x) - half,
          maxX: cm(x) + half,
          minZ: cm(z) - half,
          maxZ: cm(z) + half,
        },
      };
    });

  const windows = openings
    .filter((o) => o.kind === "window")
    .map((o) => {
      const { x, z } = originOf(o.transform);
      return {
        id: o.id,
        xCm: cm(x),
        zCm: cm(z),
        widthCm: cm(o.dimensions?.[0] ?? 1.0),
        side: sideOf(cm(x), cm(z), b),
      };
    });

  const walls = ((args.room?.walls ?? []) as { id: string; transform: number[] }[]).map((w) => {
    const { x, z } = originOf(w.transform);
    return { id: w.id, side: sideOf(cm(x), cm(z), b) };
  });

  const byId = new Map(args.candidates.map((o) => [o.objectId, o]));
  const placed = new Map(args.placements.map((p) => [p.objectId, p]));
  const centreX = Math.round((b.minX + b.maxX) / 2);
  const centreZ = Math.round((b.minZ + b.maxZ) / 2);

  const objects = args.candidates.map((o) => {
    const p = placed.get(o.objectId);
    const box = byId.get(o.objectId)!.bboxMeters;
    return {
      id: o.objectId,
      // Width is the left-right size facing forward, depth is front-back. Object v1's w and d
      // are exactly that, so no axis swap — but a swap here is invisible until the demo.
      widthCm: cm(box.w),
      depthCm: cm(box.d),
      xCm: p ? cm(p.p[0]) : centreX,
      zCm: p ? cm(p.p[2]) : centreZ,
      rotDeg: yawToRotDeg(p?.yawDeg ?? 0),
      movable: args.movable ? args.movable.includes(o.objectId) : true,
    };
  });

  return {
    room: { boundsCm: b, doors, windows, walls },
    objects,
    rules: args.rules,
    // 60 cm is his documented default. The time limit keeps a hard solve inside the Worker's
    // 25-second upstream timeout with room to spare; his prototype solved in 267 ms.
    settings: { walkwayCm: args.walkwayCm ?? 60, timeLimitMs: args.timeLimitMs ?? 2000 },
  };
}

/** His placements back into Placement v1. Scale is always 1: a bound GLB is already true size. */
export function toPlacements(res: SolveResponse, existing: PlacementV1[]): PlacementV1[] {
  const previous = new Map(existing.map((p) => [p.objectId, p]));
  return (res.placements ?? []).map((p) => ({
    placementId: previous.get(p.id)?.placementId ?? uuid(),
    objectId: p.id,
    p: [p.xCm / M_TO_CM, 0, p.zCm / M_TO_CM] as [number, number, number],
    yawDeg: rotDegToYaw(p.rotDeg),
    scale: 1.0,
    lockedToWallId: previous.get(p.id)?.lockedToWallId ?? null,
    flags: previous.get(p.id)?.flags ?? [],
  }));
}

/**
 * A sentence a person can act on, or null when the solve succeeded.
 *
 * contracts.md requires an infeasible answer to explain itself rather than just saying no —
 * "drop the ottoman, or go 20 cm narrower on the couch" is the standard it sets. The solver
 * reports which must-rules conflict; this turns those ids back into the model's own `why` text.
 */
export function infeasibleReason(
  res: SolveResponse,
  rules: SolveRequest["rules"],
): string | null {
  if (res.status === "OPTIMAL" || res.status === "FEASIBLE") return null;
  if (res.status === "TIMEOUT") {
    return "The solver ran out of time before finding an arrangement. Try fewer pieces, or relax a constraint.";
  }
  const why = (res.conflicts ?? [])
    .map((id) => rules.find((r) => r.id === id)?.why ?? id)
    .filter(Boolean);
  return why.length > 0
    ? `No arrangement satisfies all of these at once: ${why.join("; ")}.`
    : "No arrangement satisfies every hard rule, and the solver did not say which ones conflict.";
}
