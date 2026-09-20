// The only place in the app that knows the Worker's base URL and validates a
// response's schemaVersion. See .claude/contracts.md, "The one line of code
// that makes this loud" — a renamed field must throw here, never arrive
// downstream as `undefined`.
//
// Note for whoever reads this next: an earlier commit's message claimed this
// file already existed ("add src/lib/api.js as the only place that knows the
// base URL"), but the file was never actually committed. This is a fresh
// write against that same spec, not a port of prior code.

import { File, UploadType } from "expo-file-system";

export const API_BASE = process.env.EXPO_PUBLIC_API_BASE;

const SCHEMA_VERSION = 1;

export class ApiError extends Error {}

// Fail loud (CLAUDE.md, "Fail loud, never silently default"): a missing base
// URL is a decision — which server to talk to — so it is never guessed. The
// raw `API_BASE` above stays exported for the health-row display, which is a
// diagnostic read with no decision weight; every call that actually reaches
// the network goes through this check instead.
function requireApiBase(): string {
  if (!API_BASE) {
    throw new ApiError(
      "EXPO_PUBLIC_API_BASE is not set — create apps/mobile/.env.local, see apps/mobile/README.md"
    );
  }
  // README.md tells people to set this to `…workers.dev/v1`, while every call site in this
  // app already spells the `/v1` prefix in its path. Accept both forms rather than 404 on
  // `/v1/v1/...` — a trailing `/v1` (or `/`) on the base is stripped here, once.
  return API_BASE.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// contracts.md, "The one line of code that makes this loud": a schemaVersion
// mismatch is a person problem, and it must arrive as a named exception, not
// a silently coerced or ignored field.
export function assertSchema(doc: { schemaVersion?: number }, label: string): void {
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new ApiError(
      `${label} schemaVersion ${doc.schemaVersion}, expected ${SCHEMA_VERSION} — ask Thomas`
    );
  }
}

export type RequestOptions = {
  // Adds X-Stub: 1, so every /v1 route answers its committed fixture.
  stub?: boolean;
  // When set, the parsed response is run through assertSchema with this label.
  schemaLabel?: string;
};

async function request<T>(
  path: string,
  init: RequestInit,
  opts: RequestOptions
): Promise<T> {
  const base = requireApiBase();
  // Half the call sites spell "/v1/objects", the other half "/objects" (the capture screens,
  // written when the base URL carried the prefix). Both mean the same route.
  const versioned = path.startsWith("/v1/") ? path : `/v1${path}`;
  const res = await fetch(`${base}${versioned}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(opts.stub ? { "X-Stub": "1" } : {}),
    },
  });
  if (!res.ok) {
    throw new ApiError(`${path} -> HTTP ${res.status}`);
  }
  // 204 No Content: POST /v1/push answers this (noContent() in workers/src/routes/index.ts),
  // and res.json() on an empty body throws SyntaxError — which the Headset tab was reporting
  // as "Failed to push" on a successful push.
  if (res.status === 204) return undefined as T;
  const doc = (await res.json()) as T;
  if (opts.schemaLabel) {
    assertSchema(doc as { schemaVersion?: number }, opts.schemaLabel);
  }
  return doc;
}

export function getJSON<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return request<T>(path, { method: "GET" }, opts);
}

export function postJSON<T>(
  path: string,
  body: unknown,
  opts: RequestOptions = {}
): Promise<T> {
  return request<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    opts
  );
}

// `POST /uploads` returns a presigned R2 target. The bytes go straight to
// R2, never through the Worker — this is the only function in this file
// that does not touch `API_BASE`. Takes a local file path rather than a
// Blob: expo-file-system's File.upload() streams from disk with a plain
// binary PUT, which is what a presigned R2 URL expects. Reading the file
// into a Blob first (e.g. via a base64 round-trip) would work too, but
// wastes memory and a full read-encode-decode pass that File.upload()
// already avoids.
export async function putUpload(
  localFilePath: string,
  putUrl: string,
  contentType: string
): Promise<void> {
  const file = new File(localFilePath);
  const result = await file.upload(putUrl, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "Content-Type": contentType },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(`upload -> HTTP ${result.status}`);
  }
}
