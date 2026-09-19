// JSON Schema for pass 1's structured output, derived from schema/intent.js so the two can
// never drift. Passed as output_config.format — the model cannot return a wrong shape, and
// validateIntent() then re-checks the things a schema can't express.
//
// Note what is deliberately ABSENT: there is no field anywhere for a coordinate, a distance
// or a dimension. The model is not permitted to express one, so it cannot invent one.

import { ACTIONS, TARGET_KINDS, ANCHOR_KINDS, INTENT_SCHEMA_VERSION } from '../schema/intent.js';

export const INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'action', 'ack'],
  properties: {
    schemaVersion: { type: 'integer', enum: [INTENT_SCHEMA_VERSION] },
    action: { type: 'string', enum: ACTIONS },
    ack: {
      type: 'string',
      description: 'Spoken immediately, before any work. Under eight words. No numbers.',
    },
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: TARGET_KINDS },
        objectId: { type: 'string', description: 'Only when kind is "object"' },
        text: { type: 'string', description: 'Only when kind is "description"' },
      },
    },
    anchor: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ANCHOR_KINDS },
        text: { type: 'string', description: 'The phrase the user actually said' },
        category: { type: 'string', description: 'Only when kind is "room_object"' },
      },
    },
    attributes: {
      type: 'object',
      additionalProperties: false,
      description: 'Style hints for search. Never dimensions.',
      properties: {
        palette: { type: 'array', items: { type: 'string' } },
        category: { type: 'string' },
        material: { type: 'string' },
      },
    },
    budgetCents: { type: 'integer', description: 'Integer cents. Only if the user named a budget.' },
    question: { type: 'string', description: 'Only when action is "clarify"' },
  },
};
