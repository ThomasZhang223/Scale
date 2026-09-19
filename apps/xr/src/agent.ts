import type { PlacementV1 } from './api';

/*
 * Talking to the designer agent (docs/agent/04_HEADSET.md): a small state machine the
 * wrist palette and the laptop panel both drive. It sends a request, listens on the
 * agent's SSE feed and polls once a second while working (both deliver the same objects;
 * duplicates are dropped), then holds the proposal until Accept / Reject / Ask again.
 * Every outside call goes through `fetch` and `openEvents`, so it runs under Node tests.
 */

export type AgentUIState = 'idle' | 'working' | 'proposed' | 'applying' | 'failed' | 'room_changed';

export interface LogEntry {
  at: string;
  kind: 'data' | 'plan' | 'solve' | 'fit' | 'retry' | 'memory' | 'decision';
  message: string;
  severity: 'info' | 'warn';
}

export interface Proposal {
  requestId: string;
  versionId: string;
  baseVersionId: string;
  summary: string;
  explanation: string;
  tradeoffs: string[];
  moves: { objectId: string; from: PlacementV1; to: PlacementV1 }[];
  placements: PlacementV1[];
  fit: { red: number; amber: number };
  unsatisfied: { ruleId: string; why: string }[];
}

export interface RoomStateUpload {
  room: Record<string, unknown>;
  objects: Record<string, { name: string; category: string; bboxMeters: { w: number; h: number; d: number }; source: 'scan' | 'box' | 'local'; confidence?: string; detectedDims?: [number, number, number] }>;
  placements: PlacementV1[];
  fitReport?: unknown;
}

export interface AgentRequest {
  text?: string;
  preset?: string;
  pins: string[];
}

export const PRESETS: { id: string; label: string }[] = [
  { id: 'tidy_room', label: 'Rearrange' },
  { id: 'cozy', label: 'Cozy' },
  { id: 'spacious', label: 'Spacious' },
  { id: 'modern', label: 'Modern' },
  { id: 'social', label: 'Social' },
  { id: 'reading_corner', label: 'Reading corner' },
  { id: 'open_floor', label: 'Open up the floor' },
  { id: 'clear_door', label: 'Clear the door' },
  { id: 'face_window', label: 'Face the window' },
];

export interface AgentSnapshot {
  state: AgentUIState;
  status: string;
  log: LogEntry[];
  proposal: Proposal | null;
  error: string | null;
  currentVersionId: string | null;
  offline: boolean;
  solver: 'online' | 'offline' | 'unknown';
}

interface Options {
  roomId: string;
  base?: string; // /v1/agent
  stub?: boolean;
  fetch?: typeof fetch;
  /** Opens the SSE feed; returns a closer. Injected so tests can drive events by hand. */
  openEvents?: (url: string, on: (event: string, data: unknown) => void) => () => void;
  /** The built-in proposal for when the server is down. */
  offlineProposal?: Proposal;
  onChange?: (snapshot: AgentSnapshot) => void;
}

