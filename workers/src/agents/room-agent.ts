// One RoomAgent per room. It is both the SSE fan-out for GET /v1/sync/{roomId} and the layout
// agent's memory, because those are the same thing: durable per-room state.
//
// The track this is built for asks for "an agent that remembers context, uses tools, manages
// state, and completes useful work". Concretely, in this class:
//   remembers context  -> this.sql `transcript`, every intent and what the solver did with it
//   uses tools         -> search_objects, plan_layout, check_fit, commit_version
//   manages state      -> this.setState, the current version and live subscriber count
//   completes work     -> it writes a new immutable Version and pushes it to the headset
//
// Standing rule 3, enforced by the tool schema rather than by asking politely: the model emits
// a ConstraintPlan with an objective and constraints. It has no tool and no field that can
// carry an x or a z. The solver on the laptop is the only thing that emits coordinates.

import { Agent } from "agents";
import { runToolLoop, type ToolDef } from "../lib/ai";
import { callUpstream } from "../lib/config";
import { requireOrigin } from "../lib/http";
import { contentHash, nowIso, uuid } from "../lib/ids";
import {
  getObjects,
  insertVersion,
  latestVersion,
  loadRoomCapture,
} from "../lib/store";
import type {
  FitReportV1,
  LayoutPlan,
  LayoutRule,
  ObjectV1,
  PlacementV1,
  RoomCaptureV1,
  SolveResponse,
  VersionV1,
} from "../lib/contracts";
import { describeRoom, infeasibleReason, toPlacements, toSolveRequest } from "../lib/solveframe";
import { SCHEMA_VERSION } from "../lib/contracts";
import { postSearch } from "../routes/index";

export interface RoomAgentState {
  roomId: string;
  currentVersionId: string | null;
  subscribers: number;
  lastObjective: string | null;
}

const SYSTEM_PROMPT = `You arrange furniture in a real, measured room.

You never output coordinates, positions, or rotations. You are not able to: plan_layout takes
rules, and a numerical solver computes the actual positions. Describing where something should
go in prose is not placing it.

Work in this order:
1. search_objects to find candidate pieces that fit the measured gap and the stated style.
2. plan_layout with rules. Give every rule a "why" in one clause — when a rule turns out to be
   the one that cannot hold, that clause is what the user is shown.
3. check_fit on the result. If it reports a blocking violation, change the rules and plan
   again rather than arguing with the solver.
4. commit_version once the fit is clean, then tell the user in one short paragraph what you
   placed, why, and what it cost.

UNITS. search_objects and check_fit are in METRES. plan_layout is in CENTIMETRES, because the
solver works in whole centimetres — maxCm, minCm, marginCm and walkwayCm are all centimetres.
That is the only exception in the system; do not mix them up.

Prefer "should" with a weight over "must". A plan of all hard rules is usually infeasible, and
an infeasible plan places nothing at all. Door and walkway clearance are always enforced
whatever you ask, so you do not need to state them.

All money is integer cents. If you cannot determine a value, say so and ask. Do not guess a
dimension.`;


