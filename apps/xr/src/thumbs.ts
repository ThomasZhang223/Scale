import * as THREE from 'three';
import type { ObjectLoader } from './objects';

/*
 * A picture of the thing itself, for a palette tile.
 *
 * Every finished phone scan on the server is called "Captured object" and has category
 * "unknown", so a list of them is four identical rows and the picture is the only way to
 * tell one from another. This draws each mesh once, three-quarter view, framed to its own
 * bounding box, and keeps the result.
 *
 * It never touches the mesh. The camera is fitted to the object, not the object to the
 * camera, so nothing downstream ever rescales a GLB (standing rule 2).
 *
 * Budget, because this runs in a Quest browser:
 *  - one object at a time, taken from a queue, never a burst;
 *  - only tiles on the page you are looking at ask for one (palette.ts pulls, it is not pushed);
 *  - the drawing happens on its own small offscreen canvas, so the XR frame loop is never
 *    stalled reading pixels back from the headset's own renderer;
 *  - the answer is cached per key and drawn once.
 */

// Square, because the same picture serves two slots of different shape: the tablet's wide
// cell band and the popout card's square well. A square is fitted by height in the first and
// exactly in the second, so the object is the same size in both; a landscape render would fill
// the tablet a little better and then sit in the middle third of the card, looking tiny.
//
// Rendered at RENDER and kept at W for a tile. The larger size is what the search index wants
// (publish below); downscaling into the tile cache is one render path rather than two, and a
// tile drawn down from 512 is sharper than one drawn at 256.
const RENDER = 512;
const W = 256;
const H = 256;
const VIEW = new THREE.Vector3(1, 0.65, 1).normalize(); // three-quarter, slightly above
const FOV = 35;
const FILL = 0.88; // how much of the frame the object's widest corner should reach

export class Thumbnails {
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private readonly queue: { key: string; url: string; scale?: number; publish?: boolean }[] = [];
  private readonly asked = new Set<string>();
  private readonly failed = new Set<string>();
  /** Objects whose picture has already been sent to the index. One attempt each, ever. */
  private readonly published = new Set<string>();
  private busy = false;
  private stage: Stage | null = null;

  private readonly loader: ObjectLoader;
  private readonly onReady: () => void;
  /**
   * Where a freshly rendered picture goes when the object has none of its own. Object Capture
   * uploads only the mesh, so for a phone scan this render is the only image of it that exists
   * anywhere, and without one every scan embeds to the same point and "find my chair" cannot
   * rank them. Fire-and-forget: it must never be awaited on the way to a frame.
   */
  private readonly publish: ((objectId: string, jpeg: Blob) => void) | null;

  /**
   * Written out rather than as constructor parameter properties on purpose: node's strip-only
   * TypeScript loader refuses a file that uses those, and this module has logic worth testing —
   * who gets published, how often, and that nothing waits on a frame. Same reason controls.ts
   * exists as its own file.
   *
   * @param loader the app's own GLB loader, so a mesh already in the room is not fetched twice
   * @param onReady called after a picture lands, to redraw whatever is showing it
   * @param publish where a scan's picture goes; omit it and nothing is sent
   */
  constructor(loader: ObjectLoader, onReady: () => void, publish: ((objectId: string, jpeg: Blob) => void) | null = null) {
    this.loader = loader;
    this.onReady = onReady;
    this.publish = publish;
  }

  /**
   * The picture for one object, or null while there is none. A null is the tile's cue to
   * draw a placeholder; it is never a reason to invent a different picture.
   */
  get(key: string, url: string, scale?: number, publish = false): HTMLCanvasElement | null {
    const done = this.cache.get(key);
    if (done) return done;
    if (!url || this.failed.has(key) || this.asked.has(key)) return null;
    this.asked.add(key);
    this.queue.push({ key, url, scale, publish });
    return null;
  }

