import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Loads a scanned object (a GLB, e.g. from Object Capture) and prepares it for the room:
 *  - keeps its real-world size: Object Capture exports in meters, so no fitting is done,
 *    except fixing files that were clearly exported in centimeters or millimeters,
 *  - moves its origin to the bottom-center, so "position" means "the spot on the floor",
 *  - collects points on its surface for a physics collider that hugs its real shape.
 */

export interface LoadedObject {
  node: THREE.Group;           // origin at bottom-center, real-world size
  size: THREE.Vector3;         // width, height, depth in meters
  hull: Float32Array;          // surface points (x, y, z, ...) in the node's own space
  note: string | null;         // set when units were corrected
}

const MAX_HULL_POINTS = 4000;

export class ObjectLoader {
  private loader: GLTFLoader;
  private cache = new Map<string, Promise<GLTF>>();

  constructor(renderer: THREE.WebGLRenderer) {
    const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    const ktx2 = new KTX2Loader()
      .setTranscoderPath(`https://cdn.jsdelivr.net/npm/three@0.${THREE.REVISION}.0/examples/jsm/libs/basis/`)
      .detectSupport(renderer);
    this.loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  }

  async load(url: string, scaleOverride?: number): Promise<LoadedObject> {
    let pending = this.cache.get(url);
    if (!pending) {
      pending = this.loader.loadAsync(url);
      this.cache.set(url, pending);
      pending.catch(() => this.cache.delete(url));
    }
    const gltf = await pending;
    return prepareObject(gltf.scene.clone(true), scaleOverride);
  }
}

/** Exported for tests: works on any Object3D, not just loaded GLBs. */
export function prepareObject(model: THREE.Object3D, scaleOverride?: number): LoadedObject {
  const node = new THREE.Group();
  node.add(model);

  // 1. Units. Real furniture is between a few centimeters and a few meters.
  const raw = measure(node).getSize(new THREE.Vector3());
  const { factor, note } = scaleOverride
    ? { factor: scaleOverride, note: `Scaled by ${scaleOverride} as configured.` }
    : guessUnits(Math.max(raw.x, raw.y, raw.z));
  model.scale.multiplyScalar(factor);

  // 2. Origin to the bottom-center.
  const box = measure(node);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  const size = measure(node).getSize(new THREE.Vector3());

  model.traverse((o) => {
    if (o instanceof THREE.Mesh) o.userData.scannedObject = true;
  });

  return { node, size, hull: surfacePoints(node), note };
}

function measure(node: THREE.Object3D): THREE.Box3 {
  node.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(node, true);
}

function guessUnits(maxDimension: number): { factor: number; note: string | null } {
  if (maxDimension > 5 && maxDimension / 100 <= 5) {
    return { factor: 0.01, note: 'Looked like centimeters; converted to meters.' };
  }
  if (maxDimension > 5) {
    return { factor: 0.001, note: 'Looked like millimeters; converted to meters.' };
  }
  return { factor: 1, note: null };
}

/**
 * Samples vertices (rounded to 1 cm, duplicates dropped) as input for a convex-hull
 * collider. Plenty for furniture, and cheap enough for the Quest.
 */
function surfacePoints(node: THREE.Object3D): Float32Array {
  node.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  let total = 0;
  node.traverse((o) => {
    if (o instanceof THREE.Mesh && o.geometry.attributes.position) {
      meshes.push(o);
      total += o.geometry.attributes.position.count;
    }
  });

  const stride = Math.max(1, Math.ceil(total / (MAX_HULL_POINTS * 4)));
  const seen = new Set<string>();
  const points: number[] = [];
  const v = new THREE.Vector3();

  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const key = `${Math.round(v.x * 100)},${Math.round(v.y * 100)},${Math.round(v.z * 100)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(v.x, v.y, v.z);
      if (points.length / 3 >= MAX_HULL_POINTS) return new Float32Array(points);
    }
  }
  return new Float32Array(points);
}
