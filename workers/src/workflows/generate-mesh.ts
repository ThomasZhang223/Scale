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
// The concurrency cap is why the unattended catalog pre-bake goes through the queue instead of
// starting a hundred instances at once — see the queue consumer in src/index.ts.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
// NonRetryableError lives in cloudflare:workflows, not cloudflare:workers.
import { NonRetryableError } from "cloudflare:workflows";
import { R2Keys } from "../lib/keys";
import { nowIso } from "../lib/ids";
import { advanceJob, markObjectFailed, markObjectReady } from "../lib/store";
import { emitToRoom } from "../lib/notify";

export interface GenerateMeshParams {
  jobId: string;
  objectId: string;
  tier: "live" | "quality";
  /** Origin of the API, so Baseten can fetch the frame by URL rather than by upload. */
  apiOrigin: string;
  /** Room to notify over SSE when the mesh lands. Null for a catalog pre-bake with no room. */
  roomId: string | null;
}

interface ObjectMeta {
  objectId: string;
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
  /** 768-dim SigLIP 2 embedding. Workers AI has no SigLIP or CLIP model, so it must come from here. */
  embedding?: number[];
}

export class GenerateMeshWorkflow extends WorkflowEntrypoint<Env, GenerateMeshParams> {
  async run(event: Readonly<WorkflowEvent<GenerateMeshParams>>, step: WorkflowStep) {
    const p = event.payload;

    try {
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
          "SELECT id, name, category, bbox_w, bbox_h, bbox_d FROM objects WHERE id = ?",
        )
          .bind(p.objectId)
          .first<{
            id: string;
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
        const frameKeys = listed.objects.map((o) => o.key).sort();
        if (frameKeys.length === 0) {
          throw new NonRetryableError(
            `No frames at objects/${p.objectId}/frames/. Upload at least one before generating.`,
          );
        }
        return {
          objectId: row.id,
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
        // A GPU endpoint fails transiently: cold start, queue timeout, a 502 from the proxy.
        // Three tries with exponential backoff covers that without covering a real bug.
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" },
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
              // Where to put the result if the Truss writes to R2 itself.
              upload_url: `${p.apiOrigin}/v1/uploads`,
              want_embedding: true,
            }),
          });
          if (!res.ok) {
            throw new Error(`Baseten returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
          }
          return (await res.json()) as BasetenResult;
        },
      );

      const glbKey = await step.do("store-mesh", async (): Promise<string> => {
        await advanceJob(this.env, p.jobId, "running", 65, null, nowIso());
        const key = R2Keys.objectMesh(p.objectId);

        // Two accepted shapes, because where the binding runs is Ani's call and it may move.
        // If the Truss binds on the GPU box it writes R2 directly and reports the key, which
        // is one network hop instead of three. If it returns the mesh inline, we store it.
        if (generated.glbKey) {
          const head = await this.env.BUCKET.head(generated.glbKey);
          if (!head) {
            throw new Error(
              `Baseten reported key ${generated.glbKey} but nothing is stored there.`,
            );
          }
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

      await step.do("index-embedding", async (): Promise<{ indexed: boolean }> => {
        await advanceJob(this.env, p.jobId, "running", 85, null, nowIso());
        if (!generated.embedding || generated.embedding.length === 0) {
          // Not fatal. The object is still usable in the room; it is only unfindable by
          // similarity until an embedding arrives. Say so rather than failing the whole job.
          return { indexed: false };
        }
        if (generated.embedding.length !== 768) {
          throw new NonRetryableError(
            `Embedding has ${generated.embedding.length} dimensions, expected 768 ` +
              `(google/siglip2-base-patch16-224). The index will reject it.`,
          );
        }
        await this.env.OBJECTS_INDEX.upsert([
          {
            id: p.objectId,
            values: generated.embedding,
            metadata: {
              objectId: p.objectId,
              source: "scan",
              category: meta.category,
              // Millimetres as integers, so Vectorize numeric range filters work on them.
              // Metres would be floats between 0 and 2 and the filter would be useless.
              w_mm: Math.round(meta.bboxMeters.w * 1000),
              h_mm: Math.round(meta.bboxMeters.h * 1000),
              d_mm: Math.round(meta.bboxMeters.d * 1000),
              dominant_hex: generated.palette?.[0] ?? "#000000",
            },
          },
        ]);
        return { indexed: true };
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
          const row = await this.env.DB.prepare("SELECT * FROM objects WHERE id = ?")
            .bind(p.objectId)
            .first();
          await emitToRoom(this.env, p.roomId, "object", {
            ...(row as Record<string, unknown>),
            glbUrl: `${p.apiOrigin}/v1/assets/${glbKey}`,
          });
        }
        return { ok: true };
      });

      return { objectId: p.objectId, glbKey };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failed job must be visible to the phone, not just to the dashboard. The fallback the
      // sprint's H6 gate describes — a textured box at measured dimensions — is only reachable
      // if the client is told the mesh is not coming.
      await advanceJob(this.env, p.jobId, "failed", 100, message.slice(0, 500), nowIso());
      await markObjectFailed(this.env, p.objectId);
      throw err;
    }
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