const TOOLS: ToolDef[] = [
  {
    name: "search_objects",
    description:
      "Find objects that fit a measured space and match a described style. Searches both the " +
      "user's own scanned possessions and the ingested merchant catalog.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Style and material description, e.g. 'walnut side table'" },
        maxW: { type: "number", description: "Maximum width in METRES" },
        maxH: { type: "number", description: "Maximum height in METRES" },
        maxD: { type: "number", description: "Maximum depth in METRES" },
        maxPriceCents: { type: "number", description: "Maximum price in integer cents" },
        limit: { type: "number", description: "How many results, default 8" },
      },
      required: ["text"],
    },
  },
  {
    name: "plan_layout",
    description:
      "Run the OR-Tools solver. You give rules; it computes the positions. This is the ONLY " +
      "way to place anything. Distances are in CENTIMETRES here, which is the one exception " +
      "in this system — everywhere else is metres.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line naming the arrangement, e.g. 'Reading corner by the window'" },
        objectIds: {
          type: "array",
          items: { type: "string" },
          description: "Ids of the objects to place, from search_objects",
        },
        rules: {
          type: "array",
          description: "The constraints. A rule has no field that can hold a position.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short unique id, e.g. 'r1'" },
              type: {
                type: "string",
                enum: ["pin", "against_wall", "near", "far_from", "facing", "keep_clear"],
              },
              a: { type: "string", description: "The object this rule is about" },
              b: { type: "string", description: "For near/far_from: the other object, or window:{id} / door:{id}" },
              wall: { type: "string", description: "For against_wall: wall:{id}, or 'any'" },
              target: { type: "string", description: "For facing: an object id, window:{id}, door:{id}, or 'center'" },
              zone: { type: "string", description: "For keep_clear: door:{id}, window:{id}, or 'walkway'" },
              maxCm: { type: "number", description: "For near: maximum centre distance in CENTIMETRES" },
              minCm: { type: "number", description: "For far_from: minimum centre distance in CENTIMETRES" },
              marginCm: { type: "number", description: "For keep_clear: depth of the zone in CENTIMETRES" },
              priority: { type: "string", enum: ["must", "should"], description: "must is hard; should is soft and may be broken" },
              weight: { type: "number", description: "For should: 1-10, how much breaking it costs" },
              why: { type: "string", description: "One clause. Shown to the user when this rule is the one that cannot hold." },
            },
            required: ["id", "type", "priority"],
          },
        },
        walkwayCm: { type: "number", description: "Walkway to preserve between pieces, in CENTIMETRES. 60 is the default." },
      },
      required: ["summary", "objectIds", "rules"],
    },
  },
  {
    name: "check_fit",
    description:
      "Validate the current proposed placements against door swings, clearance corridors and " +
      "window occlusion. Returns a FitReport with any violations.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "commit_version",
    description:
      "Write the current proposed placements as a new immutable version of the room and push " +
      "it to every connected headset. Do this last, and only after check_fit is clean.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short human label, e.g. 'under $1200'" },
      },
      required: ["label"],
    },
  },
];

/** How long one SSE listener may take to accept a frame before it is dropped. */
const FANOUT_DEADLINE_MS = 1500;

export class RoomAgent extends Agent<Env, RoomAgentState> {
  initialState: RoomAgentState = {
    roomId: "",
    currentVersionId: null,
    subscribers: 0,
    lastObjective: null,
  };

  /** Live SSE writers. In-memory only — a Durable Object eviction closes them, which is
   *  correct, because an evicted DO has no open requests and therefore no subscribers. */
  private writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  /** Placements the agent has proposed but not yet committed. Deliberately not in setState:
   *  a proposal that is lost on eviction is a proposal the user never saw. */
  private proposed: PlacementV1[] = [];

  async onStart(): Promise<void> {
    // The agent's memory. `transcript` is what makes a second question in the same room
    // cheaper than the first: it already knows what it tried and what the solver said.
    this.sql`CREATE TABLE IF NOT EXISTS transcript (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      intent TEXT NOT NULL,
      objective TEXT,
      placed INTEGER NOT NULL DEFAULT 0,
      outcome TEXT
    )`;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").filter(Boolean).pop();

    switch (action) {
      case "sse":
        return this.subscribe();
      case "broadcast":
        return this.handleBroadcast(request);
      case "plan":
        return this.handlePlan(request);
      case "memory":
        return Response.json({
          state: this.state,
          transcript: this.sql`SELECT * FROM transcript ORDER BY at DESC LIMIT 20`,
        });
      default:
        return Response.json({ error: "unknown_agent_action", action }, { status: 404 });
    }
  }

  // --- SSE fan-out -------------------------------------------------------------------------
  //
  // A plain Worker cannot hold a connection open for GET /v1/sync/{roomId}. A Durable Object
  // can, and one per room is the natural sharding key: everyone looking at the same room hits
  // the same object, so a broadcast needs no coordination.

