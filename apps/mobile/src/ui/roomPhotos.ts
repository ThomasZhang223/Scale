// The one photo the phone keeps per room, in the app's documents folder.
// ceiling: phone-local only. RoomCapture v1 has no photo field, so a room
// scanned on another phone (or the demo fixture) has none here; the Rooms
// card falls back to the floor plan, which is real data from the same scan.
// Upgrade path: an `objectThumb`-style upload kind for rooms in workers/,
// and a `photoUrl` on RoomCapture v1 via the schema-change protocol.
import { Directory, File, Paths } from "expo-file-system";

function roomsDir(): Directory {
  return new Directory(Paths.document, "rooms");
}

function asFile(path: string): File {
  return new File(path.startsWith("file://") ? path : `file://${path}`);
}

export function saveRoomPhoto(roomId: string, sourcePath: string): void {
  const dir = roomsDir();
  if (!dir.exists) dir.create();
  const dest = new File(dir, `${roomId}.jpg`);
  if (dest.exists) dest.delete();
  asFile(sourcePath).copy(dest);
}

export function roomPhotoUri(roomId: string): string | null {
  try {
    const f = new File(roomsDir(), `${roomId}.jpg`);
    return f.exists ? f.uri : null;
  } catch {
    return null;
  }
}

// --- Rooms made on this phone -------------------------------------------------------------
// ceiling: the Worker has no "list rooms" route (contracts.md lists only GET /rooms/{id}), so
// the Rooms tab shows the demo fixture plus whatever this phone created. Upgrade path: a
// GET /v1/rooms on the Worker, and this file goes away.
function registry(): File {
  const dir = roomsDir();
  if (!dir.exists) dir.create();
  return new File(dir, "index.json");
}

export function localRoomIds(): string[] {
  try {
    const f = registry();
    if (!f.exists) return [];
    const parsed = JSON.parse(f.textSync()) as { ids?: string[] };
    return Array.isArray(parsed.ids) ? parsed.ids : [];
  } catch {
    return [];
  }
}

export function rememberRoom(roomId: string): void {
  const ids = localRoomIds().filter((id) => id !== roomId);
  ids.unshift(roomId);
  registry().write(JSON.stringify({ ids }));
}

// --- The six straightened faces of a photo-built room ---------------------------------------
export type RoomFaceMeta = { aspect: number; detected: boolean };

export function saveRoomFace(roomId: string, face: string, sourcePath: string): void {
  const d = new Directory(roomsDir(), roomId);
  if (!d.exists) d.create();
  const dest = new File(d, `${face}.jpg`);
  if (dest.exists) dest.delete();
  asFile(sourcePath).copy(dest);
}

export function saveRoomFaceMeta(roomId: string, meta: Record<string, RoomFaceMeta>): void {
  const d = new Directory(roomsDir(), roomId);
  if (!d.exists) d.create();
  new File(d, "faces.json").write(JSON.stringify(meta));
}

export function roomFaces(roomId: string): { uris: Record<string, string>; meta: Record<string, RoomFaceMeta> } {
  const uris: Record<string, string> = {};
  let meta: Record<string, RoomFaceMeta> = {};
  try {
    const d = new Directory(roomsDir(), roomId);
    if (!d.exists) return { uris, meta };
    for (const face of ["front", "right", "back", "left", "floor", "ceiling"]) {
      const f = new File(d, `${face}.jpg`);
      if (f.exists) uris[face] = f.uri;
    }
    const m = new File(d, "faces.json");
    if (m.exists) meta = JSON.parse(m.textSync()) as Record<string, RoomFaceMeta>;
  } catch {
    // no faces: the page shows the floor plan only
  }
  return { uris, meta };
}
