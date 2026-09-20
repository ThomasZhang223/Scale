import { getAgentByName, type AgentNamespace } from 'agents';
import type { DesignerAgent } from './agent.ts';

export { DesignerAgent } from './agent.ts';

/*
 * The designer agent's Worker: every /v1/agent/{roomId}/... request goes to that room's
 * DesignerAgent Durable Object. Thomas's Worker can forward the same prefix here.
 */

export interface Env {
  DesignerAgent: AgentNamespace<DesignerAgent>;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  AI_GATEWAY_URL?: string;
  CF_AIG_TOKEN?: string;
  CONFIG: KVNamespace;
  UPSTREAM_TOKEN?: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, x-stub',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'designer-agent' });
    const m = url.pathname.match(/^\/v1\/agent\/([^/]+)(\/.*)?$/);
    if (!m) return json({ error: 'not found' }, 404);
    const agent = await getAgentByName(env.DesignerAgent, decodeURIComponent(m[1]));
    const res = await agent.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
}
