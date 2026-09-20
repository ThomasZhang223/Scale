// HTTP primitives shared by every route. One place for CORS, one place for error shape.

// CORS. The phone, the Quest browser and the XR dev server are all on different origins from
// the Worker, and none of them can be enumerated ahead of a hackathon demo.
//
// ceiling: Access-Control-Allow-Origin is "*". That is safe only because no route reads a
// cookie or an Authorization header — auth is a device-id header at most (see BUILD_DOC's cut
// list). The moment a real credential exists, this must become an allow-list of known origins
// and `Access-Control-Allow-Credentials: true`, because "*" is rejected with credentials.
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "Content-Type, X-Stub, X-Device-Id",
  "access-control-expose-headers": "Content-Type, ETag",
  "access-control-max-age": "86400",
};

export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export function preflight(): Response {
  return withCors(new Response(null, { status: 204 }));
}

export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(extra ?? {}) },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * A failure with a status and a name a human can act on.
 *
 * Standing rule 4 in CLAUDE.md: when a value cannot be determined, raise. Never substitute a
 * default. Every `throw new HttpError(...)` in this codebase is that rule, and the `hint`
 * field is there so the person reading a 503 at 3am is told the exact command that fixes it.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.code, message: err.message, hint: err.hint ?? null }, err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: "internal", message }, 500);
}

/** Parse a JSON body, failing loud rather than yielding `undefined` fields downstream. */
export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "bad_json", "Request body is not valid JSON.");
  }
}

/**
 * The public API origin a Durable Object must use to build asset URLs. The Worker passes it in
 * the request body because a DO is reached through a synthetic URL (https://agent/...), whose
 * origin is NOT the API's. There is no default: an origin guessed from that URL puts
 * `https://agent/v1/assets/...` into every glbUrl.
 */
export function requireOrigin(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // falls through to the error below
  }
  throw new HttpError(
    400,
    "origin_required",
    `The request body must carry the public API "origin" (got ${JSON.stringify(value)}).`,
  );
}
