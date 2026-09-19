// OpenAI-backed completion transport for the voice assistant.
//
// Matches how the rest of the project talks to a model — services/agent/src/pipeline/planner.ts
// and services/ingest/app/ai_extract.py both POST /chat/completions directly with the same env
// vars and the same optional Cloudflare AI Gateway. No SDK: one convention beats three.
//
// Injected rather than imported by the agent core, for two reasons: the core stays testable
// with a scripted fake (dev/fakeTransport.js), and where the agent finally runs — in the app,
// or behind a server route so the key never ships to a device — becomes a one-line swap
// instead of a refactor. See ../TOOLS.md "Where this runs".

const DEFAULT_BASE = 'https://api.openai.com/v1';

/**
 * @param {object} cfg
 *   apiKey        OPENAI_API_KEY
 *   model         OPENAI_MODEL
 *   gatewayUrl    optional, https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai
 *   gatewayToken  optional, sent as cf-aig-authorization
 */
export function createOpenAITransport({ apiKey, model, gatewayUrl, gatewayToken, fetchImpl }) {
  if (!apiKey || !model) {
    // standing rule 4: a transport that silently answers nothing is worse than one that refuses.
    throw new Error('transport: OPENAI_API_KEY and OPENAI_MODEL are both required');
  }
  const base = (gatewayUrl || DEFAULT_BASE).replace(/\/$/, '');
  const doFetch = fetchImpl || globalThis.fetch;

  return async function complete({ system, user, schema, images = [] }) {
    // Optional camera frames, base64 JPEG. They let the model name what it is looking at so
    // nobody types "MacBook Pro 14" on a phone keyboard.
    const withImages = [
      { type: 'text', text: user },
      ...images.map((data) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${data}` },
      })),
    ];

    const body = {
      model,
      temperature: 0, // picking a reference and reading back a measured number, not composing
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: images.length ? withImages : user },
      ],
    };

    if (schema) {
      // Strict mode needs every property in `required` and additionalProperties false. The
      // intent schema is written that way — see agent/intentJsonSchema.js.
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'voice_intent', strict: true, schema },
      };
    }

    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(gatewayToken ? { 'cf-aig-authorization': `Bearer ${gatewayToken}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`transport: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const message = (await res.json())?.choices?.[0]?.message;
    if (message?.refusal) throw new Error(`transport: refused — ${message.refusal}`);
    if (!message?.content) throw new Error('transport: empty response');

    return schema ? JSON.parse(message.content) : message.content.trim();
  };
}
