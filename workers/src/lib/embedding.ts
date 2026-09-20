import { upstreamOrigin } from "./config";
import { HttpError } from "./http";

export interface Embedding {
  values: number[];
  dimension: number;
  fingerprint: string;
  inputHash: string;
  modality: "image" | "text";
}

const OBJECT_FRAME = /^objects\/[^/]+\/frames\/[^/]+\.(jpg|jpeg|png)$/;
const CATALOG_SOURCE = /^catalog\/[^/]+\/[^/]+\/source\.(jpg|jpeg|png)$/;

/** Both queries and indexed images use the same CPU encoder and fingerprint namespace. */
export async function embedInput(
  env: Env, input: { text?: string; imageKey?: string },
): Promise<Embedding> {
  if ((input.text != null) === (input.imageKey != null)) {
    throw new Error("Supply exactly one text or imageKey");
  }
  const fingerprint = await env.CONFIG.get("embedding:fingerprint");
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint) || !env.EMBEDDING_API_KEY) {
    throw new Error("Configure embedding:fingerprint in CONFIG and EMBEDDING_API_KEY");
  }
  const origin = await upstreamOrigin(env, "embedding");
  const payload: Record<string, string> = { expectedFingerprint: fingerprint };
  if (input.imageKey != null) {
    // Read directly from the bound private bucket; the encoder needs no R2 credentials
    // or arbitrary URL-fetch capability. Never trust a caller-provided public image URL.
    // Exactly the two image key shapes R2Keys mints (objectFrame, catalogSource) — the guard
    // still refuses every other key.
    if (!OBJECT_FRAME.test(input.imageKey) && !CATALOG_SOURCE.test(input.imageKey)) {
      throw new HttpError(400, "bad_image_key", `Expected an object frame or catalogue source key, got ${JSON.stringify(input.imageKey)}.`);
    }
    const image = await env.BUCKET.get(input.imageKey);
    if (!image) throw new HttpError(404, "image_not_found", `Embedding image not found at ${input.imageKey}.`);
    if (image.size > 10 * 1024 * 1024) {
      await image.body.cancel();
      throw new HttpError(413, "image_too_large", `Embedding image exceeds 10 MiB at ${input.imageKey}.`);
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += 8192) {
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    }
    payload.imageBase64 = btoa(chunks.join(""));
  } else {
    payload.text = input.text!;
  }
  const response = await fetch(`${origin}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.EMBEDDING_API_KEY}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Embedding service returned ${response.status}`);
  const result = await response.json() as Embedding;
  const modality = input.imageKey != null ? "image" : "text";
  if (result.fingerprint !== fingerprint || result.dimension !== 768 || result.modality !== modality
      || !/^[a-f0-9]{64}$/.test(result.inputHash) || !Array.isArray(result.values)
      || result.values.length !== 768 || !result.values.every(v => typeof v === "number" && Number.isFinite(v))
      || Math.abs(Math.sqrt(result.values.reduce((sum, v) => sum + v * v, 0)) - 1) > 1e-5) {
    throw new Error("Invalid embedding response or incompatible model fingerprint");
  }
  return result;
}

export interface IndexObjectInput {
  objectId: string;
  source: string;
  category: string;
  bboxMeters: { w: number; h: number; d: number };
  dominantHex?: string | null;
  /** Exactly one of these, same rule as embedInput. */
  imageKey?: string;
  text?: string;
}

/**
 * The ONLY writer to Vectorize. The mesh Workflow, POST /v1/objects/{id}/mesh and
 * POST /v1/objects/{id}/index all call this, so there is exactly one place that decides the
 * namespace, the metadata and the millimetre rounding.
 */
export async function indexObject(
  env: Env, input: IndexObjectInput,
): Promise<{ fingerprint: string; modality: string }> {
  const embedding = await embedInput(env, { text: input.text, imageKey: input.imageKey });
  await env.OBJECTS_INDEX.upsert([
    {
      id: input.objectId,
      values: embedding.values,
      namespace: embedding.fingerprint,
      metadata: {
        objectId: input.objectId,
        source: input.source,
        category: input.category,
        // Millimetres as integers, so Vectorize numeric range filters work on them.
        // This matches the query's conversion from metres to millimetres.
        w_mm: Math.round(input.bboxMeters.w * 1000),
        h_mm: Math.round(input.bboxMeters.h * 1000),
        d_mm: Math.round(input.bboxMeters.d * 1000),
        dominant_hex: input.dominantHex ?? "#000000",
      },
    },
  ]);
  return { fingerprint: embedding.fingerprint, modality: embedding.modality };
}
