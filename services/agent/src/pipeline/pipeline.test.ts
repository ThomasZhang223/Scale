import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRoom, roomFacts, placementToSolver, solverToPlacement, rotate } from './room.ts';
import { validatePlan, resolvePlan, hardRules } from './plan.ts';
import { cleanState } from './clean.ts';
import { runLoop, convertBack, AgentFailure, type LoopDeps, type LoopInput } from './loop.ts';
import type { Plan, PlacementV1, RoomState, SolverRequest, SolverResponse, FitReport, LogEntry } from './types.ts';

/* W1–W10 from apps/xr/docs/agent/09_END_TO_END_TESTS.md, against the golden fixtures. */

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8'));
const F = '../../fixtures/pipeline/';
const sampleRoom = read('../../../../apps/xr/public/room-scan.json');
const roomFactsFixture = read(`${F}room-facts.json`);
const planFixture: Plan = read(`${F}plan.json`);
const planInvalid: Plan = read(`${F}plan-invalid.json`);
const solveRequest: SolverRequest = read(`${F}solve-request.json`);
const solveResponse: SolverResponse = read(`${F}solve-response.json`);
const vectors = read(`${F}conversion-vectors.json`);
const presets = read('../../fixtures/preset-plans.json');

const placement = (placementId: string, objectId: string, p: [number, number, number], yawDeg: number): PlacementV1 =>
  ({ placementId, objectId, p, yawDeg, scale: 1, lockedToWallId: null, flags: [] });

/** The headset's state for the sample room, matching the worked example. */
function sampleState(): RoomState {
  return {
    room: sampleRoom,
    objects: {
      obj_sofa: { name: 'sofa', category: 'sofa', bboxMeters: { w: 2.19, h: 0.79, d: 1.02 }, source: 'scan', detectedDims: [2.0, 0.85, 0.9] },
      obj_chair: { name: 'chair', category: 'chair', bboxMeters: { w: 0.83, h: 0.69, d: 0.57 }, source: 'scan', detectedDims: [0.6, 0.9, 0.6] },
      obj_table: { name: 'table', category: 'table', bboxMeters: { w: 1.0, h: 0.45, d: 0.6 }, source: 'box', confidence: 'high' },
      obj_storage: { name: 'storage', category: 'storage', bboxMeters: { w: 0.8, h: 1.8, d: 0.4 }, source: 'box', confidence: 'high' },
    },
    placements: [
      placement('pl_sofa', 'obj_sofa', [0.7, -1.4, -0.34], 0),
      placement('pl_chair', 'obj_chair', [2.1, -1.4, 1.2], 270),
      placement('pl_table', 'obj_table', [0.7, -1.4, 1.18], 0),
      placement('pl_storage', 'obj_storage', [-1.15, -1.4, 1.7], 90),
    ],
  };
}

