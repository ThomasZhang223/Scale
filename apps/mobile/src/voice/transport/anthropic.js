// Claude-backed completion transport.
//
// Injected rather than imported by the agent core, for two reasons: the core stays testable
// with a scripted fake (dev/scenarios.js), and where the agent finally runs — in the app, or
// behind a server route so the key never ships to a device — becomes a one-line swap instead
// of a refactor. See ../TOOLS.md "Where this runs".

const MODEL = 'claude-opus-5';

export function createAnthropicTransport({ client, model = MODEL }) {
  if (!client) throw new Error('transport: no Anthropic client'); // standing rule 4

  // `images` are base64 JPEGs from the object-scan capture. Optional: the loop works without
  // them, and they only buy one thing — the object's name and category, so the user does not
  // have to type what they are holding. A category also feeds the clearance priors, which is
  // why a bounding box alone cannot tell you a chest of drawers needs room to open.
  return async function complete({ system, user, schema, images = [], effort = 'low' }) {
    const content = [
      ...images.map((data) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data },
      })),
      { type: 'text', text: user },
    ];

    const req = {
      model,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content }],
      output_config: { effort },
    };

    if (schema) {
      req.output_config.format = { type: 'json_schema', schema };
      const res = await client.messages.parse(req);
      if (!res.parsed_output) {
        throw new Error('transport: structured output failed to parse');
      }
      return res.parsed_output;
    }

    const res = await client.messages.create(req);
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  };
}
