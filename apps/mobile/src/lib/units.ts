// The ONLY file in this app that formats centimetres. Every schema, prop, and
// variable elsewhere stays in metres — see .claude/contracts.md, "Global
// conventions": convert at the UI edge only.
//
// Rounds to one decimal place of a centimetre (not a whole centimetre),
// because several real dimensions in fixtures/object-macbook.json are under
// 2 cm (the MacBook's bboxMeters.h is 0.0155 m). Rounding to a whole
// centimetre would print "2 cm" for a laptop's thickness, which is wrong
// enough to matter on a screen whose whole pitch is measurement accuracy.

function roundToOneDecimalCm(meters: number): number {
  return Math.round(meters * 1000) / 10;
}

function formatCmValue(cm: number): string {
  return Number.isInteger(cm) ? `${cm}` : cm.toFixed(1);
}

// A single length, e.g. formatLengthCm(0.9) -> "90 cm".
export function formatLengthCm(meters: number): string {
  return `${formatCmValue(roundToOneDecimalCm(meters))} cm`;
}

// A width x height x depth triple, e.g. "31.3 × 1.6 × 22.1 cm".
export function formatDimensionsCm(w: number, h: number, d: number): string {
  const values = [w, h, d].map((m) => formatCmValue(roundToOneDecimalCm(m)));
  return `${values.join(" × ")} cm`;
}
