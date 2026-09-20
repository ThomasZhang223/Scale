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

// Landscape, not square, because the band it lands in is a whole cell wide and only a third
// of one tall (palette.ts COL_W and CELL_THUMB). A square render would be fitted to the band's
// height and leave half the cell's width empty around the object.
const W = 384;
const H = 208;
const VIEW = new THREE.Vector3(1, 0.65, 1).normalize(); // three-quarter, slightly above
const FOV = 35;
const FILL = 0.88; // how much of the frame the object's widest corner should reach

export class Thumbnails {
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private readonly queue: { key: string; url: string; scale?: number }[] = [];
  private readonly asked = new Set<string>();
  private readonly failed = new Set<string>();
  private busy = false;
  private stage: Stage | null = null;

  /**
   * @param loader the app's own GLB loader, so a mesh already in the room is not fetched twice
   * @param onReady called after a picture lands, to redraw whatever is showing it
   */
  constructor(
    private readonly loader: ObjectLoader,
    private readonly onReady: () => void,
  ) {}

  /**
   * The picture for one object, or null while there is none. A null is the tile's cue to
   * draw a placeholder; it is never a reason to invent a different picture.
   */
  get(key: string, url: string, scale?: number): HTMLCanvasElement | null {
    const done = this.cache.get(key);
    if (done) return done;
    if (!url || this.failed.has(key) || this.asked.has(key)) return null;
    this.asked.add(key);
    this.queue.push({ key, url, scale });
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

  private async draw({ key, url, scale }: { key: string; url: string; scale?: number }) {
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
    canvas.getContext('2d')!.drawImage(stage.renderer.domElement, 0, 0);
    this.cache.set(key, canvas);
    this.onReady();
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
 * presenting; a separate 384 x 208 context costs a little memory once and stalls nothing.
 */
function makeStage(): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0); // transparent: the tile's own cell colour shows through
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x3a3a3c, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 3, 2);
  scene.add(key);
  return { renderer, scene, camera: new THREE.PerspectiveCamera(FOV, W / H, 0.01, 100) };
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
