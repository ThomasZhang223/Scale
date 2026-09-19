import type { PlacementV1, VersionV1 } from './api';

/*
 * Placement v1 <-> the scene. Placements live in the room's capture frame; the scene is
 * that frame shifted by the room's recentering offset. yawDeg is degrees counter-clockwise
 * seen from +Y, which is exactly three.js rotation.y in degrees, so only the units change.
 */

export interface PlacedLayout {
  placementId: string;
  objectId: string;
  position: [number, number, number]; // scene, bottom-center
  rotationY: number; // radians
}

export function toScene(p: [number, number, number], offset: [number, number, number]): [number, number, number] {
  return [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
}

export function toCapture(position: [number, number, number], offset: [number, number, number]): [number, number, number] {
  return [position[0] - offset[0], position[1] - offset[1], position[2] - offset[2]];
}

export const yawDegToRotationY = (deg: number) => (deg * Math.PI) / 180;
export const rotationYToYawDeg = (rad: number) => (rad * 180) / Math.PI;

export function fromPlacement(p: PlacementV1, offset: [number, number, number]): PlacedLayout {
  return { placementId: p.placementId, objectId: p.objectId, position: toScene(p.p, offset), rotationY: yawDegToRotationY(p.yawDeg) };
}

export function toPlacement(l: PlacedLayout, offset: [number, number, number]): PlacementV1 {
  const p = toCapture(l.position, offset).map((n) => round(n, 4)) as [number, number, number];
  return { placementId: l.placementId, objectId: l.objectId, p, yawDeg: round(rotationYToYawDeg(l.rotationY), 2), scale: 1, lockedToWallId: null, flags: [] };
}

const DEFAULT_MATERIALS = { wall: '#e8e4dc', floor: '#b9a88f', trim: '#ffffff' };

/** A Version v1 body for the current layout, ready to POST. The server mints versionId and createdAt. */
export async function layoutToVersion(
  roomId: string,
  layout: PlacedLayout[],
  offset: [number, number, number],
  parentId: string | null,
  label: string,
): Promise<Omit<VersionV1, 'versionId' | 'createdAt'>> {
  const placements = layout.map((l) => toPlacement(l, offset));
  return {
    schemaVersion: 1,
    roomId,
    parentId,
    label,
    placements,
    materials: DEFAULT_MATERIALS,
    contentHash: await contentHash(placements, DEFAULT_MATERIALS),
  };
}

/** sha256 of placements + materials with keys sorted, so equal layouts hash equal. */
export async function contentHash(placements: PlacementV1[], materials: Record<string, string>): Promise<string> {
  const text = JSON.stringify({ materials, placements }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places + 0;
