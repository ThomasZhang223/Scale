// Ani's image-to-3D pipeline, as a Cloudflare Workflow.
//
// Why a Workflow and not a plain async call: generation takes 10-20 seconds against a GPU
// endpoint that can cold-start or fail, and the phone is polling GET /v1/jobs/{id} the whole
// time. A Workflow gives three things that would otherwise be hand-rolled: every step is
// retried on its own with backoff, a step's wall-clock time is unlimited on the free plan so a
// 20-second inference call is legal, and the instance id IS the job id, so there is no separate
// job-state machine to keep in sync with reality.
//
// Free-plan budget: 1,024 steps per instance, 100 concurrent instances. This uses six steps.
// Queue delivery is retriable, but its concurrency cap does not bound running Workflows.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
// NonRetryableError lives in cloudflare:workflows, not cloudflare:workers.
import { NonRetryableError } from "cloudflare:workflows";
import { R2Keys } from "../lib/keys";
import { nowIso } from "../lib/ids";
import { advanceJob, markObjectFailed, markObjectReady, insertObject, getObject } from "../lib/store";
import type { CatalogItem } from "../lib/catalog-ingest";
import { emitToRoom } from "../lib/notify";
import { indexObject } from "../lib/embedding";
import { notifyMeshFinished } from "../lib/mesh-dispatch";

export interface GenerateMeshParams {
  jobId: string;
  objectId: string;
  tier: "live" | "quality";
  /** Origin of the API, so Baseten can fetch the frame by URL rather than by upload. */
  apiOrigin: string;
  /** Room to notify over SSE when the mesh lands. Null for a catalog pre-bake with no room. */
  roomId: string | null;
  catalog?: CatalogItem;
}

interface ObjectMeta {
  objectId: string;
  source: string;
  bboxMeters: { w: number; h: number; d: number };
  frameKeys: string[];
  name: string;
  category: string;
}

/** What the Baseten endpoint returns. Both shapes are accepted — see the `generate` step. */
interface BasetenResult {
  /** Set when the Truss wrote the mesh to R2 itself. Preferred: one network hop, not three. */
  glbKey?: string;
  /** Set when the Truss returns the bound mesh inline, base64 encoded. */
  glbBase64?: string;
  caption?: string;
  palette?: string[];
}

