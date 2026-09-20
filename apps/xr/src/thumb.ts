/*
 * One object, one picture, no app around it.
 *
 * The pipeline renders a scan the moment its mesh is attached, with no headset in the loop:
 * a headless browser opens /thumb.html?glb=<url>, waits for the completion signal, and takes
 * the JPEG. Object Capture uploads only the mesh, so without a picture every scan carries the
 * same text, embeds to the same point, and no query can tell two apart.
 *
 * It must produce the SAME picture the headset uploads or the two sets of vectors are not
 * comparable, so it calls renderThumbnail() — the same function the tablet calls — rather than
 * reimplementing the framing. There is no second copy of the camera rule to drift.
 *
 * It never hangs. Every path ends by setting window.__thumb exactly once, including the
 * timeout and every refusal, because a driver waiting on a signal that never comes is worse
 * than a driver told no.
 *
 * There are three ways to read the answer, because the driver's abilities are not known: the
 * data URL on window.__thumb, document.title, and the render itself, which is pinned at the
 * top-left of an otherwise empty white page at its exact size. A 512 x 512 screenshot of this
 * page is the picture, so a driver that can only screenshot still gets one.
 */
import * as THREE from 'three';
import { ObjectLoader } from './objects';
import { renderThumbnail, JPEG_QUALITY } from './thumbs';
import { meshUrl } from './thumbUrl';

/** How long the whole job may take, first frame and all. Software WebGL is not quick. */
const TIMEOUT_MS = 25_000;
type Result = { ok: true; dataUrl: string; width: number; height: number } | { ok: false; error: string };

let settled = false;

/** The one way this page ever finishes. Called once; later calls are ignored. */
function finish(result: Result) {
  if (settled) return;
  settled = true;
  (window as unknown as Record<string, unknown>).__thumb = result;
  document.title = result.ok ? 'thumb-ok' : 'thumb-error';
  if (!result.ok) console.warn('thumb:', result.error);
  window.dispatchEvent(new CustomEvent('thumb-ready', { detail: result }));
}

setTimeout(() => finish({ ok: false, error: `timeout after ${TIMEOUT_MS} ms` }), TIMEOUT_MS);

async function run() {
  // Same-origin, and under the API's asset prefix. thumbUrl.ts holds the rule and its tests:
  // this page is public, and without that check it renders any URL anyone hands it.
  const mesh = meshUrl(new URLSearchParams(location.search).get('glb'), location.origin);
  if ('error' in mesh) return finish({ ok: false, error: mesh.error });

  // A renderer only so ObjectLoader can ask it what texture formats exist. The picture is
  // drawn by renderThumbnail on its own offscreen stage.
  const probe = new THREE.WebGLRenderer();
  probe.setSize(1, 1);
  let picture: HTMLCanvasElement;
  try {
    // scale 1: a server mesh is already in metres and a picture of it never re-guesses that.
    picture = await renderThumbnail(new ObjectLoader(probe), mesh.url, 1);
  } catch (err) {
    return finish({ ok: false, error: `render failed: ${(err as Error).message}` });
  }
  // On the page at its exact size, so a screenshot is as good as the data URL.
  document.body.appendChild(picture);
  finish({ ok: true, dataUrl: picture.toDataURL('image/jpeg', JPEG_QUALITY), width: picture.width, height: picture.height });
}

void run().catch((err) => finish({ ok: false, error: `unexpected: ${(err as Error).message}` }));
