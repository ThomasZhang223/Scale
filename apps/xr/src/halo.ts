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