export class GenerateMeshWorkflow extends WorkflowEntrypoint<Env, GenerateMeshParams> {
  async run(event: Readonly<WorkflowEvent<GenerateMeshParams>>, step: WorkflowStep) {
    const p = event.payload;

    try {
      let catalogFrameKey: string | null = null;
      if (p.catalog) {
        const prepared = await step.do("prepare-catalog-image", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" }, async () => {
          const item = p.catalog!;
          const res = await fetch(item.imageUrl, { signal: AbortSignal.timeout(60_000) });
          if (!res.ok) throw new Error(`Catalogue image returned ${res.status}`);
          const mime = res.headers.get("content-type")?.split(";")[0];
          if (mime !== "image/jpeg" && mime !== "image/png") throw new NonRetryableError("Catalogue image must be JPEG or PNG.");
          const reader = res.body!.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new NonRetryableError("Catalogue image exceeds 10 MiB."); }
            chunks.push(value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          const key = `objects/${p.objectId}/frames/0.${mime === "image/png" ? "png" : "jpg"}`;
          await this.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
          await this.env.BUCKET.put(`objects/${p.objectId}/catalog.json`, JSON.stringify(item), { httpMetadata: { contentType: "application/json" } });
          await insertObject(this.env, { ...item, source: "catalog", state: "generating", createdAt: nowIso() });
          return { key };
        });
        catalogFrameKey = prepared.key;
      }
      const meta = await step.do(
        "load-object",
        // D1 can hiccup, so two tries. Everything *inside* that is deterministic throws
        // NonRetryableError instead: a missing object and a missing frame never become
        // present by waiting, and a step that keeps retrying leaves the job row on "running"
        // while the phone polls it forever.
        { retries: { limit: 2, delay: "2 seconds", backoff: "constant" }, timeout: "30 seconds" },
        async (): Promise<ObjectMeta> => {
        await advanceJob(this.env, p.jobId, "running", 5, null, nowIso());
        const row = await this.env.DB.prepare(
          "SELECT id, source, name, category, bbox_w, bbox_h, bbox_d FROM objects WHERE id = ?",
        )
          .bind(p.objectId)
          .first<{
            id: string;
            source: string;
            name: string | null;
            category: string | null;
            bbox_w: number;
            bbox_h: number;
            bbox_d: number;
          }>();
        if (!row) throw new NonRetryableError(`Object ${p.objectId} does not exist.`);

        // Frames were uploaded to objects/{objectId}/frames/{n}.jpg. List rather than assume a
        // count: the phone decides how many frames it took, and a catalog product has one.
        const listed = await this.env.BUCKET.list({ prefix: `objects/${p.objectId}/frames/` });
        const frameKeys = catalogFrameKey ? [catalogFrameKey] : listed.objects.map((o) => o.key).sort();
        if (frameKeys.length === 0) {
          throw new NonRetryableError(
            `No frames at objects/${p.objectId}/frames/. Upload at least one before generating.`,
          );
        }
        return {
          objectId: row.id,
          source: row.source,
          bboxMeters: { w: row.bbox_w, h: row.bbox_h, d: row.bbox_d },
          frameKeys,
          name: row.name ?? "",
          category: row.category ?? "",
        };
      },
    );

      // ceiling: the first frame by key order, not the clearest silhouette. Ani's workstream
      // says Stable Fast 3D takes ONE best clean image, never a multi-view set, and picking
      // that frame properly needs a sharpness and occlusion score over the whole sweep. The
      // upgrade path is a scoring pass here; a catalog product has one frame either way.
      const frameUrl = `${p.apiOrigin}/v1/assets/${meta.frameKeys[0]}`;

      const generated = await step.do(
        "baseten-generate",
        // Retrying an ambiguous paid prediction can generate and charge twice.
        { retries: { limit: 0, delay: "5 seconds" }, timeout: "5 minutes" },
        async (): Promise<BasetenResult> => {
          await advanceJob(this.env, p.jobId, "running", 25, null, nowIso());

          const url = this.env.BASETEN_URL;
          if (!url) {
            // Standing rule 4. There is no second endpoint to fall back to, and guessing one
            // would fail at the demo rather than here, where the message can name the fix.
            throw new NonRetryableError(
              "BASETEN_URL is not set. Run: npx wrangler secret put BASETEN_URL (and BASETEN_API_KEY).",
            );
          }

          const res = await fetch(url, {
            signal: AbortSignal.timeout(240_000),
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.env.BASETEN_API_KEY
                ? { authorization: `Api-Key ${this.env.BASETEN_API_KEY}` }
                : {}),
            },
            body: JSON.stringify({
              // The scale binding happens exactly once, in Ani's component. We send the
              // measured box and he binds to it. Nothing downstream ever rescales a GLB.
              tier: p.tier,
              image_url: frameUrl,
              bbox_meters: meta.bboxMeters,
              object_id: p.objectId,
              source: meta.source,
              // Where to put the result if the Truss writes to R2 itself.
              upload_url: `${p.apiOrigin}/v1/uploads`,
              want_embedding: false, // The dedicated encoder below owns both image and text vectors.
            }),
          });
          if (!res.ok) {
            throw new Error(`Baseten returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
          }
          const generated = (await res.json()) as BasetenResult & { kind?: string; glb_base64?: string; artifact?: Record<string, unknown> };
          if (generated.kind === "raw_sf3d_unscaled" || generated.glb_base64) {
            throw new NonRetryableError("BASETEN_URL points to raw SF3D. Configure the dimension-binding generation adapter; raw unscaled output cannot be marked ready.");
          }
          // Workflow step results are limited to 1 MiB. Persist the GLB here and
          // checkpoint only its key; a multi-megabyte base64 result cannot be a step result.
          const key = R2Keys.objectMesh(p.objectId);
          if (generated.glbBase64) {
            const bytes = base64ToBytes(generated.glbBase64);
            assertGlb(bytes);
            await this.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "model/gltf-binary" } });
            generated.glbKey = key;
          }
          if (generated.glbKey !== key) throw new NonRetryableError("Generation must return this object's mesh key or glbBase64.");
          if (generated.artifact) await this.env.BUCKET.put(`objects/${p.objectId}/mesh-receipt.json`, JSON.stringify(generated.artifact), { httpMetadata: { contentType: "application/json" } });
          return { glbKey: key, caption: generated.caption, palette: generated.palette };
        },
      );

      const glbKey = await step.do("store-mesh", async (): Promise<string> => {
        await advanceJob(this.env, p.jobId, "running", 65, null, nowIso());
        const key = R2Keys.objectMesh(p.objectId);

        // Two accepted shapes, because where the binding runs is Ani's call and it may move.
        // If the Truss binds on the GPU box it writes R2 directly and reports the key, which
        // is one network hop instead of three. If it returns the mesh inline, we store it.
        if (generated.glbKey) {
          const stored = await this.env.BUCKET.get(generated.glbKey, { range: { offset: 0, length: 20 } });
          if (!stored) {
            throw new Error(
              `Baseten reported key ${generated.glbKey} but nothing is stored there.`,
            );
          }
          assertGlb(new Uint8Array(await stored.arrayBuffer()), stored.size);
          return generated.glbKey;
        }

        if (!generated.glbBase64) {
          throw new NonRetryableError("Baseten returned neither glbKey nor glbBase64.");
        }
        const bytes = base64ToBytes(generated.glbBase64);
        // A glTF binary always starts with the magic 'glTF'. Catching a JSON error page here
        // is worth four lines: the alternative is Justin debugging his own loader for an hour.
        if (bytes.length < 12 || String.fromCharCode(...bytes.slice(0, 4)) !== "glTF") {
          throw new NonRetryableError("Baseten returned data that is not a binary glTF.");
        }
        await this.env.BUCKET.put(key, bytes, {
          httpMetadata: { contentType: "model/gltf-binary" },
        });
        return key;
      });

      await step.do("finalize", async () => {
        await markObjectReady(this.env, p.objectId, {
          glbKey,
          caption: generated.caption ?? null,
          palette: generated.palette ?? null,
        });
        await advanceJob(this.env, p.jobId, "done", 100, null, nowIso());

        // The perceived-latency contract closes here: the phone has been showing a measured
        // box with real numbers since second one, and this is the event that swaps in the mesh.
        if (p.roomId) {
          await emitToRoom(this.env, p.roomId, "object", await getObject(this.env, p.objectId, p.apiOrigin));
        }
        return { ok: true };
      });

      const indexing = await step.do("index-embedding", { retries: { limit: 2, delay: "5 seconds" }, timeout: "45 seconds" }, async (): Promise<{ indexed: boolean; error: string | null }> => {
        await indexObject(this.env, {
          objectId: p.objectId,
          source: meta.source,
          category: meta.category,
          bboxMeters: meta.bboxMeters,
          dominantHex: generated.palette?.[0] ?? null,
          imageKey: meta.frameKeys[0],
        });
        return { indexed: true, error: null };
      }).catch((error: unknown) => ({ indexed: false, error: `Mesh saved; embedding failed: ${String(error).slice(0, 300)}` }));

      if (indexing.error) {
        await step.do("record-index-warning", async () => {
          await advanceJob(this.env, p.jobId, "done", 100, indexing.error, nowIso());
          return { ok: true };
        }).catch(() => {});
      }

      return { objectId: p.objectId, glbKey };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failed job must be visible to the phone, not just to the dashboard. The fallback the
      // sprint's H6 gate describes — a textured box at measured dimensions — is only reachable
      // if the client is told the mesh is not coming.
      await advanceJob(this.env, p.jobId, "failed", 100, message.slice(0, 500), nowIso());
      await markObjectFailed(this.env, p.objectId);
      throw err;
    } finally {
      await notifyMeshFinished(this.env, p.jobId);
    }
  }
}

function base64ToBytes(b64: string): Uint8Array {
  if (b64.length > 24 * 1024 * 1024) throw new NonRetryableError("Mesh payload exceeds 24 MiB.");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function assertGlb(bytes: Uint8Array, expectedSize = bytes.length): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== expectedSize) {
    throw new NonRetryableError("Generation returned an invalid GLB header or length.");
  }
}
