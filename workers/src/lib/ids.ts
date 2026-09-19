// Ids and hashes. Both conventions come from .claude/contracts.md "Global conventions".

/** UUID v4. Clients mint their own so a scan works offline; the server mints when they do not. */
export function uuid(): string {
  return crypto.randomUUID();
}

/** ISO 8601 with a Z suffix. Compute in UTC, convert once for display. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Stable sha256 over a value with object keys sorted, hex encoded.
 *
 * This is `Version v1.contentHash`. Sorting is what makes it stable: two versions with the
 * same placements written in a different key order must hash the same, or history diffing
 * reports a change that did not happen.
 */
export async function contentHash(value: unknown): Promise<string> {
  const canonical = JSON.stringify(sortKeys(value));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** A URL-safe random token. Used for the short-lived upload grant. */
export function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
