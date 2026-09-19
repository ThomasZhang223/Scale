import { contentHash } from "./ids";
import { meshDispatcher } from "./mesh-dispatch";
import type { CatalogItem } from "./catalog-ingest";

export interface MeshMessage {
  jobId?: string;
  roomId?: string | null;
  objectId: string;
  tier: "live" | "quality";
  apiOrigin: string;
  catalog?: CatalogItem;
}

/** Queue delivery is at least once; a redelivery must reuse the job and Workflow. */
export async function consumeMeshJobs(batch: MessageBatch<MeshMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const { objectId, tier, apiOrigin } = message.body;
      const hash = await contentHash([batch.queue, message.id]);
      const jobId = message.body.jobId ?? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const at = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO jobs (id, object_id, kind, tier, state, progress_pct, error, created_at, updated_at)
         VALUES (?, ?, 'mesh', ?, 'queued', 0, NULL, ?, ?) ON CONFLICT(id) DO NOTHING`,
      ).bind(jobId, objectId, tier, at, at).run();
      const response = await meshDispatcher(env).fetch("https://dispatcher/enqueue", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...message.body, jobId, objectId, tier, apiOrigin, roomId: message.body.roomId ?? null }),
      });
      if (!response.ok) throw new Error(`Mesh admission failed: ${response.status}`);
      await env.DB.prepare("UPDATE mesh_outbox SET delivered_at = ? WHERE job_id = ?")
        .bind(new Date().toISOString(), jobId).run();
      message.ack();
    } catch (error) {
      console.error("mesh_queue_delivery_failed", message.id, String(error));
      message.retry();
    }
  }
}