  /** Once a frame, from the render loop. At most one object is in flight at a time. */
  update() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    void this.draw(this.queue.shift()!).finally(() => {
      this.busy = false;
    });
  }

  /** Gives back the offscreen renderer. The cached pictures are plain canvases and need none. */
  dispose() {
    this.stage?.renderer.dispose();
    this.stage = null;
  }

  private async draw({ key, url, scale, publish }: { key: string; url: string; scale?: number; publish?: boolean }) {
    let node: THREE.Object3D;
    try {
      node = (await this.loader.load(url, scale)).node;
    } catch (err) {
      // Loud, and once: a tile with no mesh keeps its placeholder rather than borrowing another's.
      this.failed.add(key);
      console.warn(`No thumbnail for ${key}: ${(err as Error).message}`);
      return;
    }
    const stage = (this.stage ??= makeStage());
    stage.scene.add(node);
    fitCamera(stage.camera, node);
    stage.renderer.render(stage.scene, stage.camera);
    stage.scene.remove(node);
    // No dispose(): ObjectLoader hands out a SkeletonUtils clone that shares its geometries
    // and materials with the cached GLTF, so freeing them here would empty the same model
    // where it stands in the room. Dropping the reference is the whole of the cleanup.

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d')!.drawImage(stage.renderer.domElement, 0, 0, W, H);
    this.cache.set(key, canvas);
    if (publish) this.send(key, stage.renderer.domElement);
    this.onReady();
  }

  /**
   * Sends one picture to the index, once, and never waits for it.
   *
   * The bytes are copied to a canvas of their own FIRST, synchronously. toBlob is asynchronous
   * and the renderer's own canvas is overwritten by the next object in the queue, so encoding
   * straight from it would sooner or later file one object's picture under another's id.
   */
  private send(objectId: string, source: HTMLCanvasElement) {
    if (!this.publish || this.published.has(objectId)) return;
    this.published.add(objectId); // before the attempt: one try per object, success or not
    const frozen = document.createElement('canvas');
    frozen.width = frozen.height = RENDER;
    const ctx = frozen.getContext('2d')!;
    // The render has an alpha channel and JPEG has none, so the background is chosen here
    // rather than left to the encoder, which would give black. White, because these vectors
    // share a namespace with the catalogue's product photos — studio shots on white — and the
    // closer the two sit in the same distribution, the better one text query ranks across both.
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, RENDER, RENDER);
    ctx.drawImage(source, 0, 0);
    frozen.toBlob(
      (blob) => {
        if (blob) this.publish!(objectId, blob);
        else console.warn(`No thumbnail bytes for ${objectId}: the canvas would not encode.`);
      },
      'image/jpeg',
      0.9,
    );
  }
}

interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

/**
 * A second, tiny renderer rather than a render target on the headset's own. Reading pixels
 * back out of the XR renderer means a synchronous GPU stall inside the frame the headset is
 * presenting; a separate 512 px context costs a little memory once and stalls nothing.
 */
function makeStage(): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(RENDER, RENDER, false);
  renderer.setClearColor(0x000000, 0); // transparent: the tile's own cell colour shows through
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x3a3a3c, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 3, 2);
  scene.add(key);
  return { renderer, scene, camera: new THREE.PerspectiveCamera(FOV, 1, 0.01, 100) };
}

/**
 * Frames the camera on the object. The object never moves and is never rescaled — a GLB is
 * bound to real metres exactly once, upstream, and a picture of it is not allowed to change
 * that (standing rule 2).
 *
 * A bounding-sphere fit alone leaves a wide flat piece floating in a third of the frame, so
 * the sphere only gives a starting distance; the eight corners of the real bounding box are
 * then projected and the camera is moved until the furthest of them lands at FILL. A
 * few passes are enough, because the projected size is very nearly inverse in the distance.
 */
function fitCamera(camera: THREE.PerspectiveCamera, node: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(node);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  let distance = radius / Math.sin((camera.fov * Math.PI) / 360);
  const corner = new THREE.Vector3();
  for (let pass = 0; pass < 3; pass++) {
    camera.position.copy(centre).addScaledVector(VIEW, distance);
    camera.near = Math.max(0.001, distance - radius * 2);
    camera.far = distance + radius * 4;
    camera.updateProjectionMatrix();
    camera.lookAt(centre);
    camera.updateMatrixWorld(true);
    // project() reads matrixWorldInverse, which only the renderer normally refreshes.
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    let reach = 0;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      corner.project(camera);
      reach = Math.max(reach, Math.abs(corner.x), Math.abs(corner.y));
    }
    if (reach < 1e-4) break;
    distance *= reach / FILL;
  }
}
