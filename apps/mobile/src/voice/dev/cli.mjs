#!/usr/bin/env node
// Drive the voice loop from a terminal. No phone, no mic, no server.
//
//   node dev/cli.mjs "what is this, will it fit beside my desk?"
//   node dev/cli.mjs --all              run the scripted scenarios
//   node dev/cli.mjs --live "..."       use the real transport (needs OPENAI_API_KEY and
//                                       OPENAI_MODEL)

import { runTurn } from '../agent/runTurn.js';
import { createFakeApi, createFakeCapture } from './fakeApi.js';
import { createFakeTransport } from './fakeTransport.js';

const args = process.argv.slice(2);
const live = args.includes('--live');
const all = args.includes('--all');
const utterances = args.filter((a) => !a.startsWith('--'));

async function transport() {
  if (!live) return createFakeTransport();
  const { createOpenAITransport } = await import('../transport/openai.js');
  return createOpenAITransport({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
    gatewayUrl: process.env.OPENAI_GATEWAY_URL,
    gatewayToken: process.env.OPENAI_GATEWAY_TOKEN,
  });
}

const SCENARIOS = [
  'what is this, will it fit beside my desk?',
  'find something that fits beside my desk and matches the wood tone',
  'put it by the door',
  'move it over there',
  "what's the weather",
];

const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function one(text, complete) {
  const calls = [];
  const api = createFakeApi({ log: (n, a) => calls.push(`${n}(${JSON.stringify(a).slice(0, 70)})`) });
  const spoken = [];

  console.log(`\n\x1b[1m> ${text}\x1b[0m`);
  try {
    const out = await runTurn(text, {
      api,
      roomId: api.roomId,
      room: api.room,
      capture: createFakeCapture(),
      complete,
      speak: (s) => spoken.push(s),
      strictGrounding: true, // dev: a hallucinated number should fail loudly here
    });
    console.log(dim(`  intent   ${out.intent.action}`));
    console.log(dim(`  tools    ${calls.join(' -> ') || 'none'}`));
    spoken.forEach((s, i) => console.log(`  ${i === 0 ? 'ack   ' : 'speaks'}   ${s}`));
  } catch (e) {
    console.log(`  \x1b[31mFAILED\x1b[0m   ${e.message}`);
    spoken.forEach((s) => console.log(dim(`  (said)   ${s}`)));
  }
}

const complete = await transport();
for (const t of all || utterances.length === 0 ? SCENARIOS : utterances) {
  await one(t, complete);
}
console.log();
