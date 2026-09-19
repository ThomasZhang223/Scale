// A scripted stand-in for Claude, so the pipeline is testable with no key and no network.
// Keyword routing only — it exists to exercise the machinery, never to ship.

export function createFakeTransport() {
  return async function complete({ user, schema }) {
    if (schema) {
      const said = (user.match(/The user said: "([^"]*)"/) || [, ''])[1].toLowerCase();
      const base = { schemaVersion: 1 };

      if (/find|something that fits|looking for/.test(said)) {
        return { ...base, action: 'find_object', ack: 'looking for something',
                 target: { kind: 'description', text: 'narrow oak bookshelf' },
                 anchor: { kind: 'named', text: 'beside my desk' } };
      }
      if (/put it|place it|move it/.test(said)) {
        return { ...base, action: 'place_object', ack: 'placing it now',
                 target: { kind: 'in_view' }, anchor: { kind: 'named', text: 'by the door' } };
      }
      if (/weather|joke/.test(said)) {
        return { ...base, action: 'unsupported', ack: 'I can only help with this room' };
      }
      if (/over there|that spot/.test(said)) {
        return { ...base, action: 'clarify', ack: 'one moment',
                 target: { kind: 'in_view' }, question: 'Which corner did you mean?' };
      }
      return { ...base, action: 'measure_and_fit', ack: 'let me measure that',
               target: { kind: 'in_view' }, anchor: { kind: 'named', text: 'beside my desk' } };
    }

    // Pass 2 — deliberately quotes numbers straight out of the results so the grounding
    // assertion has something real to check.
    const results = JSON.parse(user.slice(user.indexOf('Results:') + 8));
    if (results.fitReport && !results.fitReport.ok) {
      const v = results.fitReport.violations[0];
      return `That does not work — it ${v.message}. Try the other side of the desk.`;
    }
    if (results.search) {
      const o = results.search[0].object;
      return `${o.name} fits, at ${(o.bboxMeters.w * 100).toFixed(0)} centimetres wide. ` +
             `Its listed size is unverified, so treat it as approximate.`;
    }
    if (results.object) {
      const b = results.object.bboxMeters;
      return `It is ${(b.w * 100).toFixed(1)} by ${(b.d * 100).toFixed(1)} centimetres, and it fits.`;
    }
    return 'I could not work that out.';
  };
}

// Same, but it invents a number — used to prove assertGrounded actually catches one.
export function createLyingTransport(real) {
  return async function complete(args) {
    if (args.schema) return real(args);
    return 'That leaves you about 45 centimetres of walkway, so you are fine.';
  };
}
