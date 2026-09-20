import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Node 24 strips TypeScript; resolve the Worker's bundler-style local imports.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) specifier += ".ts";
  return next(specifier, context);
} });
const { toSolveRequest, describeRoom } = await import("../src/lib/solveframe.ts");

// fixtures/room-demo.json: 4.0 x 3.5 m. North wall z=0, south wall z=3.5, west x=0, east x=4.
const room = JSON.parse(readFileSync(new URL("../../fixtures/room-demo.json", import.meta.url), "utf8"));
const WALL_NORTH = "838d678c-9de2-4bba-bd25-9e84cf97efb9";
const WALL_SOUTH = "df58db2c-43f1-4a8d-ab6d-1d33c088b24f";
const DOOR = "e6b6ff22-d92f-4d90-af34-18be7143095a";   // centre (1.2, 0.0), 0.9 m wide
const WINDOW = "6f7a39c0-8875-42fe-b336-548ff8bce1f5"; // centre (2.8, 3.5), 1.2 m wide
const candidates = ["sofa", "lamp"].map(objectId => ({ objectId, bboxMeters: { w: 2, h: 0.9, d: 0.9 } }));

const translate = rules => toSolveRequest({ room, candidates, placements: [], rules }).rules;
const one = fields => translate([{ id: "r1", type: "near", a: "sofa", priority: "must", ...fields }])[0];
const unknownTarget = ref => error => error.status === 422 && error.code === "unknown_rule_target" && error.message.includes(ref);

test("an object id in b or target becomes {object}", () => {
  assert.deepEqual(one({ b: "lamp" }).b, { object: "lamp" });
  assert.deepEqual(one({ type: "facing", target: "lamp" }).target, { object: "lamp" });
});

test("door:{id} and window:{id} become {point:[xCm,zCm]} at the opening centre", () => {
  assert.deepEqual(one({ b: `door:${DOOR}` }).b, { point: [120, 0] });
  assert.deepEqual(one({ b: `window:${WINDOW}` }).b, { point: [280, 350] });
  assert.deepEqual(one({ type: "facing", target: `window:${WINDOW}` }).target, { point: [280, 350] });
});

test("the documented target 'center' becomes the room centre", () => {
  assert.deepEqual(one({ type: "facing", target: "center" }).target, { point: [200, 175] });
});

test("wall:{id} becomes the cardinal side; cardinals and 'any' pass through", () => {
  const against = wall => one({ type: "against_wall", wall }).wall;
  assert.equal(against(`wall:${WALL_NORTH}`), "north");
  assert.equal(against(`wall:${WALL_SOUTH}`), "south");
  assert.equal(against("wall:7016098b-eeef-4d7f-b6bf-8b48c16aa88c"), "west");
  assert.equal(against("wall:51e06902-4fcf-402b-8a2a-b49ee2b9b0e0"), "east");
  for (const side of ["north", "south", "east", "west", "any"]) assert.equal(against(side), side);
});

test("a keep_clear zone: walkway passes through, door and window become {rect}", () => {
  const zone = ref => one({ type: "keep_clear", zone: ref, marginCm: 80 }).zone;
  assert.equal(zone("walkway"), "walkway");
  assert.deepEqual(zone(`door:${DOOR}`), { rect: { minX: 75, maxX: 165, minZ: -45, maxZ: 45 } });
  assert.deepEqual(zone(`window:${WINDOW}`), { rect: { minX: 220, maxX: 340, minZ: 290, maxZ: 410 } });
  assert.equal(one({ type: "keep_clear", zone: "walkway", marginCm: 80 }).marginCm, 80);
});

test("every other field of a rule survives untouched", () => {
  const [rule] = translate([{ id: "r9", type: "near", a: "sofa", b: "lamp", maxCm: 120, priority: "should", weight: 4, why: "lamp by the sofa" }]);
  assert.deepEqual(rule, { id: "r9", type: "near", a: "sofa", b: { object: "lamp" }, maxCm: 120, priority: "should", weight: 4, why: "lamp by the sofa" });
  assert.deepEqual(translate([{ id: "p", type: "pin", a: "sofa", priority: "must" }]), [{ id: "p", type: "pin", a: "sofa", priority: "must" }]);
  assert.deepEqual(translate([]), []);
});

test("a reference that resolves to nothing throws and names it, never dropping the rule", () => {
  const cases = [
    [{ b: "ghost-object" }, "ghost-object"],
    [{ b: "door:nope" }, "door:nope"],
    [{ b: `door:${WINDOW}` }, WINDOW],          // an id of the wrong kind is not a door
    [{ b: `window:${DOOR}` }, DOOR],
    [{ type: "facing", target: "window:nope" }, "window:nope"],
    [{ type: "against_wall", wall: "wall:nope" }, "wall:nope"],
    [{ type: "against_wall", wall: WALL_NORTH }, WALL_NORTH], // the bare id is not the documented form
    [{ type: "against_wall", wall: "up" }, "up"],
    [{ type: "keep_clear", zone: "door:nope" }, "door:nope"],
    [{ type: "keep_clear", zone: "hallway" }, "hallway"],
    [{ b: 42 }, "42"],
  ];
  for (const [fields, ref] of cases) assert.throws(() => one(fields), unknownTarget(ref), JSON.stringify(fields));
});

test("an unknown reference in any rule of a plan fails the whole plan", () => {
  assert.throws(() => translate([
    { id: "ok", type: "pin", a: "sofa", priority: "must" },
    { id: "bad", type: "near", a: "sofa", b: "ghost", priority: "should" },
  ]), unknownTarget("ghost"));
});

test("describeRoom lists the real wall and opening ids with their side and kind", () => {
  const { walls, openings } = describeRoom(room);
  assert.deepEqual(walls.map(w => [w.id, w.side]).slice(0, 2), [[WALL_NORTH, "north"], [WALL_SOUTH, "south"]]);
  assert.equal(walls.length, 4);
  assert.deepEqual(openings, [{ id: DOOR, kind: "door", side: "north" }, { id: WINDOW, kind: "window", side: "south" }]);
});
