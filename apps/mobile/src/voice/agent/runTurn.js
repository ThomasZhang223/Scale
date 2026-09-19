// One spoken utterance -> one spoken answer. The two-pass turn from ../TOOLS.md.
//
//   transcript ──► PASS 1 understand ──► intent ──► pipeline ──► PASS 2 speak ──► audio
//                  (no tool results in                          (results in context,
//                   context: cannot state                        every number checked)
//                   a measurement)

import { validateIntent, assertGrounded } from '../schema/intent.js';
import { INTENT_JSON_SCHEMA } from './intentJsonSchema.js';
import { UNDERSTAND_SYSTEM, SPEAK_SYSTEM } from './prompts.js';
import { runPipeline } from './toolRuntime.js';

// What pass 1 needs to resolve a reference: what is in the room, and what we already know
// about. Deliberately small — it rides in front of every turn.
function describeContext(ctx) {
  const objects = (ctx.room?.objects || []).map((o) => o.category).join(', ') || 'nothing yet';
  const known = (ctx.knownObjects || []).map((o) => `${o.name} (${o.objectId})`).join(', ') || 'none';
  return `Room contains: ${objects}.\nObjects already in the library: ${known}.`;
}

// When the pipeline could not settle on one place, the turn asks instead of answering.
// Built in code, not by the model: a question about which place you meant has no numbers in
// it, and improvising here is how a demo ends up confidently placing something in the wrong
// corner. Returns a question, or null when the results are answerable.
function clarifyFromResults(results) {
  if (results.anchorAmbiguous) {
    const where = results.anchorAmbiguous
      .map((c) => `${c.phrase} the ${c.relativeTo.category}`)
      .join(', or ');
    return `I can see a few places that would work — did you mean ${where}?`;
  }
  if (results.anchorNotFound) {
    return "I couldn't find that place in the room. Can you describe it another way?";
  }
  if (results.notFound) {
    return "I couldn't find that one. What should I be looking at?";
  }
  return null;
}

/**
 * @param {string} transcript  what the user said
 * @param {object} ctx         { api, roomId, room, knownObjects, capture, complete, speak }
 *   complete({ system, user, schema? }) -> string | parsed object   (transport/openai.js)
 *   speak(text)                                                     (TTS or a caption)
 */
export async function runTurn(transcript, ctx) {
  if (!transcript || !transcript.trim()) throw new Error('turn: empty transcript');
  const { complete, speak = () => {} } = ctx;
  if (!complete) throw new Error('turn: no completion transport wired'); // standing rule 4

  // ---- Pass 1: understand. Structured output, so the shape cannot come back wrong. ----
  const raw = await complete({
    system: UNDERSTAND_SYSTEM,
    user: `${describeContext(ctx)}\n\nThe user said: "${transcript}"`,
    schema: INTENT_JSON_SCHEMA,
    images: ctx.frames ?? [], // optional: lets it name what the camera is pointed at
    effort: 'low', // reference-picking is a simple task and this is the latency-critical hop
  });
  const intent = validateIntent(raw);

  // Spoken before any tool runs. This is the latency cover, not a courtesy.
  speak(intent.ack);

  if (intent.action === 'clarify') {
    speak(intent.question);
    return { intent, results: null, spoken: intent.question, awaitingAnswer: true };
  }

  // The ack already said it — a second pass would only pad a refusal.
  if (intent.action === 'unsupported') {
    return { intent, results: null, spoken: intent.ack };
  }

  // ---- Tools: fixed pipeline per action, chosen by code, not by the model. ----
  const results = await runPipeline(intent, ctx);

  // A reference that didn't resolve is a question, never a guess (standing rule 4).
  const question = clarifyFromResults(results);
  if (question) {
    speak(question);
    return { intent, results, spoken: question, awaitingAnswer: true };
  }

  // ---- Pass 2: speak, grounded in what came back. ----
  const spoken = await complete({
    system: SPEAK_SYSTEM,
    user:
      `The user asked: "${transcript}"\n` +
      `Interpreted as: ${intent.action}\n\n` +
      `Results:\n${JSON.stringify(results, null, 2)}`,
    effort: 'low',
  });

  // The rule, enforced. A number that did not come from a tool never reaches the speaker.
  // ceiling: non-strict in production so one false positive cannot kill a live demo; the
  // dev harness runs it strict so violations surface while there is time to fix the prompt.
  assertGrounded(spoken, results, { strict: ctx.strictGrounding ?? false });

  speak(spoken);
  return { intent, results, spoken };
}
