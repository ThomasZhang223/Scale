import { HttpError } from "./http";

/**
 * Upstream service origins, read from KV at request time.
 *
 * Why KV and not `[vars]` in wrangler.toml: these are quick-tunnel URLs on trycloudflare.com,
 * and a quick tunnel gets a NEW random hostname every time cloudflared restarts. Rotating one
 * must be a single `wrangler kv key put`, not an edit-commit-redeploy cycle at hour 20.
 *
 * Standing rule 4 — fail loud. There is no fallback origin and no "first registered service".
 * An unset key raises a 503 that names the exact command to fix it. A fallback here would be
 * silently wrong the moment a second service exists, and would look like it worked in every
 * test until the demo.
 */
export type Upstream = "solver" | "search" | "ingest";

const KV_PREFIX = "upstream:";

export async function upstreamOrigin(env: Env, which: Upstream): Promise<string> {
  const key = `${KV_PREFIX}${which}`;
  const origin = await env.CONFIG.get(key);
  if (!origin) {
    throw new HttpError(
      503,
      "upstream_unset",
      `No origin is configured for the ${which} service.`,
      `npx wrangler kv key put --binding CONFIG "${key}" "https://<your>.trycloudflare.com" --remote`,
    );
  }
  return origin.replace(/\/+$/, "");
}

/**
 * Call a laptop-hosted service through the tunnel.
 *
 * The shared-header check is the only thing between a quick-tunnel URL and the open internet.
 * A quick-tunnel hostname is unguessable but entirely public, so the token is not optional.
 */
export async function callUpstream<T>(
  env: Env,
  which: Upstream,
  path: string,
  body: unknown,
  timeoutMs = 25_000,
): Promise<T> {
  const origin = await upstreamOrigin(env, which);
  const url = `${origin}${path}`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.UPSTREAM_TOKEN) headers["x-upstream-token"] = env.UPSTREAM_TOKEN;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(
      502,
      "upstream_unreachable",
      `The ${which} service at ${origin} did not answer: ${reason}`,
      `Check that cloudflared and the container are both up, then re-run infra/cloudflare/set-upstreams.sh.`,
    );
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new HttpError(
      502,
      "upstream_error",
      `The ${which} service answered ${res.status}: ${detail}`,
    );
  }
  return (await res.json()) as T;
}
