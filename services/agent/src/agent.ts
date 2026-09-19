import { Agent } from 'agents';
import type { Env } from './index.ts';
import type { FitReport, LogEntry, PlacementV1, Plan, Preference, Proposal, RequestState, RoomState, SolverRequest, SolverResponse, VersionV1 } from './pipeline/types.ts';
import { PRESETS, now } from './pipeline/types.ts';
import { AgentFailure, runLoop } from './pipeline/loop.ts';
import { PlannerUnavailable, explainWithOpenAI, planWithOpenAI, plannerConfigured, type PlannerConfig } from './pipeline/planner.ts';
import demoTimeline from '../fixtures/agent-request-demo.json';
import stubProposal from '../fixtures/pipeline/proposal.json';
import presetPlans from '../fixtures/preset-plans.json';

/*
 * DesignerAgent: one Durable Object per room, on the Cloudflare Agents SDK. It owns the
 * whole loop (03_WORKER_AGENT.md): request state and the visible log, the room's Version
 * history (proposed / current / superseded, so undo is free), and the preferences it
 * remembers. Its tools: the OR-Tools solver (a team laptop behind a Cloudflare Tunnel),
 * the fit validator, and OpenAI through AI Gateway for planning and explaining.
 *
 * Routes (after /v1/agent/{roomId}): see 01_CONTRACT.md §1, plus two additions that the
 * headset needs because the main Worker's Versions and sync are still stubs:
 *   POST /state   the headset's room, objects and current layout (on load and after edits)
 *   GET  /events  SSE with agent.status / agent.log / agent.proposal / agent.failed / version.current
 */

const ACTIVE: RequestState[] = ['queued', 'reading', 'planning', 'solving', 'checking'];
const RECENT_USER_MS = 60_000;
const SOLVER_TIMEOUT_MS = 9000; // the solver's own limit is up to 6 s for full rooms

interface RequestRow {
  id: string;
  state: RequestState;
  created_at: string;
  updated_at: string;
  body: string;
  log: string;
  proposal: string | null;
  error: string | null;
}

interface VersionRow {
  id: string;
  parent_id: string | null;
  status: string;
  created_by: string;
  request_id: string | null;
  label: string;
  placements: string;
  created_at: string;
}

export class DesignerAgent extends Agent<Env> {
  private streams = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private stubStarted = new Map<string, number>();

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, state TEXT, created_at TEXT, updated_at TEXT, body TEXT, log TEXT, proposal TEXT, error TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT, created_by TEXT, request_id TEXT, label TEXT, placements TEXT, created_at TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS preferences (id TEXT PRIMARY KEY, text TEXT, rule TEXT, source TEXT, created_at TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`;
  }

  // ---------- routing ----------

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/v1\/agent\/[^/]+(\/.*)?$/);
    const path = (m?.[1] ?? '/').replace(/\/$/, '') || '/';
    const stub = request.headers.get('X-Stub') === '1';
    try {
      if (request.method === 'POST' && path === '/state') return this.postState((await request.json()) as RoomState);
      if (request.method === 'GET' && path === '/state') return json({ state: this.roomState(), currentVersionId: this.current()?.id ?? null });
      if (request.method === 'GET' && path === '/events') return this.events();
      if (request.method === 'GET' && path === '/health') return this.health();
      if (request.method === 'GET' && path === '/versions') return json({ versions: this.versions().map(summarize) });
      if (request.method === 'GET' && path.startsWith('/versions/')) {
        const v = this.version(path.slice('/versions/'.length));
        return v ? json(toVersion(v, this.roomId())) : json({ error: 'not found' }, 404);
      }
      if (request.method === 'POST' && path === '/requests') return stub ? this.stubRequest() : this.postRequest((await request.json()) as Parameters<DesignerAgent['postRequest']>[0]);
      const req = path.match(/^\/requests\/([^/]+)(\/accept|\/reject)?$/);
      if (req && request.method === 'GET' && !req[2]) return req[1] === 'stub-req-1' ? this.stubStatus() : this.getRequest(req[1]);
      const optionalBody = async () => ((await request.json().catch(() => ({}))) as Record<string, string | undefined>);
      if (req && request.method === 'POST' && req[2] === '/accept') return this.accept(req[1], await optionalBody());
      if (req && request.method === 'POST' && req[2] === '/reject') return this.reject(req[1], await optionalBody());
      if (request.method === 'POST' && path === '/undo') return this.undo();
      if (request.method === 'GET' && path === '/memory') return json({ preferences: this.preferences() });
      if (request.method === 'DELETE' && path === '/memory') {
        this.sql`DELETE FROM preferences`;
        return json({ ok: true });
      }
      return json({ error: 'not found', path }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'agent error', message: (err as Error).message }, 500);
    }
  }

  private roomId(): string {
    return this.name;
  }

  // ---------- state the headset syncs ----------

  private postState(body: RoomState): Response {
    if (!body?.room || !body.placements) return json({ error: 'state needs room, objects and placements' }, 422);
    this.sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('room_state', ${JSON.stringify(body)})`;
    const current = this.current();
    const same = current && JSON.stringify(JSON.parse(current.placements)) === JSON.stringify(body.placements);
    if (same) return json({ versionId: current.id });
    const id = mintId('ver');
    if (current) this.sql`UPDATE versions SET status = 'superseded' WHERE id = ${current.id}`;
    this.sql`INSERT INTO versions (id, parent_id, status, created_by, request_id, label, placements, created_at)
             VALUES (${id}, ${current?.id ?? null}, 'current', 'user', NULL, 'headset edit', ${JSON.stringify(body.placements)}, ${now()})`;
    return json({ versionId: id });
  }