export class AgentClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private snap: AgentSnapshot = { state: 'idle', status: '', log: [], proposal: null, error: null, currentVersionId: null, offline: false, solver: 'unknown' };
  private requestId: string | null = null;
  private lastRequest: AgentRequest | null = null;
  private closeEvents: (() => void) | null = null;
  private seen = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly opts: Options;

  constructor(opts: Options) {
    this.opts = opts;
    this.base = `${opts.base ?? '/v1/agent'}/${encodeURIComponent(opts.roomId)}`;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  get snapshot(): AgentSnapshot {
    return this.snap;
  }

  private set(patch: Partial<AgentSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.opts.onChange?.(this.snap);
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.opts.stub ? { 'X-Stub': '1' } : {}) };
  }

  // ---------- state sync ----------

  /** Tells the agent what's in the room. Resolves to the current version id (or null offline). */
  async syncState(state: RoomStateUpload): Promise<string | null> {
    try {
      const res = await this.fetchFn(`${this.base}/state`, { method: 'POST', headers: this.headers(), body: JSON.stringify(state) });
      if (!res.ok) throw new Error(`${res.status}`);
      const { versionId } = (await res.json()) as { versionId: string };
      this.set({ currentVersionId: versionId, offline: false });
      return versionId;
    } catch {
      this.set({ offline: true });
      return null;
    }
  }

  async health(): Promise<AgentSnapshot['solver']> {
    try {
      const res = await this.fetchFn(`${this.base}/health`, { headers: this.headers() });
      const { solver } = (await res.json()) as { solver: 'online' | 'offline' };
      this.set({ solver, offline: false });
      return solver;
    } catch {
      this.set({ solver: 'unknown', offline: true });
      return 'unknown';
    }
  }

  // ---------- a request ----------

  async request(req: AgentRequest): Promise<void> {
    if (this.snap.state === 'working' || this.snap.state === 'applying') return;
    this.lastRequest = req;
    this.seen.clear();
    this.set({ state: 'working', status: 'Sending…', log: [], proposal: null, error: null });
    try {
      const res = await this.fetchFn(`${this.base}/requests`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ...req, baseVersionId: this.snap.currentVersionId ?? undefined, source: 'headset' }),
      });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string };
        this.set({ state: 'failed', status: body.error ?? 'Busy', error: body.error ?? 'The agent is busy with another request.' });
        return;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      const { requestId } = (await res.json()) as { requestId: string };
      this.requestId = requestId;
      this.set({ status: 'Reading room…', offline: false });
      this.listen();
      this.schedulePoll(0);
    } catch {
      this.offlineFallback();
    }
  }

  private offlineFallback() {
    const proposal = this.opts.offlineProposal;
    if (!proposal) {
      this.set({ state: 'failed', status: 'Offline', error: 'The agent isn’t reachable.', offline: true });
      return;
    }
    this.requestId = proposal.requestId;
    this.set({ state: 'proposed', status: 'Offline: showing the sample proposal', proposal, offline: true, log: [{ at: new Date().toISOString(), kind: 'decision', message: 'Offline: showing the sample proposal.', severity: 'warn' }] });
  }

  private listen() {
    this.closeEvents?.();
    this.closeEvents = this.opts.openEvents?.(`${this.base}/events`, (event, data) => this.handleEvent(event, data)) ?? null;
  }

  private schedulePoll(delayMs: number) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delayMs);
  }

  /** One poll of GET .../requests/{id}. Public so tests can drive it without timers. */
  async poll(): Promise<void> {
    if (this.snap.state !== 'working' || !this.requestId) return;
    try {
      const res = await this.fetchFn(`${this.base}/requests/${this.requestId}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { state: string; message?: string; log: LogEntry[]; proposal?: Proposal; error?: string };
      for (const entry of body.log ?? []) this.addLog(entry);
      if (body.message) this.set({ status: body.message });
      if (body.state === 'proposed' && body.proposal) return this.handleEvent('agent.proposal', { requestId: this.requestId, proposal: body.proposal });
      if (body.state === 'failed') return this.handleEvent('agent.failed', { requestId: this.requestId, message: body.error ?? 'The request failed.' });
      this.set({ status: statusLine(body.state) });
    } catch {
      // A missed poll isn't fatal: the feed or the next poll will catch up.
    }
    if (this.snap.state === 'working') this.schedulePoll(1000);
  }

  /** Shared by the SSE feed and polling: idempotent by request id and log entry. */
  handleEvent(event: string, data: unknown) {
    const d = data as { requestId?: string; state?: string; message?: string; entry?: LogEntry; proposal?: Proposal; versionId?: string };
    if (event === 'version.current' && d.versionId) {
      this.set({ currentVersionId: d.versionId });
      return;
    }
    if (d.requestId && d.requestId !== this.requestId) return;
    if (event === 'agent.status' && d.message) this.set({ status: d.message });
    if (event === 'agent.log' && d.entry) this.addLog(d.entry);
    if (event === 'agent.proposal' && d.proposal && this.snap.state === 'working') {
      this.stopWaiting();
      this.set({ state: 'proposed', status: 'Proposal ready', proposal: d.proposal });
    }
    if (event === 'agent.failed' && this.snap.state === 'working') {
      this.stopWaiting();
      this.set({ state: 'failed', status: 'Failed', error: d.message ?? 'The request failed.' });
    }
  }

  private addLog(entry: LogEntry) {
    const key = `${entry.at}|${entry.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.set({ log: [...this.snap.log, entry] });
  }

  private stopWaiting() {
    clearTimeout(this.pollTimer);
    this.closeEvents?.();
    this.closeEvents = null;
  }

  // ---------- accept / reject / undo ----------

  /** Resolves to the proposal to apply, or null (rejected by the server: room changed, offline). */
  async accept(): Promise<Proposal | null> {
    const proposal = this.snap.proposal;
    if (this.snap.state !== 'proposed' || !proposal) return null;
    if (this.snap.offline) {
      this.set({ state: 'applying', status: 'Applying (offline)…' });
      return proposal;
    }
    try {
      const res = await this.fetchFn(`${this.base}/requests/${proposal.requestId}/accept`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ baseVersionId: proposal.baseVersionId }) });
      if (res.status === 409) {
        const body = (await res.json()) as { currentVersionId?: string };
        this.set({ state: 'room_changed', status: 'The room changed. Ask again?', currentVersionId: body.currentVersionId ?? this.snap.currentVersionId });
        return null;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      const { versionId } = (await res.json()) as { versionId: string };
      this.set({ state: 'applying', status: 'Applying…', currentVersionId: versionId });
      return proposal;
    } catch (err) {
      this.set({ state: 'failed', status: 'Accept failed', error: (err as Error).message });
      return null;
    }
  }

  /** Called by whoever applied the proposal, once objects have settled. */
  applied() {
    if (this.snap.state === 'applying') this.set({ state: 'idle', status: 'Done. Undo is on the wrist.', proposal: null });
  }

  async reject(reason?: string): Promise<void> {
    const proposal = this.snap.proposal;
    this.stopWaiting();
    this.set({ state: 'idle', status: '', proposal: null });
    if (!proposal || this.snap.offline) return;
    await this.fetchFn(`${this.base}/requests/${proposal.requestId}/reject`, { method: 'POST', headers: this.headers(), body: JSON.stringify(reason ? { reason } : {}) }).catch(() => {});
  }

  /** After a 409: the same request again on the new version. */
  async askAgain(): Promise<void> {
    if (!this.lastRequest) return;
    this.set({ state: 'idle' });
    await this.request(this.lastRequest);
  }

  /** Resolves to the restored version id, or null. */
  async undo(): Promise<string | null> {
    try {
      const res = await this.fetchFn(`${this.base}/undo`, { method: 'POST', headers: this.headers() });
      if (!res.ok) return null;
      const { versionId } = (await res.json()) as { versionId: string };
      this.set({ currentVersionId: versionId, status: 'Previous layout restored.' });
      return versionId;
    } catch {
      return null;
    }
  }

  /** A stored layout from the agent's history (used after undo). */
  async version(versionId: string): Promise<{ versionId: string; placements: PlacementV1[] } | null> {
    try {
      const res = await this.fetchFn(`${this.base}/versions/${versionId}`, { headers: this.headers() });
      if (!res.ok) return null;
      return (await res.json()) as { versionId: string; placements: PlacementV1[] };
    } catch {
      return null;
    }
  }

  reset() {
    this.stopWaiting();
    this.set({ state: 'idle', status: '', proposal: null, error: null });
  }
}

function statusLine(state: string): string {
  return { queued: 'Queued…', reading: 'Reading room…', planning: 'Planning…', solving: 'Solving…', checking: 'Checking fit…', proposed: 'Proposal ready', failed: 'Failed' }[state] ?? state;
}

/** Browser EventSource as the feed; tests inject their own. */
export function browserEvents(url: string, on: (event: string, data: unknown) => void): () => void {
  const source = new EventSource(url);
  for (const name of ['agent.status', 'agent.log', 'agent.proposal', 'agent.failed', 'version.current']) {
    source.addEventListener(name, (e) => on(name, JSON.parse((e as MessageEvent).data)));
  }
  return () => source.close();
}
