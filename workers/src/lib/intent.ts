/*
 * POST /v1/intent: what the sentence MEANS, as structured data.
 *
 * Why a model and not a longer verb list. Thomas says "find me some objects for shopify" and
 * "search my scanned objects" — he names the SOURCE he wants searched, not the product. A verb
 * list reads "objects for shopify" as the product and sends that to a storefront, which finds
 * nothing. Naming a source is not something a word list can be taught; it is a sentence to be
 * understood.
 *
 * What it may and may not decide. It turns words into an intent and constraints. It never emits
 * coordinates, never picks a product, never places anything (standing rule 3) — a solver places,
 * a ranker ranks, and this only says what was asked for.
 *
 * Failure is designed in: invalid JSON, a value out of range, a timeout or any error raises, and
 * the caller falls back to its own regex router. Both paths are deterministic about what they do
 * with the answer, so the degradation is honest rather than silent — the response says which ran.
 */

import { HttpError, json, readJson } from "./http";

/**
 * Small and fast: this is a classification, not a conversation, and latency is the product.
 *
 * It also has to support JSON Schema mode, which most Workers AI text models do NOT — 8b-fp8
 * answers `5025: This model doesn't support JSON Schema` to every request. Measured 2026-09-20.
 */
export const INTENT_MODEL = "@cf/meta/llama-3.2-3b-instruct";

/** The wall clock the headset is willing to wait before using its own rules instead. */
export const INTENT_BUDGET_MS = 1_200;

export interface ParsedIntent {
  intent: "shop" | "scans" | "library" | "design";
  /** The product words, or null for "just show me what there is". */
  query: string | null;
  category: string | null;
  fit: { maxW?: number; maxH?: number; maxD?: number } | null;
  /**
   * Design requests only: the kinds of furniture the room would need for this to be arrangeable
   * ("a reading nook" -> armchair, lamp, side table). CATEGORIES, never products and never
   * positions (standing rule 3) — the headset subtracts what the room already holds and offers
   * the rest from the library. Null when the sentence implies no particular furniture, which is
   * most of them: "move the sofa to the window" needs nothing new.
   */
  needs: string[] | null;
}

/**
 * The app's furniture vocabulary, verbatim from `categoryOf()`'s `known` list in
 * apps/xr/src/main.ts. Two copies because the Worker and the headset are separate packages;
 * the headset validates `needs` against its own copy as well, so an older deploy of either
 * side drops a word it does not know rather than acting on it.
 */
export const FURNITURE_CATEGORIES = [
  "coffee table", "side table", "sofa", "couch", "armchair", "chair", "stool", "bench", "dining",
  "table", "desk", "bed", "storage", "shelf", "bookcase", "cabinet", "dresser", "wardrobe",
  "lamp", "television", "tv", "plant", "rug",
] as const;

const SYSTEM = `You label one spoken sentence from someone wearing a VR headset in their room.
Answer with JSON only.

intent:
- "shop" — they want something that is for sale. Words like shopify, store, shop, buy, purchase, for sale, online, listings, or naming a kind of furniture they do not own.
- "scans" — they want something THEY captured with their phone. Words like my scans, scanned, my phone, iphone, my objects, my stuff, my library, my captures.
- "library" — the built-in furniture this app ships. Words like our furniture, the library, built-in, the catalogue. ALSO the default for a plain request for a piece of furniture with no source named at all: "add a couch", "bring in a chair", "I want a sofa".
- "design" — anything about arranging, moving, style or mood of the room.

A named source always wins over the default. "find me a couch on shopify" is shop, not library.
If NO source is named at all, a request for a piece of furniture is "library" — whatever the verb
is. "find me a lamp", "I need a side table", "get me a coffee table" are all library, because
nothing in them names a store. Only say "shop" when the sentence names one: shopify, the store,
the shops, for sale, buy, online, the listings.

query: the PRODUCT WORDS only, or null.
The name of a source is never the product. "objects for shopify" means browse the shop: query is null.
"my scanned objects" means list the scans: query is null. "my scans for a chair" is query "chair".

category: one of seating, surface, storage, lighting, sleeping, decor, or null.

fit: maximum size IN METRES, {"maxW":0.8} for "80 cm wide" or "fits the 80 cm gap". Height is maxH, depth is maxD. null when no size is mentioned. Never guess a size.

needs: for a "design" intent ONLY, the kinds of furniture that request needs in the room, as 2 to 4 words from this list and nothing else:
coffee table, side table, sofa, couch, armchair, chair, stool, bench, dining, table, desk, bed, storage, shelf, bookcase, cabinet, dresser, wardrobe, lamp, television, tv, plant, rug.
Answer needs only when the request names a KIND OF PLACE or an ACTIVITY that takes particular furniture — "a reading nook", "a home office", "a dining area", "somewhere to watch a film" — or names a piece that has to be there ("with a floor lamp").
Answer null for everything else, and that is most requests: moving, turning or clearing what is already there, and bare style or mood words with no activity in them ("make it cozy", "make it nicer", "tidy up"). Never guess.
Categories only. Never a product, never a brand, never a position. needs is null for shop, scans and library intents.`;