  private roomState(): RoomState | null {
    const rows = this.sql<{ value: string }>`SELECT value FROM kv WHERE key = 'room_state'`;
    return rows.length ? (JSON.parse(rows[0].value) as RoomState) : null;
  }

  // ---------- versions ----------

  private versions(): VersionRow[] {
    return this.sql<VersionRow>`SELECT * FROM versions ORDER BY created_at DESC`;
  }

  private version(id: string): VersionRow | undefined {
    return this.sql<VersionRow>`SELECT * FROM versions WHERE id = ${id}`[0];
  }

  private current(): VersionRow | undefined {
    return this.sql<VersionRow>`SELECT * FROM versions WHERE status = 'current' ORDER BY created_at DESC LIMIT 1`[0];
  }

  /** Objects a person moved in the last minute (this version vs its parent). */
  private recentUserObjectIds(): string[] {
    const cur = this.current();
    if (!cur || cur.created_by !== 'user' || Date.now() - Date.parse(cur.created_at) > RECENT_USER_MS) return [];
    const parent = cur.parent_id ? this.version(cur.parent_id) : undefined;
    if (!parent) return []; // the first layout isn't an edit: nothing was "just placed"
    const before = new Map<string, string>((JSON.parse(parent.placements) as PlacementV1[]).map((p) => [p.placementId, JSON.stringify(p)]));
    return (JSON.parse(cur.placements) as PlacementV1[]).filter((p) => before.get(p.placementId) !== JSON.stringify(p)).map((p) => p.objectId);
  }

  // ---------- requests ----------

  postRequest(body: { text?: string; preset?: string; pins?: string[]; baseVersionId?: string; source?: string }): Response {
    if (!body.text && !body.preset) return json({ error: 'text or preset required' }, 422);
    if (body.preset && !PRESETS[body.preset]) return json({ error: `unknown preset ${body.preset}; presets are ${Object.keys(PRESETS).join(', ')}` }, 422);
    const state = this.roomState();
    if (!state) return json({ error: 'no room yet: the headset must POST /state first' }, 409);
    const active = this.sql<{ id: string }>`SELECT id FROM requests WHERE state IN ('queued','reading','planning','solving','checking')`;
    if (active.length) return json({ error: 'a request is already running', requestId: active[0].id }, 409);
    const id = mintId('req');
    const base = body.baseVersionId ?? this.current()?.id ?? 'none';
    this.sql`INSERT INTO requests (id, state, created_at, updated_at, body, log, proposal, error)
             VALUES (${id}, 'queued', ${now()}, ${now()}, ${JSON.stringify({ ...body, baseVersionId: base })}, '[]', NULL, NULL)`;
    void this.schedule(0, 'runRequest', { requestId: id });
    return json({ requestId: id }, 202);
  }

