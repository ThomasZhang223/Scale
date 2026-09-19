import * as THREE from 'three';

/*
 * Ghosts: a translucent copy of each object that a proposal will move, at its target
 * spot and rotation, plus a thin line on the floor from where it is to where it's going.
 * Ghosts share the objects' geometry and one material, so they cost almost nothing on
 * the Quest; at most one proposal's ghosts exist at a time.
 */

const GHOST_COLOR = 0x5fb3ff;
const LINE_HEIGHT = 0.012;

export interface GhostTarget {
  /** The object's scene node (its meshes are copied); a detected box works too. */
  node: THREE.Object3D;
  from: [number, number, number];
  to: [number, number, number];
  rotY: number;
  size?: THREE.Vector3; // outline box for objects without meshes
}

export class Ghosts {
  readonly group = new THREE.Group();
  private material = new THREE.MeshBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.35, depthWrite: false });
  private lineMaterial = new THREE.LineBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.8 });

  constructor() {
    this.group.name = 'ghosts';
  }

  show(targets: GhostTarget[]) {
    this.clear();
    for (const t of targets) {
      const ghost = new THREE.Group();
      let meshes = 0;
      t.node.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !o.userData.scannedObject) return;
        const copy = new THREE.Mesh(o.geometry, this.material);
        copy.raycast = () => {};
        // Same pose relative to the object's root as the original mesh.
        o.updateWorldMatrix(true, false);
        copy.matrix.copy(t.node.matrixWorld.clone().invert().multiply(o.matrixWorld));
        copy.matrix.decompose(copy.position, copy.quaternion, copy.scale);
        ghost.add(copy);
        meshes++;
      });
      if (!meshes) {
        const s = t.size ?? new THREE.Vector3(0.5, 0.5, 0.5);
        const box = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z).translate(0, s.y / 2, 0), this.material);
        box.raycast = () => {};
        ghost.add(box);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), this.lineMaterial);
        edges.raycast = () => {};
        ghost.add(edges);
      }
      ghost.position.set(t.to[0], t.to[1], t.to[2]);
      ghost.rotation.y = t.rotY;
      ghost.userData.ghost = true;
      this.group.add(ghost);

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(t.from[0], LINE_HEIGHT, t.from[2]),
          new THREE.Vector3(t.to[0], LINE_HEIGHT, t.to[2]),
        ]),
        this.lineMaterial,
      );
      line.raycast = () => {};
      this.group.add(line);
    }
  }

  get count(): number {
    return this.group.children.filter((c) => c.userData.ghost).length;
  }

  clear() {
    for (const child of this.group.children) {
      child.traverse((o) => {
        if (o instanceof THREE.Line || (o instanceof THREE.Mesh && !o.userData.scannedObject && o.geometry.type === 'BoxGeometry')) o.geometry.dispose();
      });
    }
    this.group.clear();
  }
}
