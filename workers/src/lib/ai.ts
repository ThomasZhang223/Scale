// Workers AI: the brain for both agent loops.
//
// Chosen over a third-party API for three reasons, in order: it needs no API key (Thomas has
// none for this project), it keeps the agent's reasoning inside Workers — which is the thing
// the Cloudflare track is graded on — and it is on the free plan.
//
// The binding is remote-only. There is no local simulation, so every call here needs internet
// even under `wrangler dev`. That is the single reason the agent loops cannot run on a LAN
// with no uplink, and it is stated in workers/DEPLOY.md under "What dies without internet".

/** Tool-calling model. Verified id, 128K context, function calling, on the free plan. */
export const TOOL_MODEL = "@cf/openai/gpt-oss-120b";

/** Vision model, for the VLM pass over a spec-sheet image that has no readable text. */
export const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

interface AiToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface AiChatResponse {
  response?: string;
  tool_calls?: AiToolCall[];
}

export interface ToolLoopResult {
  /** The model's final prose answer. */
  text: string;
  /** Every tool the model actually invoked, in order. The audit trail of what the agent did. */
  calls: { name: string; arguments: Record<string, unknown>; result: unknown }[];
}

/**
 * Run a model with tools until it stops calling them, or until `maxTurns` is reached.
 *
 * `maxTurns` is a hard ceiling rather than a suggestion. A model that loops on a failing tool
 * would otherwise burn the whole free-plan daily allowance in one request.
 *
 * ceiling: tool calls in a turn run sequentially, not in parallel. Each of our tools either
 * hits D1 or the tunnelled solver, and the solver is single-threaded on a laptop anyway, so
 * parallelism would buy nothing and would make the transcript order meaningless.
 */
export async function runToolLoop(
  env: Env,
  opts: {
    system: string;
    user: string;
    tools: ToolDef[];
    maxTurns?: number;
    invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<ToolLoopResult> {
  const maxTurns = opts.maxTurns ?? 6;
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const calls: ToolLoopResult["calls"] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = (await (env.AI as unknown as {
      run: (model: string, input: unknown) => Promise<unknown>;
    }).run(TOOL_MODEL, { messages, tools: opts.tools })) as AiChatResponse;

    const toolCalls = res.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { text: res.response ?? "", calls };
    }

    for (const call of toolCalls) {
      let result: unknown;
      try {
        result = await opts.invoke(call.name, call.arguments ?? {});
      } catch (err) {
        // A failed tool is information for the model, not a crash. It is told what broke so it
        // can pick a different tool or explain the failure to the user.
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      calls.push({ name: call.name, arguments: call.arguments ?? {}, result });
      messages.push({
        role: "assistant",
        content: `Calling ${call.name} with ${JSON.stringify(call.arguments ?? {})}`,
      });
      messages.push({
        role: "tool",
        name: call.name,
        content: JSON.stringify(result).slice(0, 8000),
      });
    }
  }

  return {
    text: `Stopped after ${maxTurns} tool turns without a final answer.`,
    calls,
  };
}

/** A single completion with no tools. Used for the catalog dimension extraction pass. */
export async function complete(env: Env, system: string, user: string): Promise<string> {
  const res = (await (env.AI as unknown as {
    run: (model: string, input: unknown) => Promise<unknown>;
  }).run(TOOL_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  })) as AiChatResponse;
  return res.response ?? "";
}

/**
 * Parse a JSON object out of a model's prose answer.
 *
 * Returns null rather than throwing or guessing. Standing rule 4 applies to models too: a
 * model that did not answer in the requested shape has not answered, and inventing a default
 * dimension here would put a fabricated number into `bboxMeters`, which is the single worst
 * field in the project to be wrong about.
 */
export function parseJsonObject<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
