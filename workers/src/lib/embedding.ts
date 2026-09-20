import { upstreamOrigin } from "./config";

export interface Embedding {
  values: number[];
  dimension: number;
  fingerprint: string;
  inputHash: string;
  modality: "image" | "text";
}

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
    if (!/^objects\/[^/]+\/frames\/[^/]+\.(jpg|jpeg|png)$/.test(input.imageKey)) {
      throw new Error("Expected an object frame key");
    }
    const image = await env.BUCKET.get(input.imageKey);
    if (!image) throw new Error("Embedding image not found");
    if (image.size > 10 * 1024 * 1024) {
      await image.body.cancel();
      throw new Error("Embedding image exceeds 10 MiB");
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
