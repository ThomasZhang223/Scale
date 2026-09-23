// Reaching a RoomAgent from outside it — from a route handler, or from a Workflow step.
//
// The room id is the Durable Object name, so every caller that knows the room reaches the same
// instance with no registry and no coordination. That is the whole reason the fan-out is
// sharded per room rather than held in one object.

import { getAgentByName } from "agents";
import type { RoomAgent } from "../agents/room-agent";
import type { ScoutAgent } from "../agents/scout-agent";

export async function roomAgent(env: Env, roomId: string) {
  return await getAgentByName<Env, RoomAgent>(
    env.ROOM_AGENT as DurableObjectNamespace<RoomAgent>,
    roomId,
  );
}

export async function scoutAgent(env: Env, sessionId: string) {
  return await getAgentByName<Env, ScoutAgent>(
    env.SCOUT_AGENT as DurableObjectNamespace<ScoutAgent>,
    sessionId,
  );
}

/**
 * Push one SSE event to every client watching a room.
 *
 * Returns the number of live subscribers rather than throwing when there are none. Zero
 * subscribers is the normal case — nobody has the headset on yet — and is not an error.
 */
export async function emitToRoom(
  env: Env,
  roomId: string,
  event: "object" | "version" | "fit" | "active-room",
  data: unknown,
): Promise<number> {
  const stub = await roomAgent(env, roomId);
  const res = await stub.fetch("https://agent/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, data, roomId }),
  });
  if (!res.ok) return 0;
  const body = (await res.json()) as { delivered?: number };
  return body.delivered ?? 0;
}
