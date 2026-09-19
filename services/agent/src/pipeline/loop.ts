import type {
  FitReport, LogEntry, Plan, PlacementV1, Preference, Proposal, RequestState, RoomFacts, RoomState, Rule, SolverRequest, SolverResponse,
} from './types.ts';
import { PRESETS, now } from './types.ts';
import { FACING, readRoom, roomFacts, solverObjects, solverToPlacement, type RoomGeometry } from './room.ts';
import { buildSolverRequest, hardRules, resolvePlan, validatePlan } from './plan.ts';
import { cleanState } from './clean.ts';

/*
 * The agent loop: reading → cleaning → planning → solving → checking → explaining →
 * proposing. Every outside call is injected, so the loop is tested with a fixed plan
 * and a stubbed solver, and runs for real inside the Durable Object. 03_WORKER_AGENT.md.
 */

export interface LoopInput {
  roomId: string;
  requestId: string;
  text?: string;
  preset?: string;
  pins: string[];
  baseVersionId: string;
  state: RoomState;
  preferences: Preference[];
  /** Objects a person placed in the last minute: pinned unless the request names them. */
  recentUserObjectIds: string[];
}

export interface LoopDeps {
  /** null: the planner is offline; the loop falls back to the preset plans. */
  plan: (facts: Parameters<typeof validatePlan>[1], previous?: { plan: Plan; errors: string[] }) => Promise<Plan | null>;
  presetPlans: Record<string, Plan & { text: string }>;
  solve: (req: SolverRequest) => Promise<SolverResponse>;
  fit: (room: Record<string, unknown>, placements: PlacementV1[], objects: Record<string, { w: number; h: number; d: number }>) => Promise<FitReport>;
  explain?: (factsText: string) => Promise<{ explanation: string; tradeoffs: string[] }>;
  log: (entry: LogEntry) => void;
  status: (state: RequestState, message: string) => void;
  mintVersionId: () => string;
}

export class AgentFailure extends Error {}

const MAX_ROUNDS = 3;
const MAX_RELAXATIONS = 2;
const WALKWAY_CM = 60;
const WALKWAY_MIN_CM = 30;
const WALKWAY_STEP_CM = 15;
const TIME_LIMIT_MS = 2000;
const TIME_LIMIT_BUSY_MS = 3000; // more than eight pieces: proving optimality is hopeless, take the best found
const CROWDED = 8; // pieces; above this, start with 60 cm walkways rather than discover 90 won't fit

