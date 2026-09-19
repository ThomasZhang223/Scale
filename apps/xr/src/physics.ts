import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import type { BuiltRoom } from './roomScan';

/**
 * Physics for scanned objects in a scanned room, using Rapier.
 *
 * - The room is solid: floor, every wall, and every piece of furniture RoomPlan detected
 *   become fixed colliders, built from the same numbers as the visible room.
 * - Scanned objects are dynamic bodies with a convex-hull collider around their real shape.
 *   Gravity drops them onto the floor and they push against each other.
 * - Objects stay upright: tipping is locked, turning around the vertical axis is not.
 *   Furniture that falls over in a demo looks broken, not realistic.
 * - A held object goes straight to the pointer every frame, like dragging a window, but
 *   the move is swept against the room first: it stops at walls and detected furniture
 *   and slides along them, and shoves other scanned objects out of the way.
 */

const STEP = 1 / 60;
const SKIN = 0.005; // stop this far short of a wall so the next sweep isn't already touching
const LIFT = 0.01;  // sweep slightly above the floor so resting on it never counts as a hit

interface Dynamic {
  node: THREE.Object3D;
  body: RAPIER.RigidBody;
  size: THREE.Vector3;
  shape: RAPIER.Shape;
  pick: THREE.Mesh; // invisible box the rays hit: easier to point at than thin geometry
  target?: { x: number; z: number; rotY: number };
  debug: THREE.Object3D;
}

const PICK_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });

export async function createPhysics(scene: THREE.Scene): Promise<Physics> {
  await RAPIER.init();
  return new Physics(scene);
}

