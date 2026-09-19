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