export async function runLoop(input: LoopInput, deps: LoopDeps): Promise<Proposal> {
  const say = (kind: LogEntry['kind'], message: string, severity: LogEntry['severity'] = 'info') => deps.log({ at: now(), kind, message, severity });
  const requestText = input.text ?? (input.preset ? PRESETS[input.preset] ?? input.preset : '');
  if (!requestText) throw new AgentFailure('The request has no text and no preset.');

  // 1. Reading
  deps.status('reading', 'Reading room…');
  let geo: RoomGeometry;
  try {
    geo = readRoom(input.state.room);
  } catch (err) {
    throw new AgentFailure(`Couldn't read the room: ${(err as Error).message}`);
  }
  // Things a person just placed stay put — unless the request is about the whole room
  // (rearrange / tidy), or names them, or "just placed" would mean everything.
  const wholeRoom = input.preset === 'tidy_room' || presetFromText(requestText) === 'tidy_room';
  let recent = wholeRoom
    ? []
    : input.recentUserObjectIds.filter((id) => !requestText.toLowerCase().includes((input.state.objects[id]?.category ?? '').toLowerCase()));
  if (recent.length && recent.length >= input.state.placements.length) recent = [];
  const pins = [...new Set([...input.pins, ...recent])];
  const b = geo.bounds;
  say('data', `Room ${((b.maxX - b.minX) / 100).toFixed(1)} × ${((b.maxZ - b.minZ) / 100).toFixed(1)} m, ${input.state.placements.length} objects, ${geo.doors.length} door${geo.doors.length === 1 ? '' : 's'}, ${geo.windows.length} window${geo.windows.length === 1 ? '' : 's'}, layout ${input.baseVersionId}${pins.length ? `, pinned: ${pins.join(', ')}` : ''}.`);

  // 2. Cleaning
  deps.status('reading', 'Checking the data…');
  const cleaned = cleanState(input.state, geo, pins, requestText, wholeRoom);
  for (const e of cleaned.log) deps.log(e);
  const facts = roomFacts({
    state: { ...input.state, placements: input.state.placements.filter((p) => !cleaned.excluded.includes(p.objectId)) },
    geo,
    pins,
    preferences: input.preferences.map((p) => ({ text: p.text })),
    request: requestText,
    movable: cleaned.objects,
  });
  if (!facts.objects.length) throw new AgentFailure('There is nothing in the room to arrange yet.');
  if (input.preferences.length) say('memory', `Remembered: ${input.preferences.map((p) => p.text).join('; ')}.`);

  // 3. Planning
  deps.status('planning', 'Planning…');
  let plan = input.preset === 'tidy_room' ? null : await deps.plan(facts);
  let usedPreset = false;
  let closePairs: [string, string, number][] = [];
  if (!plan) {
    const presetId = input.preset ?? presetFromText(requestText);
    const generated = presetId ? generatedPlan(presetId, facts) : null;
    const preset = generated ?? (presetId ? deps.presetPlans[presetId] : undefined);
    if (!preset) throw new AgentFailure('The planner is offline and this request has no built-in plan. Try "tidy up", or a preset tile.');
    plan = { summary: preset.summary, rules: preset.rules, remember: preset.remember };
    closePairs = generated?.closePairs ?? [];
    usedPreset = true;
    if (input.preset !== 'tidy_room') say('plan', `Planner offline: using the built-in plan for '${preset.text}'.`, 'warn');
    else say('plan', `Tidying: ${preset.text}.`);
  }
  let errors = validatePlan(plan, facts, { trusted: usedPreset });
  if (errors.length && !usedPreset) {
    say('retry', `Plan needed fixes: ${errors.join('; ')}`, 'warn');
    const retry = await deps.plan(facts, { plan, errors });
    if (!retry) throw new AgentFailure(`The plan had problems and the planner is offline: ${errors.join('; ')}`);
    plan = retry;
    errors = validatePlan(plan, facts);
  }
  if (errors.length) {
    say('retry', `Second plan still invalid: ${errors.join('; ')}`, 'warn');
    throw new AgentFailure(`I couldn't turn that into a valid plan: ${errors.join('; ')}`);
  }
  say('plan', `Plan: ${describePlan(plan)}`);

  // 4–5. Solving and checking, with repair loops
  const objects = solverObjects(facts, geo, input.state);
  let walkway = WALKWAY_CM;
  let doorGrow = 0;
  let extraRules: SolverRequest['rules'] = [];
  const relaxed: string[] = [];
  let response: SolverResponse | null = null;
  let report: FitReport | null = null;
  let placements: PlacementV1[] = [];
  let relaxations = 0;
  let narrowed = 0;
  const movableCount = objects.filter((o) => o.movable).length;
  const timeLimit = movableCount > CROWDED ? TIME_LIMIT_BUSY_MS : TIME_LIMIT_MS;
  // A full room: the plan's walkway wish (keep_clear walkway) is honoured until it can't be.
  const askedWalkway = Math.max(walkway, ...plan.rules.filter((r) => r.type === 'keep_clear' && r.zone === 'walkway').map((r) => r.marginCm ?? 0));
  walkway = askedWalkway;
  plan.rules = plan.rules.filter((r) => !(r.type === 'keep_clear' && r.zone === 'walkway'));
  if (movableCount > CROWDED && walkway > 60) {
    walkway = 60;
    narrowed++;
    say('decision', `${movableCount} pieces in this room: planning with 60 cm walkways rather than ${askedWalkway} cm.`, 'warn');
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    deps.status('solving', round === 1 ? 'Solving…' : `Solving again (round ${round})…`);
    const rules = [...resolvePlan(plan, facts, geo, walkway), ...hardRules(facts, input.preferences), ...extraRules];
    const request = buildSolverRequest(geo, objects, rules, { walkwayCm: walkway, timeLimitMs: timeLimit, doorKeepOutGrowCm: doorGrow, closePairs });
    try {
      response = await deps.solve(request);
    } catch (err) {
      say('solve', `The layout solver isn't reachable right now (${(err as Error).message}).`, 'warn');
      throw new AgentFailure("The layout solver isn't reachable right now.");
    }

    if (response.status === 'INFEASIBLE') {
      const conflicts = response.conflicts.filter((id) => plan!.rules.some((r) => r.id === id && r.priority === 'must'));
      if (!conflicts.length && walkway - WALKWAY_STEP_CM >= WALKWAY_MIN_CM) {
        // Nothing to relax but the room itself: try with narrower walkways.
        walkway -= WALKWAY_STEP_CM;
        narrowed++;
        say('retry', `The room is tight: ${objects.filter((o) => o.movable).length} pieces don't fit with ${walkway + WALKWAY_STEP_CM} cm walkways. Trying ${walkway} cm.`, 'warn');
        round--;
        continue;
      }
      if (!conflicts.length || relaxations >= MAX_RELAXATIONS) {
        const names = response.conflicts.map((id) => plan!.rules.find((r) => r.id === id)?.why ?? id);
        throw new AgentFailure(names.length
          ? `No arrangement satisfies these together: ${names.join('; ')}. Drop one and ask again.`
          : `The room is too full: ${objects.filter((o) => o.movable).length} pieces can't all fit with even ${walkway} cm walkways. Remove a few and ask again.`);
      }
      // Relax the least important clashing must (latest in the plan's order).
      const victim = plan.rules.filter((r) => conflicts.includes(r.id)).pop()!;
      victim.priority = 'should';
      victim.weight = 8;
      relaxed.push(victim.id);
      relaxations++;
      say('retry', `Couldn't satisfy every must: relaxing "${victim.why ?? victim.id}" to a strong wish and solving again.`, 'warn');
      round--; // relaxations don't count as fit rounds
      continue;
    }
    if (response.status === 'TIMEOUT') {
      if (walkway - WALKWAY_STEP_CM >= WALKWAY_MIN_CM) {
        walkway -= WALKWAY_STEP_CM;
        narrowed++;
        say('retry', `No layout found in ${Math.round(timeLimit / 1000)} s with ${walkway + WALKWAY_STEP_CM} cm walkways: trying ${walkway} cm.`, 'warn');
        round--;
        continue;
      }
      throw new AgentFailure("Couldn't find a layout in time. Remove a few pieces and ask again.");
    }
    say('solve', `OR-Tools: ${response.status} in ${response.solveMs} ms; moved ${(response.movedCm / 100).toFixed(1)} m in total; ${response.satisfied.length} rule${response.satisfied.length === 1 ? '' : 's'} satisfied${response.violated.length ? `, ${response.violated.length} relaxed` : ''}.`);

    placements = convertBack(input.state.placements, objects, response, geo);
    deps.status('checking', 'Checking fit…');
    const bboxes = Object.fromEntries(Object.entries(input.state.objects).map(([id, o]) => [id, o.bboxMeters]));
    try {
      report = await deps.fit(input.state.room, placements, bboxes);
    } catch (err) {
      say('fit', `Fit check unavailable (${(err as Error).message}); proposing without it.`, 'warn');
      report = null;
      break;
    }
    const red = report.violations.filter((v) => v.severity === 'block');
    const amber = report.violations.filter((v) => v.severity === 'warn');
    say('fit', `Fit check: ${red.length} red, ${amber.length} amber${red.length ? ` — ${red.map((v) => v.message).join('; ')}` : ''}.`, red.length ? 'warn' : 'info');
    if (!red.length) break;
    if (round === MAX_ROUNDS) {
      say('decision', `Still ${red.length} red issue${red.length === 1 ? '' : 's'} after ${MAX_ROUNDS} rounds: proposing anyway, marked red.`, 'warn');
      break;
    }
    // Strengthen and re-solve.
    for (const v of red) {
      // Both door checks are about the zone in front of the door: make it deeper and re-solve.
      if (v.kind === 'door_swing') doorGrow += 30;
      else if (v.kind === 'clearance') doorGrow += 15;
      else {
        const p = placements.find((x) => x.placementId === v.placementId);
        const oid = p ? objects.find((o) => o.id === p.objectId) : undefined;
        if (oid) extraRules.push({ id: `fix:${v.kind}:${oid.id}`, type: 'far_from', a: oid.id, b: { point: [oid.xCm, oid.zCm] }, minCm: 40, priority: 'should', weight: 6 });
      }
    }
    say('retry', `Strengthening: ${red.map((v) => v.kind === 'door_swing' || v.kind === 'clearance' ? `door zone +${doorGrow} cm` : `keep clear around ${v.placementId}`).join(', ')}.`);
  }

  // 6. Explaining
  const moves = placements
    .map((to) => ({ to, from: input.state.placements.find((p) => p.placementId === to.placementId)! }))
    .filter(({ from, to }) => from && from !== to)
    .map(({ from, to }) => ({ objectId: to.objectId, from, to }));
  const violatedIds = new Set(response!.violated.map((v) => v.ruleId));
  const unsatisfied = [
    ...plan.rules.filter((r) => violatedIds.has(r.id) || relaxed.includes(r.id)).map((r) => ({ ruleId: r.id, why: r.why ?? r.id })),
    ...[...violatedIds].filter((id) => id.startsWith('pref:')).map((id) => ({ ruleId: id, why: input.preferences.find((p) => `pref:${p.id}` === id)?.text ?? 'a remembered preference' })),
  ];
  if (unsatisfied.some((u) => u.ruleId.startsWith('pref:'))) say('memory', `Couldn't keep every remembered preference this time: ${unsatisfied.filter((u) => u.ruleId.startsWith('pref:')).map((u) => u.why).join('; ')}.`, 'warn');
  if (narrowed) unsatisfied.push({ ruleId: 'walkway', why: `walkways narrowed to ${walkway} cm to fit everything (asked for ${askedWalkway} cm)` });
  const factsText = explanationFacts(requestText, plan, moves, input.state, objects, response!, report, relaxed, cleaned.log);
  let explanation: string;
  let tradeoffs: string[];
  try {
    if (!deps.explain) throw new Error('no explainer');
    ({ explanation, tradeoffs } = await deps.explain(factsText));
  } catch {
    ({ explanation, tradeoffs } = templateExplanation(moves, input.state, objects, geo, unsatisfied, report));
  }

  // 7. Proposing
  const fitSummary = { red: report?.violations.filter((v) => v.severity === 'block').length ?? 0, amber: report?.violations.filter((v) => v.severity === 'warn').length ?? 0 };
  say('decision', moves.length ? `Proposing: ${moves.map((m) => `${input.state.objects[m.objectId]?.name ?? m.objectId} → ${describeMove(m, objects, geo)}`).join('; ')}.` : 'Proposing: nothing needs to move.');
  deps.status('proposed', 'Proposal ready.');
  return {
    requestId: input.requestId,
    versionId: deps.mintVersionId(),
    baseVersionId: input.baseVersionId,
    summary: plan.summary,
    explanation,
    tradeoffs,
    moves,
    placements,
    fit: fitSummary,
    unsatisfied,
  };
}