const near = (a: number, b: number, what: string, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${what}: expected ${b}, got ${a}`);

test('W1: room facts built from the sample room equal room-facts.json', () => {
  const state = sampleState();
  const geo = readRoom(state.room);
  assert.deepEqual(geo.offset, [-0.7, 1.4, -0.9]);
  assert.equal(geo.thetaDeg, 0);
  assert.deepEqual(geo.bounds, { minX: -205, maxX: 205, minZ: -175, maxZ: 175 });
  const cleaned = cleanState(state, geo, [], 'Reading corner by the window');
  const facts = roomFacts({ state, geo, pins: [], preferences: [], request: 'Reading corner by the window', movable: cleaned.objects });
  assert.deepEqual(facts, roomFactsFixture);
});

test('W2: the invalid plan yields three precise errors', () => {
  const state = sampleState();
  const geo = readRoom(state.room);
  const cleaned = cleanState(state, geo, [], 'Reading corner by the window');
  const facts = roomFacts({ state, geo, pins: [], preferences: [], request: 'x', movable: cleaned.objects });
  const errors = validatePlan(planInvalid, facts);
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors[0], /^r1\.a: "obj_armchair" is not in the room; objects are obj_sofa, obj_chair, obj_table, obj_storage$/);
  assert.match(errors[1], /^r1\.maxCm: 5 is below 20$/);
  assert.match(errors[2], /^r3: an object can't be near itself$/);
  assert.deepEqual(validatePlan(planFixture, facts), []);
});

test('W3: the plan resolves to exactly the rules in solve-request.json', () => {
  const state = sampleState();
  const geo = readRoom(state.room);
  const cleaned = cleanState(state, geo, [], 'Reading corner by the window');
  const facts = roomFacts({ state, geo, pins: [], preferences: [], request: 'x', movable: cleaned.objects });
  assert.deepEqual(resolvePlan(planFixture, facts, geo, 60), solveRequest.rules);
});

test('W4: pins and remembered preferences become rules the model cannot remove', () => {
  const state = sampleState();
  const geo = readRoom(state.room);
  const cleaned = cleanState(state, geo, ['obj_table'], 'x');
  const facts = roomFacts({ state, geo, pins: ['obj_table'], preferences: [], request: 'x', movable: cleaned.objects });
  const rules = hardRules(facts, [{ rule: { id: 'p', type: 'facing', a: 'obj_sofa', target: 'window:win1', priority: 'should' }, weight: 4 }]);
  assert.deepEqual(rules[0], { id: 'pin:obj_table', type: 'pin', a: 'obj_table', priority: 'must' });
  assert.equal(rules[1].type, 'facing');
  assert.equal(rules[1].priority, 'should');
  assert.equal(rules[1].weight, 4);
});

test('W5: converting solve-response.json back matches the vectors; unmoved objects keep their exact pose', () => {
  const state = sampleState();
  const geo = readRoom(state.room);
  for (const v of vectors.vectors.filter((x: { thetaDeg: number }) => x.thetaDeg === 0)) {
    const original = placement('p', 'o', v.version.p, v.version.yawDeg);
    const pose = placementToSolver(original, geo);
    assert.deepEqual([pose.xCm, pose.zCm, pose.rotDeg], [v.solver.xCm, v.solver.zCm, v.solver.rotDeg], v.name);
    const back = solverToPlacement(placement('p', 'o', [0, -1.4, 0], 0), { xCm: 999, zCm: 999, rotDeg: 180 }, v.solver, geo);
    near(back.p[0], v.version.p[0], `${v.name} x`); near(back.p[2], v.version.p[2], `${v.name} z`); near(back.yawDeg, v.version.yawDeg, `${v.name} yaw`);
  }
  // Rotated room: the vector's scene pose from a solver pose at theta = 12.
  const r = vectors.vectors.find((x: { thetaDeg: number }) => x.thetaDeg === 12);
  const [sx, sz] = rotate(r.solver.xCm / 100, r.solver.zCm / 100, 12);
  near(sx, r.scene.x, 'theta x', 1e-9); near(sz, r.scene.z, 'theta z', 1e-9);
  // Unmoved odd angle: exact original pose back.
  const odd = vectors.unmovedOddAngle;
  const original = placement('p', 'o', odd.original.p, odd.original.yawDeg);
  assert.equal(solverToPlacement(original, odd.solverInput, odd.solverOutput, geo), original);
  // The recorded solve: storage untouched (same object), sofa and chair moved.
  const objects = solveRequest.objects;
  const placements = convertBack(state.placements, objects, solveResponse, geo);
  assert.equal(placements[3], state.placements[3], 'storage keeps its exact placement');
  assert.equal(placements[2], state.placements[2], 'table keeps its exact placement');
  near(placements[0].p[0], 0.7 + 0.95, 'sofa x'); near(placements[0].p[2], -0.34, 'sofa z');
  near(placements[1].p[0], 0.7 - 1.17, 'chair x'); near(placements[1].p[2], 0.9 - 1.42, 'chair z'); assert.equal(placements[1].yawDeg, 0);
});

// ---------- the loop, with a fixed plan and stubbed tools ----------

function deps(overrides: Partial<LoopDeps> & { solves?: SolverResponse[]; fits?: FitReport[] }): LoopDeps & { entries: LogEntry[]; solveCalls: SolverRequest[] } {
  const entries: LogEntry[] = [];
  const solveCalls: SolverRequest[] = [];
  const { solves = [solveResponse], fits = [{ schemaVersion: 1, ok: true, checkedAt: '', violations: [] }], ...rest } = overrides;
  const d = {
    plan: async () => planFixture,
    presetPlans: presets,
    solve: async (req: SolverRequest) => { solveCalls.push(req); return solves[Math.min(solveCalls.length - 1, solves.length - 1)]; },
    fit: async () => fits[Math.min(solveCalls.length - 1, fits.length - 1)],
    log: (e: LogEntry) => { entries.push(e); },
    status: () => {},
    mintVersionId: () => 'ver_test',
    ...rest,
  } as LoopDeps;
  return Object.assign(d, { entries, solveCalls });
}

const input = (extra: Partial<LoopInput> = {}): LoopInput => ({
  roomId: 'room', requestId: 'req_1', preset: 'reading_corner', pins: [], baseVersionId: 'ver_base', state: sampleState(), preferences: [], recentUserObjectIds: [], ...extra,
});

test('loop: a preset on the sample room proposes the recorded moves with a clean fit', async () => {
  const d = deps({});
  const proposal = await runLoop(input(), d);
  assert.equal(proposal.moves.length, 2);
  assert.deepEqual(proposal.moves.map((m) => m.objectId).sort(), ['obj_chair', 'obj_sofa']);
  assert.deepEqual(proposal.fit, { red: 0, amber: 0 });
  assert.match(proposal.explanation, /chair/i);
  assert.ok(d.entries.some((e) => e.kind === 'data' && /Sofa scan is 2\.19 m, detected box 2\.00 m: using the scan/.test(e.message)), 'the messy-data decision is logged');
  assert.ok(d.entries.some((e) => e.kind === 'plan'), 'plan logged');
  assert.ok(d.entries.some((e) => e.kind === 'solve'), 'solve logged');
  assert.ok(d.entries.some((e) => e.kind === 'fit'), 'fit logged');
  assert.equal(d.solveCalls[0].settings.walkwayCm, 60);
});

test('W6: an infeasible solve relaxes the latest clashing must, logs it, and solves again', async () => {
  const twoMusts: Plan = { summary: 's', rules: [
    { id: 'r1', type: 'near', a: 'obj_chair', b: 'window:win1', maxCm: 100, priority: 'must', why: 'daylight' },
    { id: 'r2', type: 'near', a: 'obj_chair', b: 'door:d1', maxCm: 30, priority: 'must', why: 'by the door' },
  ] };
  const d = deps({ plan: async () => twoMusts, solves: [{ ...solveResponse, status: 'INFEASIBLE', conflicts: ['r1', 'r2'], placements: [] }, solveResponse] });
  const proposal = await runLoop(input(), d);
  assert.equal(d.solveCalls.length, 2);
  assert.equal(d.solveCalls[1].rules.find((r) => r.id === 'r2')?.priority, 'should');
  assert.equal(d.solveCalls[1].rules.find((r) => r.id === 'r1')?.priority, 'must');
  assert.ok(d.entries.some((e) => e.kind === 'retry' && /relaxing "by the door"/.test(e.message)));
  assert.deepEqual(proposal.unsatisfied.map((u) => u.ruleId), ['r2']);
});

test('W7: a red fit issue strengthens the rules and re-solves; two rounds logged', async () => {
  const red: FitReport = { schemaVersion: 1, ok: false, checkedAt: '', violations: [{ kind: 'clearance', severity: 'block', placementId: 'pl_chair', detailMeters: 0.2, message: 'narrows the walkway', geometry: {} }] };
  const clean: FitReport = { schemaVersion: 1, ok: true, checkedAt: '', violations: [] };
  const d = deps({ solves: [solveResponse, solveResponse], fits: [red, clean] });
  const proposal = await runLoop(input(), d);
  assert.equal(d.solveCalls.length, 2);
  assert.equal(d.solveCalls[1].settings.walkwayCm, 75);
  assert.equal(d.entries.filter((e) => e.kind === 'fit').length, 2);
  assert.ok(d.entries.some((e) => e.kind === 'retry' && /walkway 75 cm/.test(e.message)));
  assert.deepEqual(proposal.fit, { red: 0, amber: 0 });
});

test('W8: a planner that stays invalid fails the request readably, with both attempts logged', async () => {
  const d = deps({ plan: async () => planInvalid });
  await assert.rejects(runLoop(input({ preset: undefined, text: 'Reading corner by the window' }), d), (err: Error) => err instanceof AgentFailure && /couldn't turn that into a valid plan/.test(err.message) && /obj_armchair/.test(err.message));
  assert.equal(d.entries.filter((e) => e.kind === 'retry').length, 2);
});

test('W9: an unreachable solver fails with the solver message', async () => {
  const d = deps({ solve: async () => { throw new Error('fetch failed'); } });
  await assert.rejects(runLoop(input(), d), (err: Error) => err instanceof AgentFailure && /solver isn't reachable/.test(err.message));
});

test('W10: the template explanation only mentions objects that moved', async () => {
  const d = deps({ explain: async () => { throw new Error('offline'); } });
  const proposal = await runLoop(input(), d);
  assert.match(proposal.explanation, /sofa/);
  assert.match(proposal.explanation, /chair/);
  assert.doesNotMatch(proposal.explanation, /table|storage/);
  assert.deepEqual(proposal.tradeoffs, []);
});

test('planner offline: the preset falls back to the built-in plan and says so', async () => {
  const d = deps({ plan: async () => null });
  const proposal = await runLoop(input({ preset: 'clear_door' }), d);
  assert.ok(d.entries.some((e) => /Planner offline: using the built-in plan for 'Clear the door'/.test(e.message)));
  assert.equal(proposal.summary, 'Clear the door');
});
