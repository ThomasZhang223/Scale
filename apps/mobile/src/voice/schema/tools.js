// Tool definitions for the OMNI voice loop. See ../TOOLS.md for the design.
//
// JSON-Schema shaped, so these drop straight into a native function-calling API. If the
// reseller does not support function calling, pass 1 emits an `intent` (schema/intent.js)
// instead and these become the dispatch table behind it. One schema, two transports.
//
// Every tool maps onto an endpoint already in .claude/contracts.md except find_anchor v1,
// which is marked NEEDS JUSTIN. Metres everywhere (standing rule 1).

export const TOOLS = [
  {
    name: 'measure_object_in_view',
    // phone LiDAR -> POST /objects  { source:"scan", name, category, bboxMeters, measure, frameKeys[] }
    description:
      'Measure the physical object currently in the camera view using the depth sensor. ' +
      'Returns its true bounding box in metres. Call this before making any claim about ' +
      'size. You supply the name and category from what you see; the sensor supplies the ' +
      'dimensions. Returns in under one second, before any 3D mesh exists.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What you see, e.g. "MacBook Pro 14"' },
        category: { type: 'string', description: 'e.g. laptop, chair, bookshelf' },
      },
      required: ['name', 'category'],
    },
  },

  {
    name: 'find_anchor',
    // v0: client-side over RoomCapture v1.objects. v1: POST /gaps — NEEDS JUSTIN.
    description:
      'Turn a spoken description of a place in the room ("beside my desk", "that corner", ' +
      '"against the far wall") into a real anchor with a measured free span. Returns one or ' +
      'more candidates. If more than one comes back, ask the user which they meant rather ' +
      'than guessing.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'The phrase the user actually said' },
        category: {
          type: 'string',
          description: 'Room object the phrase is relative to, if any, e.g. desk, bed, door',
        },
      },
      required: ['description'],
    },
  },

  {
    name: 'check_fit',
    // POST /fit  { roomId, placements } -> FitReport v1.  A dry run: writes nothing.
    description:
      'Check whether an object fits at an anchor. Validates clearance corridors, door swing ' +
      'arcs, window occlusion and wall adjacency, and returns any violations with a measured ' +
      'amount in metres. This is a dry run — it does not place anything. This tool is the ' +
      'only source of truth about whether something fits; never answer that question yourself.',
    input_schema: {
      type: 'object',
      properties: {
        objectId: { type: 'string' },
        anchorId: { type: 'string', description: 'From find_anchor' },
      },
      required: ['objectId', 'anchorId'],
    },
  },

  {
    name: 'search_objects',
    // POST /search  { text?, imageKey?, fit?, source?, limit }
    description:
      'Search the catalog and the user\'s own scanned possessions. Style matching is a ' +
      'description; fit is a hard dimensional filter in metres. Pass a fit filter whenever ' +
      'the user mentions a space, so results actually fit rather than merely looking right. ' +
      'If nothing matches, the filter is relaxed by 10% and results come back labelled ' +
      '"relaxed" — say so when that happens.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Style description, e.g. "narrow oak bookshelf"' },
        fit: {
          type: 'object',
          description: 'Maximum dimensions in METRES. Take these from find_anchor, never guess.',
          properties: {
            maxW: { type: 'number' },
            maxH: { type: 'number' },
            maxD: { type: 'number' },
          },
        },
        source: { type: 'string', enum: ['scan', 'catalog', 'primitive'] },
        limit: { type: 'integer' },
      },
      required: [],
    },
  },

  {
    name: 'place_object',
    // POST /rooms/{id}/versions  then  POST /push/{roomId}
    description:
      'Place an object at an anchor in the room and push the result to the headset. Writes a ' +
      'new version, so it is undoable. Call check_fit first and tell the user if it reports a ' +
      'blocking violation before you place it anyway.',
    input_schema: {
      type: 'object',
      properties: {
        objectId: { type: 'string' },
        anchorId: { type: 'string' },
      },
      required: ['objectId', 'anchorId'],
    },
  },

  {
    name: 'start_generation',
    // POST /objects/{id}/generate { tier } -> { jobId };  GET /jobs/{id} for progress
    description:
      'Start building the 3D mesh for a measured object. Returns a job id. Generation takes ' +
      'roughly 10 to 15 seconds, so keep talking to the user about what you measured while it ' +
      'runs. The measured dimensions are already known and true before this finishes.',
    input_schema: {
      type: 'object',
      properties: {
        objectId: { type: 'string' },
        tier: { type: 'string', enum: ['live', 'quality'] },
      },
      required: ['objectId'],
    },
  },

  {
    name: 'suggest_arrangement',
    // POST /solve { roomId, intent, budgetCents?, fixed[] }  — optional, H24, first to cut.
    description:
      'Ask the solver to arrange the room for a goal ("a cozy reading corner", "redo this ' +
      'under $1,200"). You supply the goal and the constraints; the solver supplies the ' +
      'positions. Never propose coordinates yourself. If it returns infeasible, it also ' +
      'returns why and what to relax — say both out loud.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'The goal in the user\'s own words' },
        budgetCents: { type: 'integer', description: 'Integer cents, never a float' },
        fixed: {
          type: 'array',
          items: { type: 'string' },
          description: 'objectIds the user said not to move',
        },
      },
      required: ['intent'],
    },
  },
];

// Tools available per intent action. The dispatcher uses this to narrow what pass 2 may call,
// which keeps a `describe` turn from wandering into measurement.
export const TOOLS_BY_ACTION = {
  measure_and_fit: ['measure_object_in_view', 'find_anchor', 'check_fit', 'start_generation'],
  find_object: ['find_anchor', 'search_objects'],
  place_object: ['find_anchor', 'check_fit', 'place_object'],
  check_placement: ['find_anchor', 'check_fit'],
  describe: [],
  clarify: [],
  unsupported: [],
};

export function toolsFor(action) {
  const names = TOOLS_BY_ACTION[action];
  // standing rule 4: fail loud rather than defaulting to the full tool set.
  if (!names) throw new Error(`tools: no tool set defined for action "${action}"`);
  return TOOLS.filter((t) => names.includes(t.name));
}
