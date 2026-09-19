// A fake /v1 backed by the committed fixtures, so the whole turn runs with no server, no
// phone, and no API key. This is the stub rule (standing rule 5) applied locally: when
// Thomas's X-Stub: 1 layer lands, createApi() replaces this and nothing above it changes.

import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(`../../../../../fixtures/${name}`, import.meta.url)));

export function createFakeApi({ log = () => {} } = {}) {
  const room = load('room-demo.json');
  const macbook = load('object-macbook.json');
  const doorSwing = load('fitreport-doorswing.json');

  const call = (name, args, result) => {
    log(name, args);
    return Promise.resolve(result);
  };

  return {
    roomId: room.roomId,
    room,
    getRoom: () => call('getRoom', {}, room),
    getObject: (id) => call('getObject', { id }, macbook),
    createObject: (body) => call('createObject', body, { ...macbook, ...body, state: 'measured' }),
    generate: (id, b) => call('generate', { id, ...b }, { jobId: 'job-1' }),

    // The demo beat: a placement near the door comes back blocked, with a real number.
    fit: ({ placements }) => {
      const nearDoor = placements.some((p) => p.p[2] < 1.0 && Math.abs(p.p[0] - 1.2) < 1.2);
      return call('fit', { placements }, nearDoor
        ? doorSwing
        : { schemaVersion: 1, ok: true, checkedAt: new Date().toISOString(), violations: [] });
    },

    search: (body) => call('search', body, [
      { objectId: 'cat-1', score: 0.82,
        object: { objectId: 'cat-1', name: 'Oak narrow bookshelf', source: 'catalog',
                  bboxMeters: { w: 0.6, h: 1.8, d: 0.3 },
                  measure: { method: 'extracted', confidence: 0.62 },
                  price: { cents: 24900, currency: 'CAD' } } },
    ]),

    createVersion: (roomId, body) => call('createVersion', { roomId }, { versionId: 'ver-1', ...body }),
    push: (roomId, body) => call('push', { roomId, ...body }, null),
  };
}

// The phone's LiDAR, stubbed. Real numbers from the committed MacBook fixture.
export function createFakeCapture() {
  const macbook = load('object-macbook.json');
  return {
    measureInView: async () => ({
      name: macbook.name,
      category: macbook.category,
      bboxMeters: macbook.bboxMeters,
      measure: macbook.measure,
      frameKeys: [],
    }),
  };
}
