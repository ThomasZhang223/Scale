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
  /** Set on a tool result, to answer the assistant tool_call with this id. */
  tool_call_id?: string;
  /** Set on the assistant turn that requested tools, echoed back verbatim. */
  tool_calls?: unknown[];
}

interface AiToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Workers AI answers in one of two shapes, and which one you get depends on the model.
 *
 *   older models (e.g. hermes-2-pro, which the function-calling docs use as their example):
 *     { response: "...", tool_calls: [ { name, arguments: {...} } ] }
 *
 *   OpenAI-family models, including @cf/openai/gpt-oss-120b, which is the one we use:
 *     { choices: [ { message: { content, tool_calls: [
 *         { id, type: "function", function: { name, arguments: "<JSON STRING>" } } ] } } ] }
 *
 * Two differences bite. The text is `choices[0].message.content`, not `response`. And the
 * arguments are a JSON *string* that has to be parsed, not an object — reading `.arguments`
 * directly yields a string where the tool expects a record, so every tool call silently
 * receives nothing.
 *
 * This cost a live debugging session: the deployed agent returned an empty answer with zero
 * tool calls and threw no exception, because both fields this code read were simply undefined.
 */
interface AiChatResponse {
  response?: string;
  tool_calls?: AiToolCall[];
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

interface NormalizedCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  raw: unknown;
}

/**
 * gpt-oss speaks the "harmony" format internally: it segments its own output into channels
 * with control tokens like `<|start|>assistant<|channel|>commentary`. Those are supposed to be
 * consumed by the server, but they leak into `content` when the model opens a channel and then
 * produces nothing in it — the deployed layout agent returned literally
 * `<|start|>assistant<|channel|>comment` as its whole answer.
 *
 * Stripping them is right rather than cosmetic: a control token is not text the user asked for,
 * and showing it is worse than showing nothing.
 */
function stripControlTokens(text: string): string {
  return text.replace(/<\|[^|]*\|>/g, "").replace(/\s+/g, " ").trim();
}

function normalize(res: AiChatResponse): { text: string; calls: NormalizedCall[] } {
  const choice = res.choices?.[0]?.message;
  if (choice) {
    const calls = (choice.tool_calls ?? []).map((c) => {
      let args: Record<string, unknown> = {};
      try {
        args = c.function?.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
      } catch {
        // A model that emitted unparseable arguments has not called the tool. Leaving args
        // empty lets the tool raise with its own named error rather than guessing a value.
        args = {};
      }
      return { id: c.id, name: c.function?.name ?? "", args, raw: c };
    });
    return { text: stripControlTokens(choice.content ?? ""), calls };
  }
  return {
    text: stripControlTokens(res.response ?? ""),
    calls: (res.tool_calls ?? []).map((c) => ({ name: c.name, args: c.arguments ?? {}, raw: c })),
  };
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
  let nudged = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = (await (env.AI as unknown as {
      run: (model: string, input: unknown) => Promise<unknown>;
    }).run(TOOL_MODEL, { messages, tools: opts.tools })) as AiChatResponse;

    const { text, calls: toolCalls } = normalize(res);
    if (toolCalls.length === 0) {
      if (text.length > 0) return { text, calls };
      // Nothing survived stripping and no tool was called: the model opened a channel and said
      // nothing in it. One nudge, then give up — an empty answer is not worth a retry loop that
      // burns the daily allowance.
      if (nudged) return { text: "", calls };
      nudged = true;
      messages.push({
        role: "user",
        content:
          "You produced no answer and called no tool. Either call one of the tools, or reply " +
          "in one short paragraph of plain text. Do not emit channel markers.",
      });
      continue;
    }

    // Echo the assistant turn back verbatim before the results. An OpenAI-family model
    // rejects a `tool` message that does not answer a `tool_calls` it can see in the history.
    messages.push({
      role: "assistant",
      content: text,
      tool_calls: toolCalls.map((c) => c.raw),
    });

    for (const call of toolCalls) {
      let result: unknown;
      try {
        result = await opts.invoke(call.name, call.args);
      } catch (err) {
        // A failed tool is information for the model, not a crash. It is told what broke so it
        // can pick a different tool or explain the failure to the user.
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      calls.push({ name: call.name, arguments: call.args, result });
      messages.push({
        role: "tool",
        name: call.name,
        tool_call_id: call.id,
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
  return normalize(res).text;
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