  private getRequest(id: string): Response {
    const row = this.sql<RequestRow>`SELECT * FROM requests WHERE id = ${id}`[0];
    if (!row) return json({ error: 'not found' }, 404);
    return json({ requestId: row.id, state: row.state, log: JSON.parse(row.log), proposal: row.proposal ? JSON.parse(row.proposal) : undefined, error: row.error ?? undefined });
  }

  private setRequestState(id: string, state: RequestState, message: string) {
    this.sql`UPDATE requests SET state = ${state}, updated_at = ${now()} WHERE id = ${id}`;
    this.emit('agent.status', { requestId: id, state, message });
  }

  private appendLog(id: string, entry: LogEntry) {
    const row = this.sql<{ log: string }>`SELECT log FROM requests WHERE id = ${id}`[0];
    const log = row ? (JSON.parse(row.log) as LogEntry[]) : [];
    log.push(entry);
    this.sql`UPDATE requests SET log = ${JSON.stringify(log)} WHERE id = ${id}`;
    this.emit('agent.log', { requestId: id, entry });
  }

  /** The loop, run by the scheduler right after POST /requests returned 202. */
  async runRequest(payload: { requestId: string }) {
    const id = payload.requestId;
    const row = this.sql<RequestRow>`SELECT * FROM requests WHERE id = ${id}`[0];
    if (!row) return;
    const body = JSON.parse(row.body) as { text?: string; preset?: string; pins?: string[]; baseVersionId: string };
    const state = this.roomState()!;
    const planner = this.plannerConfig();
    const startedAt = Date.now();
    try {
      const proposal = await runLoop(
        {
          roomId: this.roomId(),
          requestId: id,
          text: body.text,
          preset: body.preset,
          pins: body.pins ?? [],
          baseVersionId: body.baseVersionId,
          state,
          preferences: this.preferences(),
          recentUserObjectIds: this.recentUserObjectIds(),
        },
        {
          plan: async (facts, previous) => {
            if (!plannerConfigured(planner)) return null;
            try {
              const result = await planWithOpenAI(facts, planner, previous);
              if (result.usage) this.appendLog(id, { at: now(), kind: 'plan', message: `Planner used ${result.usage.prompt_tokens} + ${result.usage.completion_tokens} tokens.`, severity: 'info' });
              return result.plan;
            } catch (err) {
              if (err instanceof PlannerUnavailable) {
                this.appendLog(id, { at: now(), kind: 'plan', message: `Planner unavailable: ${err.message}`, severity: 'warn' });
                return null;
              }
              throw err;
            }
          },
          presetPlans: presetPlans as unknown as Record<string, Plan & { text: string }>,
          solve: (req) => this.callSolver(req, id),
          fit: (room, placements, objects) => this.callFit(room, placements, objects),
          explain: plannerConfigured(planner) ? (facts) => explainWithOpenAI(facts, planner) : undefined,
          log: (entry) => this.appendLog(id, entry),
          status: (s, message) => this.setRequestState(id, s, message),
          mintVersionId: () => mintId('ver'),
        },
      );
      this.storeProposal(id, proposal, body.baseVersionId, `${Math.round(Date.now() - startedAt)} ms`);
    } catch (err) {
      const message = err instanceof AgentFailure ? err.message : `Unexpected error: ${(err as Error).message}`;
      if (body.preset && /solver isn't reachable/.test(message)) {
        // Demo fallback (07 §4): the committed stub proposal, and say so.
        this.appendLog(id, { at: now(), kind: 'decision', message: `Solver offline: showing the built-in sample proposal for '${PRESETS[body.preset]}'.`, severity: 'warn' });
        const proposal = { ...(stubProposal as unknown as Proposal), requestId: id, versionId: mintId('ver'), baseVersionId: body.baseVersionId };
        this.storeProposal(id, proposal, body.baseVersionId, 'stub');
        return;
      }
      this.appendLog(id, { at: now(), kind: 'decision', message, severity: 'warn' });
      this.sql`UPDATE requests SET state = 'failed', error = ${message}, updated_at = ${now()} WHERE id = ${id}`;
      this.emit('agent.failed', { requestId: id, message });
    }
  }

