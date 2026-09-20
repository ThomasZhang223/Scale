import * as THREE from 'three';

/*
 * Switching rooms without leaving VR.
 *
 * A page reload would drop the XR session and throw the person out of the headset, so the room
 * is torn down and rebuilt in place. Three pieces live here: the list of rooms you may switch
 * to, the state machine that says what a switch is doing, and the fade that covers it.
 */

export interface RoomChoice {
  id: string;
  label: string;
}

/**
 * The rooms on offer, from committed config — never a listing of the rooms table.
 *
 * That table holds every throwaway and smoke room four panels have made tonight, so "the rooms
 * that exist" and "the rooms worth standing in" are different sets, and only one of them can be
 * written down. Missing or malformed config gives an empty list and says why: a picker with
 * nothing in it is honest, and "the first room in the table" is a guess about what someone meant.
 */
export function parseRooms(raw: string | undefined): RoomChoice[] {
  if (!raw?.trim()) {
    console.warn('VITE_ROOMS is not set: no rooms to switch between.');
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.map((entry, i) => {
      const { id, label } = (entry ?? {}) as { id?: unknown; label?: unknown };
      if (typeof id !== 'string' || !id) throw new Error(`entry ${i} has no id`);
      if (typeof label !== 'string' || !label) throw new Error(`entry ${i} (${id}) has no label`);
      return { id, label };
    });
  } catch (err) {
    console.error(`VITE_ROOMS is not a list of {id, label}: ${(err as Error).message}. Value was:`, raw);
    return [];
  }
}

export type SwitchState = 'idle' | 'switching' | { error: string };

/**
 * The room controls, filled in by main.ts once the scene exists.
 *
 * A handle rather than direct exports, because switching a room needs the scene, the physics
 * world and the live feed — all of which live inside main. The picker imports this; main imports
 * nothing of the picker's.
 */
export const roomControl: {
  currentRoomId: () => string;
  switchRoom: (id: string) => Promise<void>;
  onSwitchState: (cb: (s: SwitchState) => void) => void;
} = {
  currentRoomId: () => '',
  switchRoom: async () => { throw new Error('The room switch is not ready yet.'); },
  onSwitchState: () => {},
};

/**
 * What a switch is doing, so nothing has to infer it from a promise.
 *
 * `covered` is the part the rest of the app asks about: while the view is behind the fade, a
 * press must not reach an object. Deleting into a room that is on its way out would take a thing
 * the person can no longer see — the same rule as every other guard on the delete button.
 */
export class RoomSwitch {
  private phase: 'idle' | 'out' | 'load' | 'in' = 'idle';
  error: string | null = null;

  /** True once the fade has started covering the view, until it has finished uncovering it. */
  get covered(): boolean {
    return this.phase === 'out' || this.phase === 'load';
  }

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  /** False when a switch is already running: a second request is dropped, never queued. */
  begin(): boolean {
    if (this.busy) return false;
    this.phase = 'out';
    this.error = null;
    return true;
  }

  covering(): void {
    if (this.phase === 'out') this.phase = 'load';
  }

  uncovering(): void {
    if (this.phase === 'load') this.phase = 'in';
  }

  finish(): void {
    this.phase = 'idle';
  }

  /** The new room did not load. The caller fades back into the room it never left. */
  fail(reason: string): void {
    this.error = reason;
    this.phase = 'in';
  }
}

/**
 * A black shell around the camera, drawn last with no depth test, so it covers the room in both
 * eyes in XR and on the laptop. A sphere rather than a quad: a quad has edges, and in a headset
 * you can look past the edge of a quad.
 */
export class ViewFade {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshBasicMaterial;
  private from = 0;
  private to = 0;
  private started = 0;
  private ms = 1;

  constructor() {
    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide, // seen from inside
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), this.material);
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  /** Attaches to the camera, so it moves with the head and covers the view whatever it does. */
  attachTo(camera: THREE.Object3D): void {
    camera.add(this.mesh);
  }

  to0(ms: number): Promise<void> {
    return this.tween(0, ms);
  }

  to1(ms: number): Promise<void> {
    return this.tween(1, ms);
  }

  private tween(to: number, ms: number): Promise<void> {
    this.from = this.material.opacity;
    this.to = to;
    this.ms = Math.max(1, ms);
    this.started = performance.now();
    this.mesh.visible = true;
    return new Promise((resolve) => setTimeout(resolve, this.ms));
  }

  /** Called every frame. Ease in and out, so neither end of the fade snaps. */
  update(): void {
    if (!this.mesh.visible) return;
    const t = Math.min(1, (performance.now() - this.started) / this.ms);
    const eased = t * t * (3 - 2 * t);
    this.material.opacity = this.from + (this.to - this.from) * eased;
    if (t >= 1 && this.to === 0) this.mesh.visible = false; // clear again: stop drawing it
  }
}

/**
 * Where to stand in a room of this size, and which way to look.
 *
 * The rooms differ in shape, so a pose that is comfortable in one is inside a wall in the other.
 * Stand a third of the way in from the back wall, looking at the front one.
 */
export function seatIn(size: { width: number; depth: number }): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const back = size.depth / 2;
  return {
    position: new THREE.Vector3(0, 0, Math.max(0.4, back - size.depth / 3)),
    lookAt: new THREE.Vector3(0, 1.4, -back),
  };
}

/** Frees the GPU memory a room's meshes hold. The Quest has little, and rooms are big textures. */
export function disposeRoom(group: THREE.Object3D): void {
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
      const map = (material as THREE.MeshBasicMaterial).map;
      if (map) map.dispose();
      material.dispose();
    }
  });
}