const SHOTS: [string, ParsedIntent][] = [
  ["find me some objects for shopify", { intent: "shop", query: null, category: null, fit: null, needs: null }],
  ["add a couch", { intent: "library", query: "couch", category: "seating", fit: null, needs: null }],
  ["bring in a chair", { intent: "library", query: "chair", category: "seating", fit: null, needs: null }],
  ["give me a sofa from our furniture", { intent: "library", query: "sofa", category: "seating", fit: null, needs: null }],
  ["find me a couch on shopify", { intent: "shop", query: "couch", category: "seating", fit: null, needs: null }],
  ["search my scanned objects", { intent: "scans", query: null, category: null, fit: null, needs: null }],
  ["search my scans for a chair", { intent: "scans", query: "chair", category: "seating", fit: null, needs: null }],
  ["show me some lamps that fit the 80 centimeter gap beside my desk", { intent: "library", query: "lamps", category: "lighting", fit: { maxW: 0.8 }, needs: null }],
  ["I need a new side table", { intent: "library", query: "side table", category: "surface", fit: null, needs: null }],
  ["find me a lamp", { intent: "library", query: "lamp", category: "lighting", fit: null, needs: null }],
  ["get me a coffee table under 1 meter", { intent: "library", query: "coffee table", category: "surface", fit: null, needs: null }],
  ["show me chairs for sale", { intent: "shop", query: "chairs", category: "seating", fit: null, needs: null }],
  ["bring in the thing I scanned on my phone", { intent: "scans", query: null, category: null, fit: null, needs: null }],
  ["make the room feel cozy", { intent: "design", query: null, category: null, fit: null, needs: null }],
  ["move the sofa to the window", { intent: "design", query: null, category: null, fit: null, needs: null }],
  ["make me a reading nook", { intent: "design", query: null, category: null, fit: null, needs: ["armchair", "lamp", "side table"] }],
  ["set up a home office over there", { intent: "design", query: null, category: null, fit: null, needs: ["desk", "chair", "lamp", "shelf"] }],
  ["turn this into a dining area", { intent: "design", query: null, category: null, fit: null, needs: ["dining", "chair"] }],
  ["tidy up", { intent: "design", query: null, category: null, fit: null, needs: null }],
];

const CATEGORIES = new Set(["seating", "surface", "storage", "lighting", "sleeping", "decor"]);

/** Metres. A bound outside this is a model hallucinating units, not a room. */
const MIN_M = 0.02;
const MAX_M = 10;

/** Throws unless the model answered exactly the shape asked for. The caller then uses its rules. */
export function validateIntent(value: unknown): ParsedIntent {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.intent !== "shop" && v.intent !== "scans" && v.intent !== "library" && v.intent !== "design") {
    throw new HttpError(502, "bad_intent", `intent was ${JSON.stringify(v.intent)}.`);
  }
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 120) : null);
  const query = str(v.query);
  const category = str(v.category);
  let fit: ParsedIntent["fit"] = null;
  if (v.fit && typeof v.fit === "object") {
    const out: Record<string, number> = {};
    for (const k of ["maxW", "maxH", "maxD"] as const) {
      const n = (v.fit as Record<string, unknown>)[k];
      // A number out of range is dropped rather than clamped: a clamped guess is still a guess.
      if (typeof n === "number" && Number.isFinite(n) && n >= MIN_M && n <= MAX_M) out[k] = n;
    }
    if (Object.keys(out).length) fit = out;
  }
  return {
    intent: v.intent,
    query,
    category: category && CATEGORIES.has(category.toLowerCase()) ? category.toLowerCase() : null,
    fit,
    needs: v.intent === "design" ? validateNeeds(v.needs) : null,
  };
}

