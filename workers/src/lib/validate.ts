import { HttpError } from "./http";
import { SCHEMA_VERSION } from "./contracts";

/**
 * The one line of code that makes a schema change loud.
 *
 * .claude/contracts.md: "Every consumer validates schemaVersion on read and raises when it
 * does not match what it was built against. Do not fall back to a default and do not coerce.
 * A mismatch is a person problem, and it should arrive as an exception with a name in it, not
 * as a NaN two hours later."
 */
export function assertSchemaVersion(doc: { schemaVersion?: unknown }, what: string): void {
  if (doc?.schemaVersion !== SCHEMA_VERSION) {
    throw new HttpError(
      422,
      "schema_version_mismatch",
      `${what} schemaVersion ${String(doc?.schemaVersion)}, expected ${SCHEMA_VERSION} — ask Thomas`,
    );
  }
}

/**
 * A room without true north is a room whose sun direction and window normals are invented.
 * contracts.md: reject the upload with 422 rather than storing it, because retrofitting means
 * re-scanning every room.
 */
export function assertWorldAlignment(doc: { worldAlignment?: unknown }): void {
  if (doc?.worldAlignment !== "gravityAndHeading") {
    throw new HttpError(
      422,
      "bad_world_alignment",
      `worldAlignment is ${JSON.stringify(doc?.worldAlignment)}, expected "gravityAndHeading". ` +
        `Set ARConfiguration.worldAlignment = .gravityAndHeading before capturing.`,
    );
  }
}

/** Metres, float, positive, and physically plausible. A 90 m sofa is an extraction bug. */
export function assertBBoxMeters(bbox: unknown, what: string): asserts bbox is { w: number; h: number; d: number } {
  const b = bbox as Record<string, unknown> | null;
  for (const axis of ["w", "h", "d"] as const) {
    const v = b?.[axis];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 20) {
      throw new HttpError(
        422,
        "bad_bbox",
        `${what}.bboxMeters.${axis} is ${JSON.stringify(v)}. Expected metres, a finite number in (0, 20].`,
      );
    }
  }
}

/** A required field, raised by name rather than defaulted. Standing rule 4. */
export function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined || value === "") {
    throw new HttpError(400, "missing_field", `${name} is required and was not provided.`);
  }
  return value;
}
