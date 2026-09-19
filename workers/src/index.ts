// Router skeleton — every route from the HTTP surface table in .claude/contracts.md.
// Every route checks the `X-Stub: 1` header first; when present, it serves a committed
// fixture instead of running real logic. This is what unblocks everyone else before any
// backend logic exists — see workers/README.md.
//
// ceiling: only four fixtures are committed (fixtures/README.md). Routes with no matching
// one — versions, uploads, jobs, search, solve, push, sync — fall straight through to 501
// even under X-Stub. Add a fixture and a `stubBody` below when one of those needs to unblock
// someone.

import roomDemo from "../../fixtures/room-demo.json";
import objectMacbook from "../../fixtures/object-macbook.json";
import fitReportDoorSwing from "../../fixtures/fitreport-doorswing.json";

// Binding types (R2Bucket, D1Database, VectorizeIndex, Queue, DurableObjectNamespace) come
// from @cloudflare/workers-types once that dependency is added; left as `any` here so this
// file has no dependency of its own yet.
interface Env {
  BUCKET: any;
  DB: any;
  OBJECTS_INDEX: any;
  JOB_QUEUE: any;
  ROOM_SYNC: any;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isStub(req: Request): boolean {
  return req.headers.get("X-Stub") === "1";
}

interface Route {
  method: string;
  pattern: RegExp;
  route: string;
  stubBody?: () => unknown;
}

function route(method: string, path: string, stubBody?: () => unknown): Route {
  const pattern = new RegExp("^" + path.replace(/\{(\w+)\}/g, "([^/]+)") + "$");
  return { method, pattern, route: `${method} ${path}`, stubBody };
}

const routes: Route[] = [
  route("POST", "/v1/rooms", () => ({ roomId: roomDemo.roomId })),
  route("GET", "/v1/rooms/{id}", () => roomDemo),
  route("POST", "/v1/rooms/{id}/versions"),
  route("GET", "/v1/rooms/{id}/versions"),
  route("GET", "/v1/versions/{id}"),
  route("POST", "/v1/uploads"),
  route("POST", "/v1/objects", () => objectMacbook),
  route("GET", "/v1/objects/{id}", () => objectMacbook),
  route("POST", "/v1/objects/{id}/generate"),
  route("GET", "/v1/jobs/{id}"),
  route("POST", "/v1/search"),
  route("POST", "/v1/fit", () => fitReportDoorSwing),
  route("POST", "/v1/solve"),
  route("POST", "/v1/push/{roomId}"),
  route("GET", "/v1/sync/{roomId}"),
];

export default {
  async fetch(req: Request, _env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    for (const r of routes) {
      if (r.method !== req.method || !r.pattern.test(pathname)) continue;
      if (isStub(req) && r.stubBody) return json(r.stubBody());
      return json({ error: "not implemented", route: r.route }, 501);
    }
    return json({ error: "not found" }, 404);
  },
};
