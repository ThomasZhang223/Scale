// EventSource-style reader for GET /v1/sync/{roomId} (.claude/contracts.md,
// "SSE stream"). React Native has no EventSource, so this parses the SSE
// wire format by hand over the streaming response body that expo/fetch
// exposes — the platform fetch that ships with react-native does not give a
// readable stream.
//
// Validates schemaVersion the same way src/lib/api.ts does (contracts.md,
// "The one line of code that makes this loud") — for the two event types
// that carry a full schema document. The `version` event's payload is
// `{ versionId }` only, per contracts.md's SSE section, so it has none to
// check.

import { fetch } from "expo/fetch";

import { API_BASE, ApiError, assertSchema } from "./api";

export type ObjectV1 = {
  schemaVersion: number;
  objectId: string;
  state: "measured" | "generating" | "ready" | "failed";
  [key: string]: unknown;
};

export type FitReportV1 = {
  schemaVersion: number;
  ok: boolean;
  violations: unknown[];
  [key: string]: unknown;
};

export type RoomSyncHandlers = {
  onOpen?: () => void;
  onObject?: (obj: ObjectV1) => void;
  onVersion?: (version: { versionId: string }) => void;
  onFit?: (report: FitReportV1) => void;
  // Fires on a transport failure or an unparseable/unknown event. Never
  // fires after close() is called — that abort is expected, not an error.
  onError?: (err: Error) => void;
};

export type RoomSyncOptions = {
  // Adds X-Stub: 1, matching RequestOptions in src/lib/api.ts.
  stub?: boolean;
};

export interface RoomSync {
  close(): void;
}

const KNOWN_EVENTS = new Set(["object", "version", "fit"]);

// api.ts's own requireApiBase() is the same check, but it is not exported —
// api.ts is Panel A's file (CLAUDE.md file ownership) and only API_BASE
// itself is exported, for this exact diagnostic use. Duplicated here rather
// than asking Panel A to widen their file's exports for one caller.
function requireApiBase(): string {
  if (!API_BASE) {
    throw new ApiError(
      "EXPO_PUBLIC_API_BASE is not set — create apps/mobile/.env.local, see apps/mobile/README.md"
    );
  }
  return API_BASE;
}

export function subscribeRoomSync(
  roomId: string,
  handlers: RoomSyncHandlers,
  opts: RoomSyncOptions = {}
): RoomSync {
  const base = requireApiBase();
  const controller = new AbortController();
  let closed = false;

  (async () => {
    try {
      const res = await fetch(`${base}/v1/sync/${roomId}`, {
        headers: opts.stub ? { "X-Stub": "1" } : {},
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new ApiError(`GET /v1/sync/${roomId} -> HTTP ${res.status}`);
      }
      handlers.onOpen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          dispatch(buffer.slice(0, separator), handlers);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if (closed) return; // the abort in close() rejects the pending read on purpose
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}

function dispatch(rawEvent: string, handlers: RoomSyncHandlers): void {
  let eventType = "";
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!eventType || dataLines.length === 0) return; // a bare heartbeat/comment, not a real event

  if (!KNOWN_EVENTS.has(eventType)) {
    // Fail loud (CLAUDE.md, "Fail loud, never silently default"): an event
    // name this file was never told about is a contract change, not noise.
    handlers.onError?.(
      new ApiError(`GET /v1/sync -> unknown event "${eventType}", expected object|version|fit`)
    );
    return;
  }

  const payload = JSON.parse(dataLines.join("\n"));

  switch (eventType) {
    case "object":
      assertSchema(payload, "Object v1 (SSE)");
      handlers.onObject?.(payload as ObjectV1);
      return;
    case "version":
      // No schemaVersion on this one — contracts.md defines the `version`
      // event's payload as `{ versionId }` only.
      handlers.onVersion?.(payload as { versionId: string });
      return;
    case "fit":
      assertSchema(payload, "FitReport v1 (SSE)");
      handlers.onFit?.(payload as FitReportV1);
      return;
  }
}
