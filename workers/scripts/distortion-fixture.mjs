#!/usr/bin/env node
/*
 * Regenerates src/lib/distortion-ratios.ts from one or more binder reports.
 *
 *   node scripts/distortion-fixture.mjs <report.json> [more.json ...]
 *
 * A report is the binder's own output: an array of {objectId, distortion_ratio, ...}. Later
 * files WIN over earlier ones for an objectId that appears in both, so pass them oldest first —
 * a re-bound object's newer ratio is the true one.
 *
 * This runs by hand, never at request time: the Worker must not read anything outside its own
 * bundle. Its header records every source file and its row count, so a stale fixture is visible
 * in the diff rather than only in an `unrated=` count on a live response.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/distortion-fixture.mjs <report.json> [more.json ...]");
  process.exit(2);
}

const ratios = new Map();
const sources = [];
for (const file of files) {
  const rows = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${file}: expected an array of binder rows`);
  let overrode = 0;
  for (const row of rows) {
    const { objectId, distortion_ratio: ratio } = row;
    if (typeof objectId !== "string" || !objectId) throw new Error(`${file}: a row has no objectId`);
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 1) {
      throw new Error(`${file}: ${objectId} has distortion_ratio ${JSON.stringify(ratio)}`);
    }
    if (ratios.has(objectId) && ratios.get(objectId) !== Math.round(ratio * 1e4) / 1e4) overrode++;
    ratios.set(objectId, Math.round(ratio * 1e4) / 1e4);
  }
  sources.push({ name: basename(file), rows: rows.length, overrode });
}

const LIMIT = 1.5;
const sorted = [...ratios].sort((a, b) => a[1] - b[1]);
const good = sorted.filter(([, r]) => r <= LIMIT).length;
const today = new Date().toISOString().slice(0, 10);
const sourceLines = sources
  .map((s) => ` *   ${s.name} — ${s.rows} rows${s.overrode ? `, ${s.overrode} of them a newer ratio for an id an earlier file also had` : ""}`)
  .join("\n");

writeFileSync(
  new URL("../src/lib/distortion-ratios.ts", import.meta.url),
  `/*
 * Mesh distortion ratios, as a committed fixture. GENERATED — regenerate, do not hand-edit:
 *
 *   node scripts/distortion-fixture.mjs <report.json> [more.json ...]
 *
 * SF3D guesses depth from one photo, so a wide-shallow piece binds to its measured box with
 * visible stretch. The binder reports that as \`distortion_ratio\` (services/gen/app/binding:
 * max(t/e)/min(t/e)); ${LIMIT} and above is the "dimensional proxy recommended" band.
 *
 * Built ${today} from ${sources.length} report${sources.length === 1 ? "" : "s"}, later overriding earlier:
${sourceLines}
 *
 * ${ratios.size} objects: ${good} at or below ${LIMIT}, ${ratios.size - good} above it.
 *
 * ceiling: a committed copy goes stale the moment another mesh is bound, and a row bound after
 * this file was written has no entry — it sorts in the middle tier and \`unrated=\` on a
 * /v1/find response counts it. The ratio belongs on the D1 \`objects\` row or in a stored
 * receipt, written at attach time by component C (POST /v1/objects/{id}/mesh); this file is
 * what makes the ordering possible without a migration during the sprint.
 */

/** The band at which the binder stops recommending the mesh over a dimensional proxy. */
export const DISTORTION_LIMIT = ${LIMIT};

export const DISTORTION_RATIOS: Record<string, number> = {
${sorted.map(([id, r]) => `  "${id}": ${r},`).join("\n")}
};
`,
);
console.log(`${ratios.size} objects from ${sources.length} report(s): ${good} <= ${LIMIT}, ${ratios.size - good} above.`);
for (const s of sources) console.log(`  ${s.name}: ${s.rows} rows, ${s.overrode} overrides`);
