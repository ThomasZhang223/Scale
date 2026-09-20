import * as THREE from 'three';

/*
 * A blue halo around one scanned object: dim when a ray or the mouse is over it, bright
 * while it's held. Drawn as a slightly enlarged, back-face-only copy of each of the
 * object's meshes, which reads as a glow around the silhouette and costs almost nothing.
 */

const COLOR = 0x5fb3ff;
const GROW = 1.04;

export class Halo {
  private owner: THREE.Object3D | null = null;
  private copies: THREE.Mesh[] = [];
  private material = new THREE.MeshBasicMaterial({
    color: COLOR,
    side: THREE.BackSide,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });

  show(root: THREE.Object3D, opacity: number) {
    this.material.opacity = opacity;
    if (root === this.owner) return;
    this.hide();
    this.owner = root;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.userData.scannedObject) return;
      const copy = new THREE.Mesh(o.geometry, this.material);
      copy.raycast = () => {}; // never picked instead of the object
      // Grow around the mesh's own centre, not its origin, so the halo stays centred.
      o.geometry.computeBoundingSphere();
      const c = o.geometry.boundingSphere!.center;
      copy.scale.setScalar(GROW);
      copy.position.copy(c).multiplyScalar(1 - GROW);
      o.add(copy);
      this.copies.push(copy);
    });
  }

  hide() {
    for (const copy of this.copies) copy.removeFromParent();
    this.copies = [];
    this.owner = null;
  }
}

/*
 * The surface a carried object would land on: a flat outline under it, at the height it would
 * come to rest. On the floor it says "here"; on a table top it says "on the table", which is the
 * only way to tell the two apart while the object is still in the air.
 */

const PAD_COLOR = 0x5fb3ff;

export class LandingPad {
  readonly mesh: THREE.LineSegments;
  private half = { x: 0, z: 0 };

  constructor() {
    const unit = new THREE.BoxGeometry(1, 0, 1); // a flat box: its edges are the rectangle
    this.mesh = new THREE.LineSegments(
      new THREE.EdgesGeometry(unit),
      new THREE.LineBasicMaterial({ color: PAD_COLOR, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.mesh.renderOrder = 2; // over the floor and over whatever it is resting on
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  /** `y` is the height the object would rest at; the rectangle is its own footprint. */
  show(x: number, y: number, z: number, half: { x: number; z: number }) {
    if (half.x !== this.half.x || half.z !== this.half.z) {
      this.mesh.scale.set(half.x * 2, 1, half.z * 2);
      this.half = { ...half };
    }
    this.mesh.position.set(x, y + 0.002, z); // just clear of the surface, so it never z-fights
    this.mesh.visible = true;
  }

  hide() {
    this.mesh.visible = false;
  }
}
