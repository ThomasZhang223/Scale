// Router skeleton — every route from the HTTP surface table in .claude/contracts.md.
// Every route checks the `X-Stub: 1` header first; when present, it serves a committed
// fixture — or, for routes with no fixture file, an inline stub value shaped to match
// contracts.md — instead of running real logic. This is what unblocks everyone else before
// any backend logic exists — see workers/README.md.
//
// Without X-Stub: 1, every route still 501s. None of the 15 have real logic yet — that lands
// behind this same dispatch later, one route at a time.

import roomDemo from "../../fixtures/room-demo.json";
import objectMacbook from "../../fixtures/object-macbook.json";
import fitReportDoorSwing from "../../fixtures/fitreport-doorswing.json";

interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  OBJECTS_INDEX: VectorizeIndex;
  JOB_QUEUE: Queue;
  ROOM_SYNC: DurableObjectNamespace;
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

// --- CORS ---------------------------------------------------------------------------------
// ceiling: Access-Control-Allow-Origin is "*" for every route. A public deploy would scope
// this to the known app/XR origins instead of allowing any origin.
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, X-Stub",
  "access-control-max-age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

// --- Stub data for routes with no committed fixture file -----------------------------------
// Built from contracts.md's own schema examples, with real UUIDs, and cross-referenced against
// the three committed fixtures (same roomId as room-demo.json, same objectId as
// object-macbook.json, same placementId as the door-swing violation) so the stub layer is one
// coherent scene, not fifteen unrelated blobs.

const STUB_ROOT_VERSION_ID = "98860e09-a9ce-4b38-b121-547659de1963";
const STUB_VERSION_ID = "52814aad-ee48-4fe9-8699-977beb12bc08";
const STUB_JOB_ID = "9c9f709a-47ab-4f22-b911-45a578374bcf";

// The one placement in the stub version: the fixture MacBook, positioned where
// fixtures/fitreport-doorswing.json says it blocks the door swing.
const stubPlacement = {
  placementId: fitReportDoorSwing.violations[0].placementId,
  objectId: objectMacbook.objectId,
  p: [1.2, 0.0, 0.05],
  yawDeg: 0.0,
  scale: 1.0,
  lockedToWallId: null,
  flags: ["blocks_door_swing"],
};

const stubRootVersion = {
  schemaVersion: 1,
  versionId: STUB_ROOT_VERSION_ID,
  roomId: roomDemo.roomId,
  parentId: null,
  label: "stub: empty room",
  createdAt: "2026-09-19T18:15:00Z",
  placements: [] as (typeof stubPlacement)[],
  materials: { wall: "#8a9a7b", floor: "oak-natural", trim: "#ffffff" },
  // ceiling: not a real sha256 — the stub layer never runs the hashing pipeline. Real
  // POST /rooms/{id}/versions computes this from placements + materials, keys sorted.
  contentHash: "stub-content-hash-root",
};

const stubVersion = {
  schemaVersion: 1,
  versionId: STUB_VERSION_ID,
  roomId: roomDemo.roomId,
  parentId: STUB_ROOT_VERSION_ID as string | null,
  label: "stub: macbook by the door",
  createdAt: "2026-09-19T18:20:00Z",
  placements: [stubPlacement],
  materials: { wall: "#8a9a7b", floor: "oak-natural", trim: "#ffffff" },
  contentHash: "stub-content-hash-v1", // ceiling: see stubRootVersion above.
};

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ceiling: scripted, one-shot stub — one `object` event, one `version` event, then close. A
// real GET /sync/{roomId} is a live per-room Durable Object fan-out that never closes on its
// own. Enough for Justin to build the SSE handler against without a phone or a server.
function stubSync(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseEvent("object", objectMacbook)));
      controller.enqueue(encoder.encode(sseEvent("version", { versionId: STUB_VERSION_ID })));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

