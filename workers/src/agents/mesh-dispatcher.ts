import { DurableObject } from "cloudflare:workers";
import type { GenerateMeshParams } from "../workflows/generate-mesh";

/** A single durable admission slot across ALL mesh workflows, including their retries. */
export class MeshDispatcher extends DurableObject<Env> {
  private draining: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/enqueue") {
      const params = await request.json() as GenerateMeshParams;
      await this.ctx.storage.transaction(async (tx) => {
        if (await tx.get(`seen:${params.jobId}`)) return;
        const sequence = ((await tx.get<number>("sequence")) ?? 0) + 1;
        await tx.put("sequence", sequence);
        await tx.put(`pending:${String(sequence).padStart(16, "0")}`, params);
        await tx.put(`seen:${params.jobId}`, true);
        if (await tx.getAlarm() === null) await tx.setAlarm(Date.now());
      });
    } else if (path === "/complete") {
      const { jobId } = await request.json() as { jobId: string };
      await this.ctx.storage.put(`finishing:${jobId}`, Date.now() + 5000);
      await this.ctx.storage.setAlarm(Date.now());
    } else {
      // Cron is a recovery watchdog if an alarm exhausts its platform retries.
      await this.ctx.storage.setAlarm(Date.now());
    }
    // Await a serialized admission attempt; network awaits must not let fetch
    // and alarm race to occupy different slots in the same object instance.
    await this.alarm();
    return Response.json({ accepted: true });
  }

  async alarm(): Promise<void> {
    const attempt = this.draining.then(() => this.drain());
    this.draining = attempt.catch(() => {});
    return attempt;
  }

  private async drain(): Promise<void> {
    // Persist the next wakeup before making network calls or starting a workflow.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    let active = await this.ctx.storage.get<GenerateMeshParams>("active");
    if (active) {
      const instance = await this.env.GENERATE_MESH.get(active.jobId);
      const status = await instance.status();
      if (!["complete", "errored", "terminated"].includes(status.status)) {
        // The final callback precedes the platform's terminal status by a few
        // ticks. Never release the slot early or assume inference was cancelled.
        const until = await this.ctx.storage.get<number>(`finishing:${active.jobId}`);
        if (until && until > Date.now()) await this.ctx.storage.setAlarm(Date.now() + 250);
        return;
      }
      if (status.status !== "complete") {
        await this.env.DB.prepare(
          "UPDATE jobs SET state = 'failed', error = COALESCE(error, ?), updated_at = ? WHERE id = ? AND state != 'done'",
        ).bind(`Workflow ${status.status}`, new Date().toISOString(), active.jobId).run();
      }
      await this.ctx.storage.delete("active");
      await this.ctx.storage.delete(`finishing:${active.jobId}`);
      active = undefined;
    }
    const pending = await this.ctx.storage.list<GenerateMeshParams>({ prefix: "pending:" });
    // Preserve FIFO within each class, including pre-upgrade pending keys.
    const ordered = [...pending.entries()];
    const next = ordered.find(([, p]) => p.tier === "live" && !p.catalog) ?? ordered[0];
    if (!next) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const [key, params] = next;
    // Missing configuration must not fail every accepted catalogue job.
    if (!this.env.BASETEN_URL || !this.env.BASETEN_API_KEY) return;
    // Do not consume the pending entry until create (or an existing instance) is proven.
    try {
      await this.env.GENERATE_MESH.create({ id: params.jobId, params });
    } catch (error) {
      try {
        const instance = await this.env.GENERATE_MESH.get(params.jobId);
        await instance.status();
      } catch {
        throw error;
      }
    }
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put("active", params);
      await tx.delete(key);
    });
  }
}
