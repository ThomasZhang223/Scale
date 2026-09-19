import type { Plan, RoomFacts, Rule, RuleType, Side, SolverRef, SolverRequest, SolverRule } from './types.ts';
import type { RoomGeometry } from './room.ts';
import { solverRoom } from './room.ts';

/*
 * The constraint plan: validate what the model wrote (precise errors it can fix), then
 * resolve names into what the solver understands. 08_PROTOCOL.md ③.
 */

const RULE_TYPES: RuleType[] = ['pin', 'against_wall', 'near', 'far_from', 'facing', 'keep_clear'];
const MAX_RULES = 8;
const MAX_MUST = 4;
const DIST_MIN = 20;
const DIST_MAX = 1000;

/** JSON schema for OpenAI structured outputs: the same shape, strict. */
export const PLAN_SCHEMA = {
  name: 'constraint_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'rules', 'remember'],
    properties: {
      summary: { type: 'string' },
      rules: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'type', 'a', 'b', 'target', 'wall', 'zone', 'maxCm', 'minCm', 'marginCm', 'priority', 'weight', 'why'],
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: RULE_TYPES },
            a: { type: ['string', 'null'] },
            b: { type: ['string', 'null'] },
            target: { type: ['string', 'null'] },
            wall: { type: ['string', 'null'] },
            zone: { type: ['string', 'null'] },
            maxCm: { type: ['integer', 'null'] },
            minCm: { type: ['integer', 'null'] },
            marginCm: { type: ['integer', 'null'] },
            priority: { type: 'string', enum: ['must', 'should'] },
            weight: { type: ['integer', 'null'] },
            why: { type: 'string' },
          },
        },
      },
      remember: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['text', 'ruleId'], properties: { text: { type: 'string' }, ruleId: { type: 'string' } } },
      },
    },
  },
};

export function validatePlan(plan: Plan, facts: RoomFacts, options: { trusted?: boolean } = {}): string[] {
  const errors: string[] = [];
  const objectIds = facts.objects.map((o) => o.id);
  const list = objectIds.join(', ');
  const features = new Set([
    'center',
    ...facts.room.doors.map((d) => `door:${d.id}`),
    ...facts.room.windows.map((w) => `window:${w.id}`),
    ...facts.room.walls.map((w) => `wall:${w.id}`),
  ]);
  const fixed = new Map(facts.objects.filter((o) => !o.movable).map((o) => [o.id, o.note ?? 'fixed']));
  const pinned = new Set(facts.pinned);

  if (!Array.isArray(plan.rules)) return ['rules must be a list'];
  // Generated preset plans have one rule per object and are trusted; the model's plans are capped.
  if (!options.trusted) {
    if (plan.rules.length > MAX_RULES) errors.push(`too many rules (${plan.rules.length}); keep the ${MAX_RULES} most important`);
    const musts = plan.rules.filter((r) => r.priority === 'must').length;
    if (musts > MAX_MUST) errors.push(`too many must rules (${musts}); keep the ${MAX_MUST} most important`);
  }

  for (const r of plan.rules) {
    const id = r.id || '?';
    if (!RULE_TYPES.includes(r.type)) {
      errors.push(`${id}.type: "${r.type}" is not a rule type; use ${RULE_TYPES.join(', ')}`);
      continue;
    }
    if (r.priority === 'should' && !(typeof r.weight === 'number' && r.weight >= 1 && r.weight <= 10)) {
      errors.push(`${id}.weight: a should rule needs a weight from 1 to 10`);
    }
    if (r.type !== 'keep_clear') {
      if (!r.a || !objectIds.includes(r.a)) {
        errors.push(`${id}.a: "${r.a}" is not in the room; objects are ${list}`);
      } else if (r.type !== 'pin' && fixed.has(r.a)) {
        errors.push(`${id}.a: ${r.a} is fixed (${fixed.get(r.a)})`);
      } else if (r.type !== 'pin' && pinned.has(r.a)) {
        errors.push(`${id}.a: ${r.a} is pinned by the person; leave it where it is`);
      }
    }
    if (r.type === 'near' || r.type === 'far_from') {
      if (!r.b) errors.push(`${id}.b is required`);
      else if (r.b === r.a) errors.push(`${id}: an object can't be ${r.type === 'near' ? 'near' : 'far from'} itself`);
      else if (!objectIds.includes(r.b) && !features.has(r.b)) errors.push(`${id}.b: "${r.b}" is not in the room; use an object id, door:{id}, window:{id} or center`);
      const key = r.type === 'near' ? 'maxCm' : 'minCm';
      const v = r[key];
      if (typeof v !== 'number') errors.push(`${id}.${key} is required`);
      else if (v < DIST_MIN) errors.push(`${id}.${key}: ${v} is below ${DIST_MIN}`);
      else if (v > DIST_MAX) errors.push(`${id}.${key}: ${v} is above ${DIST_MAX}`);
    }
    if (r.type === 'facing') {
      if (!r.target) errors.push(`${id}.target is required`);
      else if (r.target === r.a) errors.push(`${id}: an object can't face itself`);
      else if (!objectIds.includes(r.target) && !features.has(r.target)) errors.push(`${id}.target: "${r.target}" is not in the room`);
    }
    if (r.type === 'against_wall') {
      const w = r.wall ?? 'any';
      const ok = w === 'any' || ['north', 'south', 'east', 'west'].includes(w) || features.has(w);
      if (!ok) errors.push(`${id}.wall: "${w}" is not a wall; use wall:{id}, a side, or any`);
    }
    if (r.type === 'keep_clear') {
      const z = r.zone;
      if (!z || !(z === 'walkway' || features.has(z))) errors.push(`${id}.zone: "${z}" must be door:{id}, window:{id} or walkway`);
    }
  }
  return errors;
}

