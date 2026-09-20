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
