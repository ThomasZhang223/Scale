import type { ScannedObject } from './roomScan';

/**
 * The detected piece a scanned object should stand in for: the first one whose category
 * appears in the object's name ("chair.glb", "my-sofa-scan.glb") and that no other object
 * has taken yet. Null means the object gets a free spot instead.
 */
export function matchDetected(
  name: string,
  detected: ScannedObject[],
  taken: Iterable<string | undefined>,
): ScannedObject | null {
  const lower = name.toLowerCase();
  const used = new Set(taken);
  return detected.find((o) => lower.includes(o.category.toLowerCase()) && !used.has(o.identifier)) ?? null;
}
