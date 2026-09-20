// Whether library screens read the Worker's stub layer (X-Stub: 1, committed fixtures) or the
// live D1 catalog. Live is the default: the deployed Worker now holds real merchant rows, and a
// scan made on this phone only ever lands in the live table. Set EXPO_PUBLIC_STUB=1 in
// apps/mobile/.env.local to demo against fixtures with no network dependency.
export const STUB = process.env.EXPO_PUBLIC_STUB === "1";
