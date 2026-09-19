// The one place that knows where the backend is.
//
// The phone is not on localhost. `wrangler dev` binds to your laptop, so this
// must be the laptop's LAN address and every device must be on the travel
// router. Set EXPO_PUBLIC_API_BASE in .env.local rather than editing this file.
//
// ceiling: no auth. A device-id header is enough for a weekend; add it here
// when it exists rather than at every call site.

export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE ?? "http://192.168.1.10:8787/v1";

export async function getJSON(path, { stub = false } = {}) {
  return request("GET", path, undefined, stub);
}

export async function postJSON(path, body, { stub = false } = {}) {
  return request("POST", path, body, stub);
}

async function request(method, path, body, stub) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      // Every endpoint serves a committed fixture under this header. Build
      // against it until the real route exists; see .claude/contracts.md.
      ...(stub ? { "X-Stub": "1" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);

  const doc = await res.json();
  assertSchema(doc, path);
  return doc;
}

// Fail loud on a schema mismatch. A renamed field otherwise arrives as
// undefined and surfaces as NaN somewhere far away. See "Changing a schema"
// in .claude/contracts.md.
const EXPECTED_SCHEMA_VERSION = 1;

function assertSchema(doc, path) {
  if (doc == null || typeof doc !== "object") return;
  if (!("schemaVersion" in doc)) return;
  if (doc.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `${path} returned schemaVersion ${doc.schemaVersion}, this build expects ` +
        `${EXPECTED_SCHEMA_VERSION} — pull, or ask whoever changed it`
    );
  }
}
