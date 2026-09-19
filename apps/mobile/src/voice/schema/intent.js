// Intent schema for the voice assistant. See ../TOOLS.md for the design.
//
// Pass 1 (understand) emits one of these. The resolver binds its refs to real ids and
// coordinates; the model never emits geometry itself (CLAUDE.md standing rule 3).
//
// Metres everywhere (standing rule 1). Every validation failure raises (standing rule 4) —
// nothing here substitutes a default, even a correct-looking one.

export const INTENT_SCHEMA_VERSION = 1;

export const ACTIONS = [
  'measure_and_fit',  // "what is this, will it fit beside my desk?"  — the marquee beat
  'find_object',      // "find something for that gap that matches the wood tone"
  'place_object',     // "put it there"
  'check_placement',  // "will that block the door?"
  'describe',         // "what am I looking at?"  — vision only, no numbers permitted
  'clarify',          // ambiguous reference; ask one question, keep the turn open
  'unsupported',      // out of scope; decline in one sentence
];

export const TARGET_KINDS = ['in_view', 'object', 'description'];
export const ANCHOR_KINDS = ['none', 'named', 'in_view_region', 'room_object'];

// Keys that must never appear inside a ref. If the model emits one it has skipped the
// resolver and invented geometry, which is the one failure this schema exists to catch.
const FORBIDDEN_REF_KEYS = [
  'p', 'position', 'transform', 'yawDeg', 'rotation',
  'w', 'h', 'd', 'width', 'height', 'depth',
  'meters', 'metres', 'cm', 'distance', 'span',
];

class IntentError extends Error {}

function fail(msg) {
  throw new IntentError(`intent: ${msg}`);
}

function assertNoGeometry(ref, where) {
  for (const key of FORBIDDEN_REF_KEYS) {
    if (key in ref) {
      fail(`${where} carries geometry key "${key}". The model describes; the resolver measures.`);
    }
  }
}

function validateTarget(target) {
  if (!target || typeof target !== 'object') fail('target is required');
  if (!TARGET_KINDS.includes(target.kind)) {
    fail(`target.kind must be one of ${TARGET_KINDS.join(', ')}, got ${target.kind}`);
  }
  assertNoGeometry(target, 'target');

  // `in_view` needs nothing — the camera and measure_object_in_view supply everything.
  if (target.kind === 'object' && !target.objectId) fail('target.kind "object" needs objectId');
  if (target.kind === 'description' && !target.text) fail('target.kind "description" needs text');
}

function validateAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') fail('anchor is required (use kind "none")');
  if (!ANCHOR_KINDS.includes(anchor.kind)) {
    fail(`anchor.kind must be one of ${ANCHOR_KINDS.join(', ')}, got ${anchor.kind}`);
  }
  assertNoGeometry(anchor, 'anchor');

  if (anchor.kind === 'named' && !anchor.text) fail('anchor.kind "named" needs text');
  if (anchor.kind === 'in_view_region' && !anchor.text) fail('anchor.kind "in_view_region" needs text');
  if (anchor.kind === 'room_object' && !anchor.category) fail('anchor.kind "room_object" needs category');
}

/**
 * Validate a pass-1 intent. Returns the intent unchanged, or raises IntentError.
 *
 * Shape:
 *   {
 *     schemaVersion: 1,
 *     action: "measure_and_fit",
 *     ack: "let me measure that",           // spoken immediately, covers tool latency
 *     target: { kind: "in_view" },
 *     anchor: { kind: "named", text: "beside my desk" },
 *     attributes: { palette: ["oak"], category: "bookshelf" },   // optional, for search
 *     budgetCents: 120000,                                        // optional
 *     question: "which corner did you mean?"                      // clarify only
 *   }
 */
export function validateIntent(raw) {
  if (!raw || typeof raw !== 'object') fail('not an object');
  if (raw.schemaVersion !== INTENT_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${INTENT_SCHEMA_VERSION}, got ${raw.schemaVersion}`);
  }
  if (!ACTIONS.includes(raw.action)) fail(`unknown action "${raw.action}"`);
  if (typeof raw.ack !== 'string' || !raw.ack) fail('ack is required — it covers tool latency');

  if (raw.action === 'clarify') {
    if (!raw.question) fail('action "clarify" needs a question');
    return raw;
  }
  if (raw.action === 'unsupported') return raw;

  validateTarget(raw.target);

  // `describe` is the one action with no spatial component at all.
  if (raw.action === 'describe') {
    if (raw.anchor && raw.anchor.kind !== 'none') {
      fail('action "describe" must not carry an anchor — it is vision only');
    }
    return raw;
  }

  validateAnchor(raw.anchor);
  return raw;
}

// ---------------------------------------------------------------------------
// Grounding assertion
// ---------------------------------------------------------------------------

// Pull every number out of a tool-result tree, in metres, plus its cm equivalent.
function groundedNumbers(toolResults) {
  const out = new Set();
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'number') {
      out.add(round(node));            // metres, as stored
      out.add(round(node * 100));      // centimetres, as spoken
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') return Object.values(node).forEach(walk);
  };
  walk(toolResults);
  return out;
}

function round(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Verify that every numeral in pass 2's spoken text came out of a tool call.
 *
 * ceiling: matches digits with a 0.1 rounding tolerance and cm/m awareness. Spelled-out
 * numbers ("thirty centimetres") are not caught. Upgrade path is a number-word pass over
 * the text before matching.
 */
export function assertGrounded(spokenText, toolResults, { strict = true } = {}) {
  const allowed = groundedNumbers(toolResults);
  const spoken = (spokenText.match(/\d+(?:\.\d+)?/g) || []).map((s) => round(parseFloat(s)));

  const ungrounded = spoken.filter((n) => {
    for (const a of allowed) if (Math.abs(a - n) <= 0.1) return false;
    return true;
  });

  if (ungrounded.length === 0) return true;

  const msg =
    `ungrounded numbers in spoken output: ${ungrounded.join(', ')}. ` +
    `Every number the agent speaks must come from a tool call.`;
  if (strict) throw new IntentError(msg);
  console.warn(`[voice] ${msg}`);
  return false;
}

export { IntentError };
