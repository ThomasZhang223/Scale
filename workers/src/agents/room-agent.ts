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
import { contentHash, nowIso, uuid } from "../lib/ids";
import {
  getObjects,
  insertVersion,
  latestVersion,
  loadRoomCapture,
} from "../lib/store";
import type {
  ConstraintPlanV1,
  FitReportV1,
  ObjectV1,
  PlacementV1,
  RoomCaptureV1,
  SolveResponse,
  VersionV1,
} from "../lib/contracts";
import { SCHEMA_VERSION } from "../lib/contracts";

export interface RoomAgentState {
  roomId: string;
  currentVersionId: string | null;
  subscribers: number;
  lastObjective: string | null;
}

const SYSTEM_PROMPT = `You arrange furniture in a real, measured room.

You never output coordinates, positions, or rotations. You are not able to: the plan_layout
tool takes an objective and a list of constraints, and a numerical solver computes the actual
positions. Describing where something should go in prose is not placing it.

Work in this order:
1. search_objects to find candidate pieces that fit the measured gap and the stated style.
2. plan_layout with an objective and constraints. Every length you give is in METRES.
3. check_fit on the result. If it reports a blocking violation, change the constraints and
   plan again rather than arguing with the solver.
4. commit_version once the fit is clean, then tell the user in one short paragraph what you
   placed, why, and what it cost.

All lengths are metres. All money is integer cents. If you cannot determine a value, say so
and ask. Do not guess a dimension.`;

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
      "Run the numerical solver. You supply an objective and constraints; it returns the " +
      "positions. This is the ONLY way to place anything.",
    parameters: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          enum: ["maximize_walkway", "maximize_free_floor", "minimize_wall_gap", "group_seating"],
          description: "What the solver optimises for",
        },
        objectIds: {
          type: "array",
          items: { type: "string" },
          description: "Ids of the objects to place, from search_objects",
        },
        minClearanceMeters: {
          type: "number",
          description: "Walkway width to preserve, in METRES. 0.9 is the usual default.",
        },
        againstWallObjectIds: {
          type: "array",
          items: { type: "string" },
          description: "Objects that must sit flat against a wall",
        },
        budgetCents: { type: "number", description: "Total budget in integer cents" },
        notes: { type: "string", description: "One sentence of reasoning, shown to the user" },
      },
      required: ["objective", "objectIds"],
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
        return this.handlePlan(request, url.origin);
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
    const dead: WritableStreamDefaultWriter<Uint8Array>[] = [];
    for (const w of this.writers) {
      try {
        await w.write(payload);
      } catch {
        dead.push(w);
      }
    }
    for (const w of dead) this.writers.delete(w);
    if (dead.length > 0) this.setState({ ...this.state, subscribers: this.writers.size });
  }

  /** Broadcast one SSE event. Called by the Worker on /push and by the mesh workflow. */
  async emit(event: "object" | "version" | "fit", data: unknown): Promise<void> {
    await this.fanOut(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      event: "object" | "version" | "fit";
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

  private async handlePlan(request: Request, origin: string): Promise<Response> {
    const body = (await request.json()) as {
      roomId: string;
      intent: string;
      budgetCents?: number | null;
      fixed?: PlacementV1[];
    };

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
    const context =
      `Room ${body.roomId}, floor area ${floorArea} m2, ${(room?.walls ?? []).length} walls, ` +
      `${(room?.openings ?? []).length} openings.` +
      (body.budgetCents ? ` Budget ${body.budgetCents} cents.` : "") +
      history;

    let lastPlan: ConstraintPlanV1 | null = null;
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
            return await this.toolFit(room);
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
    const plan = lastPlan as ConstraintPlanV1 | null;
    this.sql`INSERT INTO transcript (id, at, intent, objective, placed, outcome)
      VALUES (${uuid()}, ${nowIso()}, ${body.intent},
              ${plan?.objective ?? null},
              ${this.proposed.length},
              ${committed ? `committed ${(committed as VersionV1).versionId}` : result.text.slice(0, 300)})`;

    this.setState({ ...this.state, lastObjective: plan?.objective ?? null });

    return Response.json({
      answer: result.text,
      plan,
      placements: this.proposed,
      version: committed,
      toolCalls: result.calls.map((c) => ({ name: c.name, arguments: c.arguments })),
    });
  }

  private async toolSearch(args: Record<string, unknown>, origin: string): Promise<unknown> {
    const res = await fetch(`${origin}/v1/search`, {
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
    });
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
  ): Promise<{ plan: ConstraintPlanV1; summary: unknown }> {
    const objectIds = (args.objectIds as string[]) ?? [];
    if (objectIds.length === 0) throw new Error("plan_layout needs at least one objectId.");

    const candidates = await getObjects(this.env, objectIds, origin);
    if (candidates.length === 0) {
      throw new Error(`None of ${objectIds.join(", ")} exist. Run search_objects first.`);
    }

    const plan: ConstraintPlanV1 = {
      schemaVersion: SCHEMA_VERSION,
      objective: (args.objective as ConstraintPlanV1["objective"]) ?? "maximize_walkway",
      constraints: [
        { kind: "min_clearance", meters: Number(args.minClearanceMeters ?? 0.9) },
        ...((args.againstWallObjectIds as string[]) ?? []).map(
          (id) => ({ kind: "against_wall", objectId: id, wallId: null }) as const,
        ),
        ...(budgetCents !== null ? [{ kind: "budget" as const, cents: budgetCents }] : []),
      ],
      notes: String(args.notes ?? ""),
    };

    const solved = await callUpstream<SolveResponse>(this.env, "solver", "/solve", {
      schemaVersion: SCHEMA_VERSION,
      room,
      candidates,
      fixed: this.proposed,
      plan,
    });

    if (solved.infeasible) {
      return { plan, summary: { infeasible: solved.infeasible, placements: 0 } };
    }
    this.proposed = solved.placements;
    return {
      plan,
      summary: {
        placed: solved.placements.length,
        objective: solved.objective,
        objectIds: solved.placements.map((p) => p.objectId),
      },
    };
  }

  private async toolFit(room: RoomCaptureV1): Promise<FitReportV1> {
    if (this.proposed.length === 0) throw new Error("Nothing is placed yet. Call plan_layout first.");
    const report = await callUpstream<FitReportV1>(this.env, "solver", "/fit", {
      schemaVersion: SCHEMA_VERSION,
      room,
      placements: this.proposed,
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
