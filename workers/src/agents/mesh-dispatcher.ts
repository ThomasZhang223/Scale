import { DurableObject } from "cloudflare:workers";
import type { GenerateMeshParams } from "../workflows/generate-mesh";

/** A single durable admission slot across ALL mesh workflows, including their retries. */
export class MeshDispatcher extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/enqueue") {
      const params = await request.json() as GenerateMeshParams;
      await this.ctx.storage.transaction(async (tx) => {
        if (await tx.get(`seen:${params.jobId}`)) return;
        const sequence = ((await tx.get<number>("sequence")) ?? 0) + 1;
        await tx.put("sequence", sequence);
        await tx.put(`pending:${String(sequence).padStart(16, "0")}`, params);
        await tx.put(`seen:${params.jobId}`, true);
        if (await tx.getAlarm() === null) await tx.setAlarm(Date.now() + 1000);
      });
    } else {
      // Cron is a recovery watchdog if an alarm exhausts its platform retries.
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    return Response.json({ accepted: true });
  }

  async alarm(): Promise<void> {
    // Persist the next wakeup before making network calls or starting a workflow.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    let active = await this.ctx.storage.get<GenerateMeshParams>("active");
    if (active) {
      const instance = await this.env.GENERATE_MESH.get(active.jobId);
      const status = await instance.status();
      if (!["complete", "errored", "terminated"].includes(status.status)) return;
      if (status.status !== "complete") {
        await this.env.DB.prepare(
          "UPDATE jobs SET state = 'failed', error = COALESCE(error, ?), updated_at = ? WHERE id = ? AND state != 'done'",
        ).bind(`Workflow ${status.status}`, new Date().toISOString(), active.jobId).run();
      }
      await this.ctx.storage.delete("active");
      active = undefined;
    }
    const pending = await this.ctx.storage.list<GenerateMeshParams>({ prefix: "pending:", limit: 1 });
    const next = pending.entries().next().value;
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
