// The XR dev server on the demo Mac — the one machine both the phone and the
// Quest already talk to (the phone for Metro, the Quest for the WebXR page).
// Its address is derived from Metro's own, so nothing is typed in.
// ceiling: dev only. The Worker has no "active room" route (contracts.md);
// when it gets one, this file becomes a thin wrapper over it.
import Constants from "expo-constants";

const XR_PORT = 5173;

export function devServerBase(): string | null {
  const host = Constants.expoConfig?.hostUri ?? (Constants as { expoGoConfig?: { debuggerHost?: string } }).expoGoConfig?.debuggerHost;
  if (!host) return null;
  return `http://${host.split(":")[0]}:${XR_PORT}`;
}

export async function setActiveRoomOnHeadset(roomId: string): Promise<void> {
  const base = devServerBase();
  if (!base) throw new Error("Metro's address is unknown, so the XR dev server can't be found. Run from the dev client.");
  const res = await fetch(`${base}/local/active-room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId }),
  });
  if (!res.ok) throw new Error(`XR dev server answered ${res.status}. Is "npm run dev" running in apps/xr on the Mac?`);
}