/**
 * The furniture words, or null. A word outside the vocabulary is DROPPED rather than passed on:
 * the caller looks each one up in a fixed library, so an invented category ("nook", "reading
 * light") would find nothing and read to the user as an empty result. Four is the ceiling
 * because the popout shows six cards; asking for more would silently truncate the last one.
 */
export function validateNeeds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const word = item.trim().toLowerCase();
    if ((VOCABULARY as Set<string>).has(word) && !out.includes(word)) out.push(word);
  }
  return out.length ? out.slice(0, 4) : null;
}

const VOCABULARY = new Set<string>(FURNITURE_CATEGORIES);

/** The model's own answer, or a throw. Never a default intent — a guess here routes the whole turn. */
export async function parseIntent(env: Env, text: string): Promise<ParsedIntent> {
  const messages = [
    { role: "system", content: SYSTEM },
    ...SHOTS.flatMap(([said, want]) => [
      { role: "user", content: said },
      { role: "assistant", content: JSON.stringify(want) },
    ]),
    { role: "user", content: text.slice(0, 400) },
  ];
  // Every failure below — a model that cannot do JSON mode, a Workers AI outage, a timeout —
  // has to arrive at the caller as "use your rules", so all of them become one 502.
  const raced = await Promise.race([

    env.AI.run(INTENT_MODEL, {
      messages,
      max_tokens: 300,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            intent: { type: "string", enum: ["shop", "scans", "library", "design"] },
            query: { type: ["string", "null"] },
            category: { type: ["string", "null"] },
            fit: {
              type: ["object", "null"],
              properties: { maxW: { type: "number" }, maxH: { type: "number" }, maxD: { type: "number" } },
            },
            needs: { type: ["array", "null"], items: { type: "string", enum: [...FURNITURE_CATEGORIES] } },
          },
          required: ["intent"],
        },
      },
    } as never),
    new Promise((_, reject) =>
      setTimeout(() => reject(new HttpError(504, "intent_timeout", `No answer in ${INTENT_BUDGET_MS} ms.`)), INTENT_BUDGET_MS),
    ),
  ]).catch((err) => {
    if (err instanceof HttpError) throw err; // the timeout above, already shaped
    throw new HttpError(502, "intent_unavailable", `Workers AI: ${(err as Error).message}`);
  });

  // Workers AI answers in two shapes depending on the model; see lib/ai.ts for the full story.
  // With response_format the answer is already an object on `response` for some models and a
  // JSON string for others, so both are accepted and anything else raises.
  const r = raced as { response?: unknown; choices?: { message?: { content?: string } }[] };
  const raw = r.response ?? r.choices?.[0]?.message?.content;
  if (raw == null || raw === "") throw new HttpError(502, "empty_intent", "The model returned nothing.");
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(stripFence(raw)) : raw;
  } catch (err) {
    // Truncated or malformed output is the model failing, not the Worker: a 502 tells the
    // caller to use its own rules, where a 500 would read as "the API is broken".
    throw new HttpError(502, "bad_intent_json", `The model's JSON did not parse: ${(err as Error).message}`);
  }
  return validateIntent(parsed);
}

/** Some models wrap JSON in a markdown fence even in JSON mode. */
function stripFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}

export async function postIntent(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ text?: unknown }>(req);
  if (typeof body.text !== "string" || !body.text.trim()) {
    throw new HttpError(400, "missing_field", "text is required."); // standing rule 4
  }
  const startedAt = Date.now();
  const parsed = await parseIntent(env, body.text.trim());
  return json({ ...parsed, router: "llm", model: INTENT_MODEL, ms: Date.now() - startedAt });
}