  private subscribe(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.writers.add(writer);
    this.setState({ ...this.state, subscribers: this.writers.size });

    // A comment line opens the stream immediately, so the client's EventSource fires `onopen`
    // rather than sitting in CONNECTING until the first real event.
    void writer.write(encode(": connected\n\n"));

    // Heartbeat. Intermediaries drop an idle connection after about 60 seconds, and a dead SSE
    // stream looks exactly like a quiet one from the headset. Scheduled only while somebody is
    // listening, so an empty room costs nothing against the free plan's daily request budget.
    void this.scheduleEvery(25, "heartbeat");

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Access-Control-Allow-Origin is added by the Worker's withCors on the way out.
      },
    });
  }

  /** Scheduled callback. Named, because Agent.schedule takes a method name, not a closure. */
  async heartbeat(): Promise<void> {
    if (this.writers.size === 0) {
      for (const s of this.getSchedules()) await this.cancelSchedule(s.id);
      return;
    }
    await this.fanOut(": ping\n\n");
  }

  private async fanOut(frame: string): Promise<void> {
    const payload = encode(frame);
    // Every listener at once, each with a deadline. The loop used to `await w.write()` one
    // listener after another with no limit: a client that vanished without closing its stream
    // (a headset tab killed, a dropped network) never drains its side, so that write never
    // resolved and EVERY later event for the room hung behind it - fit, version, object alike.
    // A listener that cannot take a frame in FANOUT_DEADLINE_MS is dropped; a live one reconnects
    // on its own (the client's EventSource retries) and misses at most this one frame.
    const results = await Promise.all(
      [...this.writers].map(async (w) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            w.write(payload),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("listener did not drain")), FANOUT_DEADLINE_MS);
            }),
          ]);
          return null;
        } catch {
          return w;
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      }),
    );
    const dead = results.filter((w): w is WritableStreamDefaultWriter<Uint8Array> => w !== null);
    for (const w of dead) {
      this.writers.delete(w);
      void w.abort().catch(() => {});
    }
    if (dead.length > 0) this.setState({ ...this.state, subscribers: this.writers.size });
  }

  /** Broadcast one SSE event. Called by the Worker on /push and by the mesh workflow. */
  async emit(event: "object" | "version" | "fit" | "active-room", data: unknown): Promise<void> {
    await this.fanOut(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      event: "object" | "version" | "fit" | "active-room";
      data: unknown;
      roomId?: string;
    };
    if (body.roomId && this.state.roomId !== body.roomId) {
      this.setState({ ...this.state, roomId: body.roomId });
    }
    if (body.event === "version") {
      const versionId = (body.data as { versionId?: string })?.versionId ?? null;
      this.setState({ ...this.state, currentVersionId: versionId });
    }
    await this.emit(body.event, body.data);
    return Response.json({ delivered: this.writers.size });
  }

  // --- The layout agent --------------------------------------------------------------------

  private async handlePlan(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      roomId: string;
      intent: string;
      budgetCents?: number | null;
      fixed?: PlacementV1[];
      origin?: string;
    };
    // Not request.url's origin: that is the synthetic https://agent the Worker reached us at.
    const origin = requireOrigin(body.origin);

    this.setState({ ...this.state, roomId: body.roomId });
    this.proposed = body.fixed ?? [];

    const room = (await loadRoomCapture(this.env, body.roomId)) as RoomCaptureV1;
    const priorRuns = this.sql<{ intent: string; objective: string | null; outcome: string | null }>`
      SELECT intent, objective, outcome FROM transcript ORDER BY at DESC LIMIT 3`;

    const history =
      priorRuns.length > 0
        ? `\n\nEarlier in this room:\n` +
          priorRuns.map((r) => `- "${r.intent}" -> ${r.objective ?? "no plan"}: ${r.outcome ?? "no outcome"}`).join("\n")
        : "";

    const floorArea = room?.floor?.areaM2 ?? 0;
    // Real ids, not counts: a rule can only point at a wall, door or window the model can name.
    const layout = describeRoom(room);
    const context =
      `Room ${body.roomId}, floor area ${floorArea} m2. ` +
      `Walls (id, side): ${layout.walls.map((w) => `${w.id} (${w.side})`).join(", ") || "none"}. ` +
      `Openings (id, kind, side): ${layout.openings.map((o) => `${o.id} (${o.kind}, ${o.side})`).join(", ") || "none"}. ` +
      `In rules write them as wall:{id}, door:{id} or window:{id}.` +
      (body.budgetCents ? ` Budget ${body.budgetCents} cents.` : "") +
      history;

    let lastPlan: LayoutPlan | null = null;
    let committed: VersionV1 | null = null;

    const result = await runToolLoop(this.env, {
      system: SYSTEM_PROMPT,
      user: `${context}\n\nThe user asks: ${body.intent}`,
      tools: TOOLS,
      invoke: async (name, args) => {
        switch (name) {
          case "search_objects":
            return await this.toolSearch(args, origin);
          case "plan_layout": {
            const out = await this.toolPlan(args, room, body.budgetCents ?? null, origin);
            lastPlan = out.plan;
            return out.summary;
          }
          case "check_fit":
            return await this.toolFit(room, origin);
          case "commit_version": {
            committed = await this.toolCommit(body.roomId, String(args.label ?? "agent layout"));
            return { versionId: committed.versionId, placements: committed.placements.length };
          }
          default:
            throw new Error(`No tool named ${name}.`);
        }
      },
    });

    // Remember this run, whatever happened. An agent that forgets a failed attempt will make
    // the same one on the next question.
    const plan = lastPlan as LayoutPlan | null;
    this.sql`INSERT INTO transcript (id, at, intent, objective, placed, outcome)
      VALUES (${uuid()}, ${nowIso()}, ${body.intent},
              ${plan?.summary ?? null},
              ${this.proposed.length},
              ${committed ? `committed ${(committed as VersionV1).versionId}` : result.text.slice(0, 300)})`;

    this.setState({ ...this.state, lastObjective: plan?.summary ?? null });

    return Response.json({
      answer: result.text,
      plan,
      placements: this.proposed,
      version: committed,
      toolCalls: result.calls.map((c) => ({ name: c.name, arguments: c.arguments })),
    });
  }

  private async toolSearch(args: Record<string, unknown>, origin: string): Promise<unknown> {
    // In-process, not an HTTP self-fetch: a Worker fetching its own workers.dev URL from inside a
    // Durable Object can be answered with Cloudflare's own 404 page. `origin` is still needed —
    // it is what postSearch builds each hit's glbUrl from.
    const res = await postSearch(
      new Request(`${origin}/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: args.text,
          fit: {
            maxW: args.maxW ?? null,
            maxH: args.maxH ?? null,
            maxD: args.maxD ?? null,
          },
          maxPriceCents: args.maxPriceCents ?? null,
          limit: args.limit ?? 8,
        }),
      }),
      this.env,
      origin,
    );
    if (!res.ok) throw new Error(`search returned ${res.status}`);
    const hits = (await res.json()) as { objectId: string; score: number; object: ObjectV1 }[];
    // Hand the model only what it can reason about. A full Object v1 per hit would spend the
    // context window on transforms and palettes it has no use for.
    return hits.map((h) => ({
      objectId: h.objectId,
      name: h.object.name,
      category: h.object.category,
      bboxMeters: h.object.bboxMeters,
      priceCents: h.object.price?.cents ?? null,
      merchant: h.object.merchant,
      score: Number(h.score.toFixed(3)),
    }));
  }

  private async toolPlan(
    args: Record<string, unknown>,
    room: RoomCaptureV1,
    budgetCents: number | null,
    origin: string,
  ): Promise<{ plan: LayoutPlan; summary: unknown }> {
    const objectIds = (args.objectIds as string[]) ?? [];
    if (objectIds.length === 0) throw new Error("plan_layout needs at least one objectId.");

    const candidates = await getObjects(this.env, objectIds, origin);
    if (candidates.length === 0) {
      throw new Error(`None of ${objectIds.join(", ")} exist. Run search_objects first.`);
    }
    // The budget is not a solver constraint — CP-SAT places things, it does not shop. It is
    // enforced where it belongs, before anything is placed, so an over-budget arrangement is
    // never computed and then rejected.
    if (budgetCents !== null) {
      const total = candidates.reduce((sum, o) => sum + (o.price?.cents ?? 0), 0);
      if (total > budgetCents) {
        return {
          plan: { summary: String(args.summary ?? ""), rules: [] },
          summary: {
            rejected: `Those pieces total ${total} cents, over the ${budgetCents} cent budget.`,
          },
        };
      }
    }

    const plan: LayoutPlan = {
      summary: String(args.summary ?? ""),
      movable: objectIds,
      rules: ((args.rules as LayoutRule[]) ?? []).map((r, i) => ({
        ...r,
        id: r.id || `r${i + 1}`,
      })),
    };

    const request = toSolveRequest({
      room,
      candidates,
      placements: this.proposed,
      rules: plan.rules,
      movable: plan.movable,
      walkwayCm: args.walkwayCm as number | undefined,
    });

    const solved = await callUpstream<SolveResponse>(this.env, "solver", "/solve", request);

    const reason = infeasibleReason(solved, plan.rules);
    if (reason) return { plan, summary: { infeasible: reason, status: solved.status } };

    this.proposed = toPlacements(solved, this.proposed);
    return {
      plan,
      summary: {
        status: solved.status,
        placed: this.proposed.length,
        movedCm: solved.movedCm ?? null,
        solveMs: solved.solveMs ?? null,
        satisfied: solved.satisfied ?? [],
        // A broken soft rule is the thing the user most needs told, so it is surfaced by its
        // own `why` rather than by an id the model would have to look up.
        broken: (solved.violated ?? []).map((v) => ({
          why: plan.rules.find((r) => r.id === v.ruleId)?.why ?? v.ruleId,
          byCm: v.amountCm,
        })),
      },
    };
  }

  private async toolFit(room: RoomCaptureV1, origin: string): Promise<FitReportV1> {
    if (this.proposed.length === 0) throw new Error("Nothing is placed yet. Call plan_layout first.");
    // services/fit is stateless: it needs each placed object's box inlined, or it 422s.
    const objects = Object.fromEntries(
      (await getObjects(this.env, this.proposed.map((p) => p.objectId), origin)).map((o) => [
        o.objectId,
        o.bboxMeters,
      ]),
    );
    const report = await callUpstream<FitReportV1>(this.env, "solver", "/fit", {
      schemaVersion: SCHEMA_VERSION,
      room,
      placements: this.proposed,
      objects,
    });
    await this.emit("fit", report);
    return report;
  }

  private async toolCommit(roomId: string, label: string): Promise<VersionV1> {
    if (this.proposed.length === 0) throw new Error("Nothing is placed yet. Call plan_layout first.");
    const parent = await latestVersion(this.env, roomId);
    const placements = this.proposed;
    const materials = parent?.materials ?? { wall: "#8a9a7b", floor: "oak-natural", trim: "#ffffff" };

    const version: VersionV1 = {
      schemaVersion: SCHEMA_VERSION,
      versionId: uuid(),
      roomId,
      parentId: parent?.versionId ?? null,
      label,
      createdAt: nowIso(),
      placements,
      materials,
      contentHash: await contentHash({ placements, materials }),
    };

    await insertVersion(this.env, version);
    this.setState({ ...this.state, currentVersionId: version.versionId });
    await this.emit("version", { versionId: version.versionId });
    return version;
  }
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