type Kind = 'sofa' | 'coffee' | 'table' | 'desk' | 'chair' | 'storage' | 'tv' | 'bed' | 'accent' | 'rug' | 'other';

const KINDS: [RegExp, Kind][] = [
  [/sofa|couch|loveseat|settee/, 'sofa'],
  [/coffee|side table|end table|ottoman|footstool/, 'coffee'],
  [/desk/, 'desk'],
  [/dining|table/, 'table'],
  [/chair|stool|bench|seat/, 'chair'],
  [/storage|shelf|shelves|bookcase|cabinet|dresser|wardrobe|drawer|sideboard|console/, 'storage'],
  [/\btv\b|television|screen|monitor/, 'tv'],
  [/\bbed\b|mattress/, 'bed'],
  [/lamp|plant|vase|tree|light/, 'accent'],
  [/rug|carpet|mat/, 'rug'],
];

export function kindOf(category: string): Kind {
  const c = category.toLowerCase();
  return KINDS.find(([re]) => re.test(c))?.[1] ?? 'other';
}

export interface GeneratedPlan extends Plan {
  text: string;
  closePairs: [string, string, number][];
}

/**
 * A rearranged room the way people actually live in it: furniture in groups, walkways
 * between the groups, big pieces on the walls, nothing in front of a window or door.
 * Written per object from what's really in the room, so every piece gets a rule, and all
 * of them are strong wishes rather than musts, so a crowded room still solves and the
 * trade-offs get reported. The 90 cm walkway is the one hard rule.
 *
 *   sofa, TV, storage, bed, desk  → back against a wall, facing in (TV faces the sofa)
 *   dining table                  → toward the middle; its chairs pulled up to it, facing it
 *   coffee table                  → in front of the sofa; chairs around them, facing the room
 *   lamps, plants, unknown things → against a wall, out of the way
 */
