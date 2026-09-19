/*
 * The Worker half of the deployed WebXR page (wrangler.toml). Everything that is not /v1 is a
 * static asset from dist/ and never reaches this code (`run_worker_first = ["/v1/*"]`).
 *
 * /v1/agent/*  → AGENT_ORIGIN (services/agent), or API_ORIGIN when AGENT_ORIGIN is empty
 * /v1/*        → API_ORIGIN   (Thomas's Worker, the one front door)
 *
 * Same rule the Vite dev proxy applies (vite.config.ts): longer prefix first. The request is
 * forwarded as-is — method, headers (X-Stub included), body — and the upstream response is
 * returned as-is, so SSE (GET /v1/sync/{roomId}, the agent's event stream) streams through.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API_ORIGIN: string;
  AGENT_ORIGIN: string;
}

function originFor(pathname: string, env: Env): string {
  const agent = env.AGENT_ORIGIN.trim();
  if (pathname.startsWith('/v1/agent') && agent) return agent;
  if (!env.API_ORIGIN) throw new Error('API_ORIGIN is not set (apps/xr/wrangler.toml [vars])');
  return env.API_ORIGIN;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1')) return env.ASSETS.fetch(request);

    const upstream = new URL(originFor(url.pathname, env));
    upstream.pathname = url.pathname;
    upstream.search = url.search;

    const headers = new Headers(request.headers);
    headers.delete('host');
    const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
    return fetch(upstream.toString(), init);
  },
};