export class Physics {
  private world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  private roomBody: RAPIER.RigidBody | null = null;
  private roomHalf = { x: 3, z: 3 };
  private detected = new Map<string, { collider: RAPIER.Collider; debug: THREE.Object3D }>();
  private dynamics = new Map<string, Dynamic>();
  private debugRoom = new THREE.Group();
  private debugVisible = false;
  private accumulator = 0;
  private yaw = new THREE.Euler();
  private quat = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    this.world.timestep = STEP;
    this.debugRoom.visible = false;
    scene.add(this.debugRoom);
  }

  // ---------- the room ----------

  /** Call with a freshly built room, before it's added to the scene or animated. */
  setRoom(built: BuiltRoom) {
    if (this.roomBody) this.world.removeRigidBody(this.roomBody);
    this.detected.clear();
    this.debugRoom.clear();

    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.roomBody = body;
    this.roomHalf = { x: built.size.width / 2, z: built.size.depth / 2 };

    // Floor: a thick slab whose top is y = 0, wider than the room so nothing slips off an edge.
    this.addFixedBox(body, new THREE.Vector3(this.roomHalf.x + 2, 0.5, this.roomHalf.z + 2),
      new THREE.Vector3(0, -0.5, 0), new THREE.Quaternion());

    // Walls: read from the visible meshes, so physics can never disagree with what you see.
    built.group.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    built.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.collider !== 'wall') return;
      const { width, height, depth } = (o.geometry as THREE.BoxGeometry).parameters;
      o.getWorldPosition(p);
      o.getWorldQuaternion(q);
      this.addFixedBox(body, new THREE.Vector3(width / 2, height / 2, depth / 2), p, q);
    });

    // Furniture RoomPlan detected: solid boxes of the measured size.
    for (const o of built.objects) {
      const [w, h, d] = o.dimensions;
      const center = new THREE.Vector3(o.position[0], o.position[1] + h / 2, o.position[2]);
      const rot = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, o.rotationY);
      const { collider, debug } = this.addFixedBox(body, new THREE.Vector3(w / 2, h / 2, d / 2), center, rot);
      this.detected.set(o.identifier, { collider, debug });
    }
    this.refreshQueries();
  }

  /** When a scanned object takes a detected object's place, its box stops being solid. */
  removeDetected(identifier: string) {
    const entry = this.detected.get(identifier);
    if (!entry) return;
    this.world.removeCollider(entry.collider, true);
    entry.debug.removeFromParent();
    this.detected.delete(identifier);
    this.refreshQueries();
  }

  // ---------- scanned objects ----------

  /**
   * Finds a spot where an object of this size fits: the preferred spot if it's free,
   * otherwise the nearest free spot on rings around it, inside the room.
   */
  findFreeSpot(size: THREE.Vector3, rotY: number, prefer = { x: 0, z: 0 }): { x: number; z: number } {
    const shape = new RAPIER.Cuboid(size.x / 2 + 0.02, size.y / 2, size.z / 2 + 0.02);
    const rot = this.quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotY);
    // The object's real footprint once turned, not a circle around it: a long sofa can
    // stand against a wall even though it couldn't spin there.
    const c = Math.abs(Math.cos(rotY));
    const s = Math.abs(Math.sin(rotY));
    const ex = c * size.x / 2 + s * size.z / 2;
    const ez = s * size.x / 2 + c * size.z / 2;
    const fits = (x: number, z: number) =>
      Math.abs(x) + ex <= this.roomHalf.x + 0.05 &&
      Math.abs(z) + ez <= this.roomHalf.z + 0.05 &&
      !this.world.intersectionWithShape({ x, y: size.y / 2 + 0.05, z }, rot, shape);

    if (fits(prefer.x, prefer.z)) return prefer;
    // Small nudges first (5 cm rings out to 60 cm), then wider rings across the room.
    const radii: number[] = [];
    for (let r = 0.05; r <= 0.6; r += 0.05) radii.push(r);
    for (let r = 0.8; r < 6; r += 0.2) radii.push(r);
    for (const r of radii) {
      const steps = Math.max(8, Math.ceil((2 * Math.PI * r) / 0.1));
      let best: { x: number; z: number } | null = null;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = prefer.x + Math.cos(a) * r;
        const z = prefer.z + Math.sin(a) * r;
        if (fits(x, z)) {
          best = { x, z };
          break;
        }
      }
      if (best) return best;
    }
    return prefer; // nothing free: drop it anyway and let the solver push it out
  }

  /** Adds a scanned object, dropped from `dropHeight` so the landing is visible. */
  addObject(id: string, node: THREE.Object3D, size: THREE.Vector3, hull: Float32Array,
    spot: { x: number; z: number }, rotY: number, dropHeight = 0.3) {
    this.remove(id);
    const rot = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotY);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spot.x, dropHeight, spot.z)
        .setRotation(rot)
        .enabledRotations(false, true, false)
        .setLinearDamping(0.6)
        .setAngularDamping(3)
        .setCcdEnabled(true),
    );

    let shape = hull.length >= 12 ? RAPIER.ColliderDesc.convexHull(hull) : null;
    let debug: THREE.Object3D;
    if (shape) {
      debug = wireframe(new ConvexGeometry(toVectors(hull)));
    } else {
      // Degenerate or flat model: fall back to its bounding box.
      shape = RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setTranslation(0, size.y / 2, 0);
      debug = wireframe(new THREE.BoxGeometry(size.x, size.y, size.z).translate(0, size.y / 2, 0));
    }
    this.world.createCollider(shape.setFriction(0.8).setRestitution(0.05).setDensity(250), body);

    debug.visible = this.debugVisible;
    node.add(debug);
    const pick = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z).translate(0, size.y / 2, 0), PICK_MATERIAL);
    node.add(pick);
    node.position.set(spot.x, dropHeight, spot.z);
    node.quaternion.copy(rot);
    this.dynamics.set(id, { node, body, size, shape: shape.shape, pick, debug });
    this.refreshQueries(); // so the next findFreeSpot sees this object
  }

  remove(id: string) {
    const d = this.dynamics.get(id);
    if (!d) return;
    this.world.removeRigidBody(d.body);
    d.debug.removeFromParent();
    d.pick.removeFromParent();
    this.dynamics.delete(id);
  }

  // ---------- moving things ----------

  drag(id: string, x: number, z: number, rotY: number) {
    const d = this.dynamics.get(id);
    if (!d) return;
    d.target = { x, z, rotY };
    d.body.wakeUp();
  }

  /** Moves a detected piece's solid box (it has no body of its own). */
  moveDetected(identifier: string, x: number, z: number, rotY: number, size: [number, number, number]) {
    this.removeDetected(identifier);
    if (!this.roomBody) return;
    const [w, h, d] = size;
    const rot = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotY);
    const entry = this.addFixedBox(this.roomBody, new THREE.Vector3(w / 2, h / 2, d / 2), new THREE.Vector3(x, h / 2, z), rot);
    this.detected.set(identifier, entry);
    this.refreshQueries();
  }

  /**
   * While a proposal is applied, the moving objects ignore each other (otherwise two
   * objects swapping places jam halfway) but still collide with the room and everything
   * else. An empty list restores normal collisions.
   */
  setMovers(ids: string[]) {
    const MOVER = 0x0002;
    for (const [id, d] of this.dynamics) {
      const collider = d.body.collider(0);
      if (ids.includes(id)) collider.setCollisionGroups((MOVER << 16) | (0xffff & ~MOVER));
      else collider.setCollisionGroups(0xffffffff);
    }
  }

  /** Puts an object exactly here (a stored placement), on the floor, at rest. */
  moveTo(id: string, x: number, z: number, rotY: number) {
    const d = this.dynamics.get(id);
    if (!d) return;
    d.target = undefined;
    d.body.setTranslation({ x, y: 0, z }, true);
    d.body.setRotation(this.quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotY), true);
    d.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    d.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.refreshQueries();
  }

  release(id: string) {
    const d = this.dynamics.get(id);
    if (!d) return;
    d.target = undefined;
    const v = d.body.linvel();
    d.body.setLinvel({ x: 0, y: v.y, z: 0 }, true); // stop where it was let go, no sliding
    d.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  rotationY(id: string): number {
    const d = this.dynamics.get(id);
    if (!d) return 0;
    const r = d.body.rotation();
    return this.yaw.setFromQuaternion(this.quat.set(r.x, r.y, r.z, r.w), 'YXZ').y;
  }

  // ---------- queries for interaction ----------

  pickables(): THREE.Object3D[] {
    return [...this.dynamics.values()].map((d) => d.pick);
  }

  nodeOf(id: string): THREE.Object3D | null {
    return this.dynamics.get(id)?.node ?? null;
  }

  idFromObject(obj: THREE.Object3D | null): string | null {
    for (let o = obj; o; o = o.parent) {
      for (const [id, d] of this.dynamics) if (d.node === o) return id;
    }
    return null;
  }

  // ---------- per frame ----------

  step(dt: number) {
    this.followTargets();
    this.accumulator = Math.min(this.accumulator + dt, STEP * 5);
    while (this.accumulator >= STEP) {
      this.world.step();
      this.accumulator -= STEP;
    }
    for (const [id, d] of this.dynamics) {
      const t = d.body.translation();
      const r = d.body.rotation();
      d.node.position.set(t.x, t.y, t.z);
      d.node.quaternion.set(r.x, r.y, r.z, r.w);
      if (t.y < -3) this.rescue(id, d); // escaped the room somehow: put it back
    }
  }

  setDebug(visible: boolean) {
    this.debugVisible = visible;
    this.debugRoom.visible = visible;
    for (const d of this.dynamics.values()) d.debug.visible = visible;
  }

  // ---------- internals ----------

  /**
   * Moves every held object straight to its target. The move is cast as a shape sweep
   * against the room (walls, detected furniture; other scanned objects are excluded so
   * they get pushed instead), stopping at the first hit and sliding the remainder along
   * the surface, so dragging along a wall feels smooth rather than sticky.
   */
  private followTargets() {
    for (const d of this.dynamics.values()) {
      if (!d.target) continue;
      const rot = this.quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, d.target.rotY);
      const t = d.body.translation();
      let dx = d.target.x - t.x;
      let dz = d.target.z - t.z;
      for (let pass = 0; pass < 2 && Math.hypot(dx, dz) > 1e-4; pass++) {
        const from = d.body.collider(0).translation();
        const hit = this.world.castShape(
          { x: from.x, y: from.y + LIFT, z: from.z }, rot, { x: dx, y: 0, z: dz }, d.shape,
          0, 1, false, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, d.body,
        );
        const fraction = hit ? Math.max(0, hit.time_of_impact - SKIN / Math.hypot(dx, dz)) : 1;
        t.x += dx * fraction;
        t.z += dz * fraction;
        d.body.setTranslation(t, true);
        if (!hit) break;
        // Slide what's left along the surface we hit.
        const rx = dx * (1 - fraction);
        const rz = dz * (1 - fraction);
        const along = rx * hit.normal1.x + rz * hit.normal1.z;
        dx = rx - along * hit.normal1.x;
        dz = rz - along * hit.normal1.z;
      }
      d.body.setRotation(rot, true);
      const v = d.body.linvel();
      d.body.setLinvel({ x: 0, y: v.y, z: 0 }, true); // gravity only; no coasting
      d.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /**
   * Rapier only re-indexes colliders for queries like findFreeSpot when the world steps,
   * so after adding or removing colliders we advance one tick (1/60 s, not noticeable).
   */
  private refreshQueries() {
    this.world.step();
  }

  private rescue(id: string, d: Dynamic) {
    const spot = this.findFreeSpot(d.size, this.rotationY(id));
    d.body.setTranslation({ x: spot.x, y: 0.3, z: spot.z }, true);
    d.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  private addFixedBox(body: RAPIER.RigidBody, half: THREE.Vector3, center: THREE.Vector3, rot: THREE.Quaternion) {
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setTranslation(center.x, center.y, center.z)
        .setRotation(rot)
        .setFriction(0.9),
      body,
    );
    const debug = wireframe(new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2));
    debug.position.copy(center);
    debug.quaternion.copy(rot);
    this.debugRoom.add(debug);
    return { collider, debug };
  }
}

const DEBUG_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x4cd28a, wireframe: true, transparent: true, opacity: 0.6 });

function wireframe(geometry: THREE.BufferGeometry): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, DEBUG_MATERIAL);
  mesh.raycast = () => {}; // never grabbed or hit by pointer rays
  return mesh;
}

function toVectors(points: Float32Array): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i += 3) out.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
  return out;
}
