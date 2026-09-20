// The USDZ the phone built for each object it captured, kept in the app's
// documents folder. Two consumers: the SceneKit preview on the object page
// and QuickLook for AR at 1:1 — both native, both read USDZ directly.
// ceiling: phone-local. An object captured on another phone, or a catalog
// row, has no file here; those pages fall back to the measured box.
import { Directory, File, Paths } from "expo-file-system";

function dir(): Directory {
  return new Directory(Paths.document, "objects");
}

function asFile(path: string): File {
  return new File(path.startsWith("file://") ? path : `file://${path}`);
}

export function saveObjectUsdz(objectId: string, sourcePath: string): void {
  const d = dir();
  if (!d.exists) d.create();
  const dest = new File(d, `${objectId}.usdz`);
  if (dest.exists) dest.delete();
  asFile(sourcePath).copy(dest);
}

export function objectUsdzUri(objectId: string): string | null {
  try {
    const f = new File(dir(), `${objectId}.usdz`);
    return f.exists ? f.uri : null;
  } catch {
    return null;
  }
}

// The photo shown on the library row and the detail header: one frame from
// the capture (Object Capture) or the sharpest sweep frame (measure).
export function saveObjectPhoto(objectId: string, sourcePath: string): void {
  const d = dir();
  if (!d.exists) d.create();
  const dest = new File(d, `${objectId}.jpg`);
  if (dest.exists) dest.delete();
  asFile(sourcePath).copy(dest);
}

export function objectPhotoUri(objectId: string): string | null {
  try {
    const f = new File(dir(), `${objectId}.jpg`);
    return f.exists ? f.uri : null;
  } catch {
    return null;
  }
}