interface Route {
  method: string;
  pattern: RegExp;
  route: string;
  stubBody?: () => unknown;
  // For the two routes whose stub answer is not a plain JSON 200: /push (204, no body) and
  // /sync (an SSE stream). Overrides stubBody when present.
  stubResponse?: () => Response;
}

function route(
  method: string,
  path: string,
  stubBody?: () => unknown,
  stubResponse?: () => Response,
): Route {
  const pattern = new RegExp("^" + path.replace(/\{(\w+)\}/g, "([^/]+)") + "$");
  return { method, pattern, route: `${method} ${path}`, stubBody, stubResponse };
}

const routes: Route[] = [
  route("POST", "/v1/rooms", () => ({ roomId: roomDemo.roomId })),
  route("GET", "/v1/rooms/{id}", () => roomDemo),
  route("POST", "/v1/rooms/{id}/versions", () => stubVersion),
  route("GET", "/v1/rooms/{id}/versions", () =>
    [stubRootVersion, stubVersion].map(({ versionId, label, createdAt, parentId }) => ({
      versionId,
      label,
      createdAt,
      parentId,
    })),
  ),
  route("GET", "/v1/versions/{id}", () => stubVersion),
  route("POST", "/v1/uploads", () => ({
    key: "objects/stub-upload/frames/0.jpg",
    // ceiling: placeholder, not a real presigned R2 PUT url. Real /uploads mints one from
    // BUCKET once the R2 binding is wired to presign logic. A stub caller should not PUT here.
    putUrl: "https://stub.local/uploads/objects/stub-upload/frames/0.jpg",
  })),
  route("POST", "/v1/objects", () => objectMacbook),
  route("GET", "/v1/objects/{id}", () => objectMacbook),
  route("POST", "/v1/objects/{id}/generate", () => ({ jobId: STUB_JOB_ID })),
  route("GET", "/v1/jobs/{id}", () => ({
    state: "running",
    progressPct: 42,
    objectId: objectMacbook.objectId,
    error: null,
  })),
  route("POST", "/v1/search", () => [
    { objectId: objectMacbook.objectId, score: 0.93, object: objectMacbook },
  ]),
  route("POST", "/v1/fit", () => fitReportDoorSwing),
  route("POST", "/v1/solve", () => ({
    placements: [stubPlacement],
    // note: contracts.md does not fix a scale for `objective`. Read here as an unbounded
    // solver score, higher is better — Justin owns the real /solve shape, flag if wrong.
    objective: 0.82,
    infeasible: false,
  })),
  route("POST", "/v1/push/{roomId}", undefined, () => new Response(null, { status: 204 })),
  route("GET", "/v1/sync/{roomId}", undefined, stubSync),
];

// ceiling: registration-only stub so `wrangler dev` starts — wrangler.toml declares the
// ROOM_SYNC Durable Object binding but nothing exported the class. GET /v1/sync/{roomId}
// under X-Stub: 1 answers directly from the Worker (stubSync above) and never reaches this
// object yet. The real per-room SSE fan-out — session tracking, broadcast on POST /push and
// on job completion — lands here when /sync goes from stub to real.
export class RoomSync {
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(_req: Request): Promise<Response> {
    return new Response(JSON.stringify({ error: "not implemented", route: "RoomSync" }), {
      status: 501,
      headers: { "content-type": "application/json" },
    });
  }
}

export default {
  async fetch(req: Request, _env: Env): Promise<Response> {
    // ceiling: answers every OPTIONS request the same way, without checking the path against
    // a real route. A preflight check does not need to know if the resource exists.
    if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    const { pathname } = new URL(req.url);
    for (const r of routes) {
      if (r.method !== req.method || !r.pattern.test(pathname)) continue;
      if (isStub(req)) {
        if (r.stubResponse) return withCors(r.stubResponse());
        if (r.stubBody) return withCors(json(r.stubBody()));
      }
      return withCors(json({ error: "not implemented", route: r.route }, 501));
    }
    return withCors(json({ error: "not found" }, 404));
  },
};