export function generatedPlan(preset: string, facts: RoomFacts): GeneratedPlan | null {
  if (preset !== 'tidy_room') return null;
  const rules: Rule[] = [];
  const closePairs: [string, string, number][] = [];
  let n = 0;
  const add = (rule: Omit<Rule, 'id'>) => rules.push({ id: `t${++n}`, ...rule } as Rule);
  const should = (weight: number) => ({ priority: 'should' as const, weight });

  const movable = facts.objects.filter((o) => o.movable);
  const kinds = new Map(movable.map((o) => [o.id, kindOf(o.category)]));
  const first = (k: Kind) => movable.find((o) => kinds.get(o.id) === k);
  const sofa = first('sofa');
  const table = first('table');
  const tv = first('tv');
  const coffee = first('coffee');
  const window = facts.room.windows[0];
  const door = facts.room.doors[0];
  const chairs = movable.filter((o) => kinds.get(o.id) === 'chair');
  const seatingGroup = [sofa, coffee, ...(table ? [] : chairs)].filter(Boolean) as RoomFacts['objects'];

  for (const o of movable) {
    const name = o.category;
    switch (kinds.get(o.id)) {
      case 'sofa':
        add({ type: 'against_wall', a: o.id, wall: 'any', ...should(8), why: `${name} against a wall, facing the room` });
        if (tv) add({ type: 'facing', a: o.id, target: tv.id, ...should(4), why: `${name} faces the TV` });
        break;
      case 'tv':
        add({ type: 'against_wall', a: o.id, wall: 'any', ...should(8), why: `${name} against a wall` });
        if (sofa) add({ type: 'facing', a: o.id, target: sofa.id, ...should(4), why: `${name} faces the sofa` });
        break;
      case 'coffee':
        if (sofa) {
          add({ type: 'near', a: o.id, b: sofa.id, maxCm: 110, ...should(6), why: `${name} in front of the sofa` });
          closePairs.push([o.id, sofa.id, 30]);
        } else add({ type: 'near', a: o.id, b: 'center', maxCm: 120, ...should(4), why: `${name} toward the middle` });
        break;
      case 'table':
        add({ type: 'near', a: o.id, b: 'center', maxCm: 120, ...should(6), why: `${name} in the middle of the room` });
        break;
      case 'chair':
        if (table) {
          add({ type: 'near', a: o.id, b: table.id, maxCm: 90, ...should(6), why: `${name} at the table` });
          add({ type: 'facing', a: o.id, target: table.id, ...should(4), why: `${name} faces the table` });
          closePairs.push([o.id, table.id, 5]);
        } else if (sofa) {
          add({ type: 'near', a: o.id, b: coffee?.id ?? sofa.id, maxCm: 150, ...should(5), why: `${name} with the sofa` });
          add({ type: 'facing', a: o.id, target: 'center', ...should(3), why: `${name} faces the room` });
          for (const g of seatingGroup) if (g.id !== o.id) closePairs.push([o.id, g.id, 20]);
        } else add({ type: 'against_wall', a: o.id, wall: 'any', ...should(5), why: `${name} against a wall` });
        for (const other of chairs) if (other.id !== o.id) closePairs.push([o.id, other.id, 10]);
        break;
      case 'desk':
        add({ type: 'against_wall', a: o.id, wall: 'any', ...should(7), why: `${name} against a wall` });
        if (window) add({ type: 'near', a: o.id, b: `window:${window.id}`, maxCm: 160, ...should(3), why: `${name} near daylight` });
        break;
      case 'bed':
        add({ type: 'against_wall', a: o.id, wall: 'any', ...should(8), why: `${name} headboard on a wall` });
        if (door) add({ type: 'far_from', a: o.id, b: `door:${door.id}`, minCm: 150, ...should(4), why: `${name} away from the door` });
        break;
      case 'storage':
        add({ type: 'against_wall', a: o.id, wall: 'any', ...should(8), why: `${name} against a wall` });
        break;
      case 'rug':
        add({ type: 'near', a: o.id, b: sofa?.id ?? 'center', maxCm: 100, ...should(5), why: `${name} in the seating area` });
        for (const g of movable) if (g.id !== o.id) closePairs.push([o.id, g.id, 0]);
        break;
      case 'accent':
        add({ type: 'against_wall', a: o.id, wall: 'any', ...should(5), why: `${name} against a wall, out of the way` });
        break;
      default:
        add({ type: 'against_wall', a: o.id, wall: 'any', ...should(4), why: `${name} out of the way, against a wall` });
    }
  }
  for (const w of facts.room.windows) add({ type: 'keep_clear', zone: `window:${w.id}`, marginCm: 50, ...should(3), why: `nothing in front of the window ${w.id}` });
  add({ type: 'keep_clear', zone: 'walkway', marginCm: 90, priority: 'must', why: 'wide walkways between groups' });

  // Dedupe pairs; chairs at a table already have the table pair, so don't add a sofa one too.
  const seen = new Set<string>();
  const pairs = closePairs.filter(([a, b]) => {
    const key = [a, b].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const summary = 'Rearrange the room';
  return { text: `${movable.length} pieces in groups: big pieces to the walls, tables and chairs together, 90 cm walkways`, summary, rules, remember: [], closePairs: pairs };
}

/** Typed requests that clearly mean a preset, for when the planner is offline. */
export function presetFromText(text: string): string | null {
  const t = text.toLowerCase();
  if (/tidy|clean|organi[sz]e|messy|neat/.test(t)) return 'tidy_room';
  if (/reading|read/.test(t)) return 'reading_corner';
  if (/open .*floor|space|room to move/.test(t)) return 'open_floor';
  if (/door/.test(t)) return 'clear_door';
  if (/window|view/.test(t)) return 'face_window';
  return null;
}

export function convertBack(original: PlacementV1[], objects: SolverRequest['objects'], response: SolverResponse, geo: RoomGeometry): PlacementV1[] {
  return original.map((p) => {
    const input = objects.find((o) => o.id === p.objectId);
    const output = response.placements.find((o) => o.id === p.objectId);
    if (!input || !output) return p;
    return solverToPlacement(p, input, output, geo);
  });
}

function describePlan(plan: Plan): string {
  return plan.rules.map((r) => `${describeRule(r)} (${r.priority}${r.priority === 'should' ? `, ${r.weight}` : ''})`).join('; ');
}

function describeRule(r: Rule): string {
  switch (r.type) {
    case 'pin': return `${r.a} stays`;
    case 'against_wall': return `${r.a} against ${r.wall && r.wall !== 'any' ? `the ${r.wall.replace('wall:', '')} wall` : 'a wall'}`;
    case 'near': return `${r.a} within ${r.maxCm} cm of ${r.b}`;
    case 'far_from': return `${r.a} at least ${r.minCm} cm from ${r.b}`;
    case 'facing': return `${r.a} faces ${r.target}`;
    case 'keep_clear': return `keep ${r.zone} clear${r.marginCm ? ` (${r.marginCm} cm)` : ''}`;
  }
}

function describeMove(m: Proposal['moves'][number], objects: SolverRequest['objects'], geo: RoomGeometry): string {
  const from = objects.find((o) => o.id === m.objectId);
  const [tx, tz] = [Math.round((m.to.p[0] + geo.offset[0]) * 100), Math.round((m.to.p[2] + geo.offset[2]) * 100)];
  const dx = from ? tx - from.xCm : 0;
  const dz = from ? tz - from.zCm : 0;
  const parts: string[] = [];
  if (Math.abs(dx) >= 5) parts.push(`${Math.abs(dx)} cm ${dx > 0 ? 'east' : 'west'}`);
  if (Math.abs(dz) >= 5) parts.push(`${Math.abs(dz)} cm ${dz > 0 ? 'south' : 'north'}`);
  const yaw = Math.round((((m.to.yawDeg - geo.thetaDeg) % 360) + 360) % 360 / 90) % 4;
  if (from && FACING[yaw] !== FACING[(from.rotDeg / 90) % 4]) parts.push(`facing ${FACING[yaw]}`);
  return parts.join(', ') || 'a nudge';
}

function explanationFacts(request: string, plan: Plan, moves: Proposal['moves'], state: RoomState, objects: SolverRequest['objects'], response: SolverResponse, report: FitReport | null, relaxed: string[], cleaning: LogEntry[]): string {
  const lines = [
    `Request: ${request}`,
    `Plan: ${describePlan(plan)}`,
    `Moves: ${moves.length ? moves.map((m) => `${state.objects[m.objectId]?.name ?? m.objectId} ${describeMoveText(m, objects)}`).join('; ') : 'none'}`,
    `Solver: ${response.status}, satisfied ${response.satisfied.join(', ') || 'none'}, violated ${response.violated.map((v) => v.ruleId).join(', ') || 'none'}, relaxed ${relaxed.join(', ') || 'none'}`,
    `Fit: ${report ? `${report.violations.filter((v) => v.severity === 'block').length} red, ${report.violations.filter((v) => v.severity === 'warn').length} amber${report.violations.length ? ` (${report.violations.map((v) => v.message).join('; ')})` : ''}` : 'not checked'}`,
    `Data decisions: ${cleaning.map((e) => e.message).join(' ') || 'none'}`,
  ];
  return lines.join('\n');
}

function describeMoveText(m: Proposal['moves'][number], objects: SolverRequest['objects']): string {
  const from = objects.find((o) => o.id === m.objectId);
  if (!from) return 'moved';
  const dist = Math.hypot(m.to.p[0] - m.from.p[0], m.to.p[2] - m.from.p[2]);
  return `moved ${dist.toFixed(1)} m${Math.abs(m.to.yawDeg - m.from.yawDeg) > 1 ? ' and turned' : ''}`;
}

function templateExplanation(moves: Proposal['moves'], state: RoomState, objects: SolverRequest['objects'], geo: RoomGeometry, unsatisfied: { ruleId: string; why: string }[], report: FitReport | null): { explanation: string; tradeoffs: string[] } {
  const names = (m: Proposal['moves'][number]) => state.objects[m.objectId]?.name ?? m.objectId;
  const explanation = moves.length
    ? `Moved ${moves.map((m) => `the ${names(m)} ${describeMove(m, objects, geo)}`).join(' and ')}.`
    : 'Everything already satisfies the request; nothing needs to move.';
  const tradeoffs = [
    ...unsatisfied.map((u) => `Couldn't fully keep: ${u.why}.`),
    ...(report?.violations.filter((v) => v.severity === 'warn').map((v) => `Note: ${v.message}.`) ?? []),
  ];
  return { explanation, tradeoffs };
}
