// Tool dispatch. Every tool maps to an endpoint in .claude/contracts.md; nothing here
// invents a route.
//
// The important design call: THE ACTION DETERMINES THE PIPELINE, not the model. Each action
// in schema/intent.js has one fixed sequence of tool calls. The model chooses the action and
// describes the references; it never chooses which tools run or in what order. That removes a
// whole class of demo failure (the model calling check_fit before anything is measured) and
// makes every turn reproducible in a test.

import { findAnchors } from './anchors.js';
import { TOOLS_BY_ACTION } from '../schema/tools.js';

// Which documented tool each API method stands for, so TOOLS_BY_ACTION can be enforced rather
// than merely written down.
const METHOD_TO_TOOL = {
  getObject: 'measure_object_in_view',
  createObject: 'measure_object_in_view',
  getRoom: 'find_anchor',
  fit: 'check_fit',
  search: 'search_objects',
  createVersion: 'place_object',
  push: 'place_object',
  generate: 'start_generation',
};

/** Wrap an api so a pipeline can only call what its action declared (standing rule 4). */
export function guardApi(api, action) {
  const allowed = TOOLS_BY_ACTION[action];
  if (!allowed) throw new Error(`tools: no tool set declared for action "${action}"`);
  const guarded = {};
  for (const key of Object.keys(api)) {
    const value = api[key];
    if (typeof value !== 'function') {
      guarded[key] = value;
      continue;
    }
    guarded[key] = (...args) => {
      const tool = METHOD_TO_TOOL[key];
      if (tool && !allowed.includes(tool)) {
        throw new Error(
          `tools: action "${action}" may not call ${tool} (api.${key}). ` +
          `Declared: ${allowed.join(', ') || 'none'}.`,
        );
      }
      return value(...args);
    };
  }
  return guarded;
}

export function createApi({ baseUrl, stub = false, fetchImpl = globalThis.fetch }) {
  if (!baseUrl) throw new Error('api: baseUrl is required'); // standing rule 4

  async function call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (stub) headers['X-Stub'] = '1';
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`api: ${method} ${path} -> ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  return {
    getRoom: (roomId) => call('GET', `/v1/rooms/${roomId}`),
    getObject: (objectId) => call('GET', `/v1/objects/${objectId}`),
    createObject: (body) => call('POST', '/v1/objects', body),
    fit: (body) => call('POST', '/v1/fit', body),
    search: (body) => call('POST', '/v1/search', body),
    createVersion: (roomId, body) => call('POST', `/v1/rooms/${roomId}/versions`, body),
    push: (roomId, body) => call('POST', `/v1/push/${roomId}`, body),
    generate: (objectId, body) => call('POST', `/v1/objects/${objectId}/generate`, body),
  };
}

// Resolve intent.target to a concrete objectId, measuring if the target is what's in view.
async function resolveTarget(intent, { api, capture }) {
  const t = intent.target;
  if (t.kind === 'object') return api.getObject(t.objectId);

  if (t.kind === 'in_view') {
    // The grounding primitive: the depth sensor supplies the size, the model supplied the name.
    if (!capture) throw new Error('tools: target is in_view but no capture source is wired');
    const measured = await capture.measureInView();
    return api.createObject({
      source: 'scan',
      name: measured.name ?? intent.attributes?.category ?? 'object',
      category: measured.category ?? intent.attributes?.category ?? 'unknown',
      bboxMeters: measured.bboxMeters,
      measure: measured.measure,
      frameKeys: measured.frameKeys ?? [],
    });
  }

  // kind === 'description' — find it rather than measure it.
  const hits = await api.search({ text: t.text, limit: 1 });
  if (!hits?.length) return null;
  return hits[0].object;
}

async function resolveAnchor(intent, { api, roomId }) {
  const a = intent.anchor;
  if (!a || a.kind === 'none') return { candidates: [] };
  const room = await api.getRoom(roomId);
  const candidates = findAnchors(room, {
    description: a.text,
    category: a.kind === 'room_object' ? a.category : undefined,
  });
  return { candidates };
}

/**
 * Run the fixed pipeline for an intent. Returns a results object that pass 2 speaks from —
 * and that assertGrounded() checks every spoken number against.
 */
export async function runPipeline(intent, rawCtx) {
  const results = { action: intent.action };

  if (intent.action === 'describe' || intent.action === 'clarify' || intent.action === 'unsupported') {
    return results; // no tools; nothing to ground against, so pass 2 must speak no numbers
  }

  // Everything below calls through the guard, never the bare api.
  const ctx = { ...rawCtx, api: guardApi(rawCtx.api, intent.action) };
  const { api, roomId } = ctx;

  const object = await resolveTarget(intent, ctx);
  if (!object) {
    results.notFound = true;
    return results;
  }
  results.object = object;

  // Fire-and-forget: the mesh is not needed to answer, only to render later.
  if (intent.action === 'measure_and_fit' && object.state === 'measured') {
    api.generate(object.objectId, { tier: 'live' }).catch(() => {});
  }

  const { candidates } = await resolveAnchor(intent, ctx);
  if (candidates.length === 0) {
    results.anchorNotFound = true;
    return results;
  }
  // More than one plausible place is a question, not a coin flip (standing rule 4). The agent
  // asks; it does not pick.
  const tied = candidates.filter(
    (c) => candidates[0].freeSpanMeters - c.freeSpanMeters < 0.1,
  );
  if (tied.length > 1) {
    results.anchorAmbiguous = tied.slice(0, 2);
    return results;
  }
  const anchor = candidates[0];
  results.anchor = anchor;

  if (intent.action === 'find_object') {
    // The half of the query Kreativ cannot express: style is text, fit is a range filter.
    const fit = { maxW: anchor.freeSpanMeters, maxD: anchor.depthMeters };
    results.search = await api.search({
      text: intent.target.text ?? intent.attributes?.category,
      fit,
      limit: 5,
    });
    results.fitFilter = fit;
    return results;
  }

  // measure_and_fit, check_placement, place_object all validate before anything else.
  results.fitReport = await api.fit({
    roomId,
    placements: [{
      placementId: `pending:${object.objectId}`,
      objectId: object.objectId,
      p: anchor.p,
      yawDeg: 0,
      scale: 1.0,
      flags: [],
    }],
  });

  // Never place something that blocks. The product exists to catch exactly this, so placing
  // it anyway and mentioning it afterwards would be the one unforgivable behaviour. Report,
  // and let the user insist if they want to.
  const blocking = (results.fitReport?.violations || []).filter((v) => v.severity === 'block');
  if (intent.action === 'place_object' && blocking.length > 0) {
    results.blocked = blocking;
    results.placed = false;
    return results;
  }

  if (intent.action === 'place_object') {
    const version = await api.createVersion(roomId, {
      label: intent.anchor?.text ?? 'voice placement',
      placements: [{
        placementId: `v:${object.objectId}`,
        objectId: object.objectId,
        p: anchor.p,
        yawDeg: 0,
        scale: 1.0,
        flags: [],
      }],
      materials: {},
    });
    results.version = version;
    await api.push(roomId, { versionId: version.versionId });
    results.pushed = true;
    results.placed = true;
  }

  return results;
}
