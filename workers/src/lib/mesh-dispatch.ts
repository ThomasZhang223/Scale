import type { GenerateMeshParams } from "../workflows/generate-mesh";

export function meshDispatcher(env: Env) {
  return env.MESH_DISPATCHER.get(env.MESH_DISPATCHER.idFromName("global"));
}

/** D1 is the outbox: an unavailable Queue never loses an accepted job. */
export async function enqueueMesh(env: Env, params: GenerateMeshParams): Promise<void> {
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO jobs
      (id, object_id, kind, tier, state, progress_pct, error, created_at, updated_at)
      VALUES (?, ?, 'mesh', ?, 'queued', 0, NULL, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(params.jobId, params.objectId, params.tier, at, at),
    env.DB.prepare(`INSERT INTO mesh_outbox (job_id, params_json, created_at)
      VALUES (?, ?, ?) ON CONFLICT(job_id) DO NOTHING`)
      .bind(params.jobId, JSON.stringify(params), at),
  ]);
}

/** Cron retries delivery until the consumer has durably handed the job to the dispatcher. */
export async function relayMeshOutbox(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT params_json FROM mesh_outbox WHERE delivered_at IS NULL ORDER BY rowid LIMIT 100",
  ).all<{ params_json: string }>();
  // Bound each batch by bytes as well as count, without 100 service calls per cron.
  let batch: { body: GenerateMeshParams }[] = [];
  let bytes = 0;
  for (const row of results) {
    const size = new TextEncoder().encode(row.params_json).length;
    if (batch.length && bytes + size > 200_000) {
      await env.JOB_QUEUE.sendBatch(batch); batch = []; bytes = 0;
    }
    batch.push({ body: JSON.parse(row.params_json) }); bytes += size;
  }
  if (batch.length) await env.JOB_QUEUE.sendBatch(batch);
  const response = await meshDispatcher(env).fetch("https://dispatcher/tick", { method: "POST" });
  if (!response.ok) throw new Error(`Mesh dispatcher tick: ${response.status}`);
}
