// The XR dev server on the demo Mac — the one machine both the phone and the
// Quest already talk to (the phone for Metro, the Quest for the WebXR page).
// Its address is derived from Metro's own, so nothing is typed in.
// ceiling: dev only. The Worker has no "active room" route (contracts.md);
// when it gets one, this file becomes a thin wrapper over it.
import Constants from "expo-constants";

import { postJSON } from "./api";

const XR_PORT = 5173;

export function devServerBase(): string | null {
  const host = Constants.expoConfig?.hostUri ?? (Constants as { expoGoConfig?: { debuggerHost?: string } }).expoGoConfig?.debuggerHost;
  if (!host) return null;
  return `http://${host.split(":")[0]}:${XR_PORT}`;
}

export async function setActiveRoomOnHeadset(roomId: string): Promise<void> {
  // The cloud route, not the Mac: POST /v1/active-room on the front door stores the choice and
  // pushes it over SSE to every headset (GET /v1/sync/lobby). It used to POST to the Vite dev
  // server found through Metro's address, which a Release build does not have ("Metro's address
  // is unknown"), and which the deployed headset page never read.
  await postJSON<{ roomId: string; delivered: number }>("/v1/active-room", { roomId });
}