  private storeProposal(id: string, proposal: Proposal, baseVersionId: string, took: string) {
    this.sql`INSERT INTO versions (id, parent_id, status, created_by, request_id, label, placements, created_at)
             VALUES (${proposal.versionId}, ${baseVersionId}, 'proposed', 'agent', ${id}, ${proposal.summary}, ${JSON.stringify(proposal.placements)}, ${now()})`;
    this.sql`UPDATE requests SET state = 'proposed', proposal = ${JSON.stringify(proposal)}, updated_at = ${now()} WHERE id = ${id}`;
    this.appendLog(id, { at: now(), kind: 'decision', message: `Proposal ready in ${took}.`, severity: 'info' });
    this.emit('agent.status', { requestId: id, state: 'proposed', message: 'Proposal ready.' });
    this.emit('agent.proposal', { requestId: id, proposal });
  }

  // ---------- accept / reject / undo ----------

  private accept(id: string, body: { baseVersionId?: string }): Response {
    const row = this.sql<RequestRow>`SELECT * FROM requests WHERE id = ${id}`[0];
    if (!row?.proposal) return json({ error: 'no proposal for that request' }, 404);
    const proposal = JSON.parse(row.proposal) as Proposal;
    const current = this.current();
    const base = body.baseVersionId ?? proposal.baseVersionId;
    if (current && current.id !== base && current.id !== proposal.baseVersionId) return json({ error: 'the room changed', currentVersionId: current.id }, 409);
    if (current) this.sql`UPDATE versions SET status = 'superseded' WHERE id = ${current.id}`;
    if (this.version(proposal.versionId)) this.sql`UPDATE versions SET status = 'current' WHERE id = ${proposal.versionId}`;
    else this.sql`INSERT INTO versions (id, parent_id, status, created_by, request_id, label, placements, created_at) VALUES (${proposal.versionId}, ${current?.id ?? null}, 'current', 'agent', ${id}, ${proposal.summary}, ${JSON.stringify(proposal.placements)}, ${now()})`;
    const state = this.roomState();
    if (state) this.sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('room_state', ${JSON.stringify({ ...state, placements: proposal.placements })})`;
    this.emit('version.current', { versionId: proposal.versionId, createdBy: 'agent', requestId: id });
    return json({ versionId: proposal.versionId });
  }

  private reject(id: string, body: { reason?: string }): Response {
    const row = this.sql<RequestRow>`SELECT * FROM requests WHERE id = ${id}`[0];
    if (!row) return json({ error: 'not found' }, 404);
    this.sql`UPDATE requests SET state = 'failed', error = 'rejected', updated_at = ${now()} WHERE id = ${id}`;
    if (body.reason) {
      this.remember(body.reason, { id: 'reject', type: 'pin', priority: 'should', weight: 2, why: body.reason }, 'request');
    }
    return json({ ok: true });
  }

  private undo(): Response {
    const current = this.current();
    if (!current?.parent_id) return json({ error: 'nothing to undo' }, 409);
    const parent = this.version(current.parent_id);
    if (!parent) return json({ error: 'the previous version is gone' }, 409);
    this.sql`UPDATE versions SET status = 'superseded' WHERE id = ${current.id}`;
    this.sql`UPDATE versions SET status = 'current' WHERE id = ${parent.id}`;
    const state = this.roomState();
    const placements = JSON.parse(parent.placements) as PlacementV1[];
    if (state) this.sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('room_state', ${JSON.stringify({ ...state, placements })})`;
    if (current.created_by === 'agent') {
      // Learn from the undo: prefer leaving what the agent moved where it was.
      const before = new Map(placements.map((p) => [p.placementId, JSON.stringify(p)]));
      const moved = (JSON.parse(current.placements) as PlacementV1[]).filter((p) => before.get(p.placementId) !== JSON.stringify(p));
      for (const p of moved) {
        const name = state?.objects[p.objectId]?.name ?? p.objectId;
        this.remember(`Person undid moving the ${name}: prefer leaving it in place`, { id: `undo:${p.objectId}`, type: 'pin', a: p.objectId, priority: 'should', weight: 3, why: 'undone before' }, 'undo');
      }
    }
    this.emit('version.current', { versionId: parent.id, createdBy: parent.created_by });
    return json({ versionId: parent.id });
  }

  // ---------- memory ----------

  private preferences(): Preference[] {
    return this.sql<{ id: string; text: string; rule: string; source: string; created_at: string }>`SELECT * FROM preferences ORDER BY created_at`
      .map((r) => ({ id: r.id, text: r.text, rule: JSON.parse(r.rule), source: r.source as Preference['source'], createdAt: r.created_at }));
  }

