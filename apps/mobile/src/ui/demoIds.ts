// ceiling: .claude/contracts.md has no GET /rooms or GET /objects (list)
// endpoint, only GET /rooms/{id} and GET /objects/{id} — there is exactly
// one demo room and one demo object, and no discovery endpoint yet. These
// are the real ids from the two committed fixtures (fixtures/room-demo.json,
// fixtures/object-macbook.json); X-Stub: 1 returns the matching fixture
// regardless of what id is actually in the path. Upgrade path: add a real
// list/search endpoint once more than one room or object exists, and
// delete this file — every screen that imports it points at the same
// upgrade.
export const DEMO_ROOM_ID = "8b371353-29a8-4872-8dce-45b7d50576a7";
export const DEMO_OBJECT_ID = "42d37a2f-9975-418b-9a41-d427b252023b";

// Rooms seeded into the live table on 2026-09-20 so the Rooms tab is not one card: a studio
// (3.2 × 4.5 × 2.6 m), a living room (5.8 × 4.2 × 2.9), a small office (2.4 × 3.0 × 2.4) and an
// open space (7.5 × 5.5 × 3.2), each with a door and a window and its own wall and floor
// colours. Real rows in D1 (scratchpad seed-rooms.mjs wrote them), listed here because the
// Worker has no list-rooms route. Remove when it does.
export const SEED_ROOM_IDS: readonly string[] = [
  "ccff7dec-1fc1-493e-96e3-3ab6f6ddfb2a", // Meeting room  (same two ids as apps/xr/.env.production VITE_ROOMS)
  "b5318133-49d1-4484-88dc-f38cef684175", // Skyline room
];