/** Resolve plan targets into solver refs. Assumes the plan validated. */
export function resolvePlan(plan: Plan, facts: RoomFacts, geo: RoomGeometry, walkwayCm: number): SolverRule[] {
  const room = solverRoom(geo);
  const b = geo.bounds;
  const ref = (name: string): SolverRef => {
    if (name === 'center') return { point: [0, 0] };
    if (name.startsWith('door:')) {
      const d = facts.room.doors.find((x) => x.id === name.slice(5))!;
      return { point: d.centerCm };
    }
    if (name.startsWith('window:')) {
      const w = facts.room.windows.find((x) => x.id === name.slice(7))!;
      return { point: w.centerCm };
    }
    return { object: name };
  };
  const side = (name: string | undefined): Side | 'any' => {
    if (!name || name === 'any') return 'any';
    if (name.startsWith('wall:')) return facts.room.walls.find((w) => w.id === name.slice(5))?.side ?? 'any';
    return name as Side;
  };
  const zone = (r: Rule): SolverRule['zone'] => {
    const margin = r.marginCm ?? walkwayCm;
    if (r.zone === 'walkway') return 'walkway';
    if (r.zone?.startsWith('window:')) {
      const w = room.windows.find((x) => x.id === r.zone!.slice(7))!;
      const half = Math.round(w.widthCm / 2);
      const rect =
        w.side === 'north' ? { minX: w.xCm - half, maxX: w.xCm + half, minZ: b.minZ, maxZ: b.minZ + margin }
        : w.side === 'south' ? { minX: w.xCm - half, maxX: w.xCm + half, minZ: b.maxZ - margin, maxZ: b.maxZ }
        : w.side === 'east' ? { minX: b.maxX - margin, maxX: b.maxX, minZ: w.zCm - half, maxZ: w.zCm + half }
        : { minX: b.minX, maxX: b.minX + margin, minZ: w.zCm - half, maxZ: w.zCm + half };
      return { rect };
    }
    if (r.zone?.startsWith('door:')) {
      const d = room.doors.find((x) => x.id === r.zone!.slice(5))!;
      const k = d.keepOut;
      return { rect: { minX: k.minX - margin, maxX: k.maxX + margin, minZ: Math.max(b.minZ, k.minZ - margin), maxZ: Math.min(b.maxZ, k.maxZ + margin) } };
    }
    return 'walkway';
  };

  return plan.rules.map((r) => {
    const out: SolverRule = { id: r.id, type: r.type, priority: r.priority };
    if (r.priority === 'should') out.weight = r.weight ?? 3;
    if (r.a) out.a = r.a;
    if (r.type === 'near') { out.b = ref(r.b!); out.maxCm = r.maxCm; }
    if (r.type === 'far_from') { out.b = ref(r.b!); out.minCm = r.minCm; }
    if (r.type === 'facing') out.target = ref(r.target!);
    if (r.type === 'against_wall') out.wall = side(r.wall);
    if (r.type === 'keep_clear') { out.zone = zone(r); out.marginCm = r.marginCm; }
    return out;
  });
}

/** The rules the model doesn't control: pins from the request, fixed objects, remembered preferences. */
export function hardRules(facts: RoomFacts, preferences: { id?: string; rule: Rule; weight?: number }[]): SolverRule[] {
  const rules: SolverRule[] = [];
  for (const id of facts.pinned) rules.push({ id: `pin:${id}`, type: 'pin', a: id, priority: 'must' });
  preferences.forEach((pref, n) => {
    const r = pref.rule;
    if (r.a && !facts.objects.some((o) => o.id === r.a)) return;
    const { why: _why, ...rest } = r;
    rules.push({ ...(rest as unknown as SolverRule), id: `pref:${pref.id ?? n}`, priority: 'should', weight: pref.weight ?? 3 });
  });
  return rules;
}

export function buildSolverRequest(
  geo: RoomGeometry,
  objects: SolverRequest['objects'],
  rules: SolverRule[],
  settings: { walkwayCm: number; timeLimitMs: number; doorKeepOutGrowCm?: number; closePairs?: [string, string, number][] },
): SolverRequest {
  const out: SolverRequest = { room: solverRoom(geo, settings.doorKeepOutGrowCm ?? 0), objects, rules, settings: { walkwayCm: settings.walkwayCm, timeLimitMs: settings.timeLimitMs } };
  if (settings.closePairs?.length) out.settings.closePairs = settings.closePairs;
  return out;
}