  private remember(text: string, rule: Preference['rule'], source: Preference['source']) {
    this.sql`INSERT INTO preferences (id, text, rule, source, created_at) VALUES (${mintId('pref')}, ${text}, ${JSON.stringify(rule)}, ${source}, ${now()})`;
  }

  // ---------- tools ----------

  private plannerConfig(): PlannerConfig {
    return { apiKey: this.env.OPENAI_API_KEY, model: this.env.OPENAI_MODEL, gatewayUrl: this.env.AI_GATEWAY_URL || undefined, gatewayToken: this.env.CF_AIG_TOKEN };
  }

  private async callSolver(req: SolverRequest, requestId: string): Promise<SolverResponse> {
    const res = await fetch(`${this.env.SOLVER_URL.replace(/\/$/, '')}/solve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Solver-Key': this.env.SOLVER_KEY ?? 'dev-solver-key', 'X-Request-Id': requestId },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(SOLVER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`solver answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  private async callFit(room: Record<string, unknown>, placements: PlacementV1[], objects: Record<string, { w: number; h: number; d: number }>): Promise<FitReport> {
    const res = await fetch(`${this.env.FIT_URL.replace(/\/$/, '')}/fit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room, placements, objects }),
      signal: AbortSignal.timeout(SOLVER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`fit answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  private async health(): Promise<Response> {
    let solver: 'online' | 'offline' = 'offline';
    let detail = '';
    try {
      const res = await fetch(`${this.env.SOLVER_URL.replace(/\/$/, '')}/health`, { headers: { 'X-Solver-Key': this.env.SOLVER_KEY ?? 'dev-solver-key' }, signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        solver = 'online';
        detail = `OR-Tools ${((await res.json()) as { ortools?: string }).ortools ?? ''}`;
      } else detail = `solver answered ${res.status}`;
    } catch (err) {
      detail = (err as Error).message;
    }
    this.sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('solver_health', ${solver})`;
    return json({ solver, detail, planner: plannerConfigured(this.plannerConfig()) ? 'configured' : 'offline (presets use built-in plans)', model: this.env.OPENAI_MODEL ?? null });
  }

  // ---------- live events (SSE) ----------

  private events(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.streams.add(writer);
    void writer.write(new TextEncoder().encode(`event: hello\ndata: ${JSON.stringify({ roomId: this.roomId(), currentVersionId: this.current()?.id ?? null })}\n\n`));
    return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
  }

  private emit(event: string, data: unknown) {
    const chunk = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const w of this.streams) {
      w.write(chunk).catch(() => {
        this.streams.delete(w);
      });
    }
  }

  // ---------- the stub (X-Stub: 1) ----------

  private stubRequest(): Response {
    this.stubStarted.set('stub-req-1', Date.now());
    return json({ requestId: 'stub-req-1' }, 202);
  }

  private stubStatus(): Response {
    const started = this.stubStarted.get('stub-req-1') ?? Date.now();
    const steps = demoTimeline.steps;
    const index = Math.min(Math.floor((Date.now() - started) / 1000), steps.length - 1);
    const shown = steps.slice(0, index + 1);
    const last = shown[shown.length - 1];
    const done = index === steps.length - 1;
    return json({
      requestId: 'stub-req-1',
      state: last.state,
      message: last.message,
      log: shown.map((s) => ({ at: now(), ...s.log })),
      proposal: done ? { ...(stubProposal as unknown as Proposal), requestId: 'stub-req-1' } : undefined,
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mintId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function summarize(v: VersionRow) {
  return { versionId: v.id, label: v.label, createdAt: v.created_at, parentId: v.parent_id, status: v.status, createdBy: v.created_by, requestId: v.request_id };
}

function toVersion(v: VersionRow, roomId: string): VersionV1 {
  return {
    schemaVersion: 1,
    versionId: v.id,
    roomId,
    parentId: v.parent_id,
    parentVersionId: v.parent_id,
    label: v.label,
    createdAt: v.created_at,
    placements: JSON.parse(v.placements),
    materials: {},
    contentHash: '',
    status: v.status as VersionV1['status'],
    createdBy: v.created_by as VersionV1['createdBy'],
    requestId: v.request_id ?? undefined,
  };
}
