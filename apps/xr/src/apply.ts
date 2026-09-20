import type { Physics } from './physics';

/*
 * Applying a proposal with physics (docs/agent/04_HEADSET.md): every move becomes a drag
 * target through the same path as grabbing, so objects still stop at walls. The drag itself
 * follows its target directly (no inertia), so to make the move visible the target glides
 * from where the object is to where it's going: eased over GLIDE_S, each object leaving a
 * little after the last. While applying, movers don't collide with each other (or two
 * objects swapping places jam halfway); an object is done within 2 cm and 2° of its target,
 * and anything still moving after TIMEOUT_S is released where physics left it, which is
 * honest and visible.
 */

export interface Move {
  id: string; // physics id
  x: number;
  z: number;
  rotY: number;
}

export interface ApplyResult {
  arrived: string[];
  stuck: string[];
}

const POSITION_TOLERANCE = 0.02;
const ANGLE_TOLERANCE = (2 * Math.PI) / 180;
const GLIDE_S = 1.2;      // how long one object takes to travel
const STAGGER_S = 0.12;   // gap between objects setting off
const TIMEOUT_S = 4;      // after the last object sets off

interface Glide extends Move {
  fromX: number;
  fromZ: number;
  fromRot: number;
  startAt: number; // seconds into the apply
}

export class ProposalApplier {
  private pending = new Map<string, Glide>();
  private arrived: string[] = [];
  private stuck: string[] = [];
  private elapsed = 0;
  private deadline = TIMEOUT_S;
  private onDone: ((result: ApplyResult) => void) | null = null;
  private physics: Physics;

  constructor(physics: Physics) {
    this.physics = physics;
  }

  get active(): boolean {
    return this.pending.size > 0;
  }

  /** Starts moving. `excluded` (e.g. what the person is holding) stays where it is. */
  start(moves: Move[], excluded: string[], onDone: (result: ApplyResult) => void) {
    this.cancel();
    this.onDone = onDone;
    this.elapsed = 0;
    this.arrived = [];
    this.stuck = [];
    // Furthest movers set off first so the long trips don't finish last.
    const order = moves
      .filter((m) => !excluded.includes(m.id) && this.physics.nodeOf(m.id))
      .map((m) => {
        const node = this.physics.nodeOf(m.id)!;
        return { m, dist: Math.hypot(node.position.x - m.x, node.position.z - m.z) };
      })
      .sort((a, b) => b.dist - a.dist);
    order.forEach(({ m }, i) => {
      const node = this.physics.nodeOf(m.id)!;
      this.pending.set(m.id, { ...m, fromX: node.position.x, fromZ: node.position.z, fromRot: this.physics.rotationY(m.id), startAt: i * STAGGER_S });
    });
    this.deadline = TIMEOUT_S + Math.max(0, order.length - 1) * STAGGER_S;
    this.physics.setMovers([...this.pending.keys()]);
    if (!this.pending.size) this.finish();
  }

  /** Feed targets every frame; release each object as it arrives. */
  update(dt: number) {
    if (!this.pending.size) return;
    this.elapsed += dt;
    for (const [id, m] of this.pending) {
      const node = this.physics.nodeOf(id);
      if (!node) {
        this.pending.delete(id);
        continue;
      }
      const dx = node.position.x - m.x;
      const dz = node.position.z - m.z;
      const dr = shortest(this.physics.rotationY(id), m.rotY);
      if (Math.hypot(dx, dz) <= POSITION_TOLERANCE && Math.abs(dr) <= ANGLE_TOLERANCE) {
        this.physics.moveTo(id, m.x, m.z, m.rotY); // land exactly, at rest
        this.arrived.push(id);
        this.pending.delete(id);
        continue;
      }
      if (this.elapsed >= this.deadline) {
        this.physics.release(id);
        this.stuck.push(id);
        this.pending.delete(id);
        continue;
      }
      // Where along its glide this object should be right now.
      const t = ease(Math.min(1, Math.max(0, (this.elapsed - m.startAt) / GLIDE_S)));
      if (t < 1) {
        this.physics.drag(id, m.fromX + (m.x - m.fromX) * t, m.fromZ + (m.z - m.fromZ) * t, m.fromRot + shortest(m.fromRot, m.rotY) * t);
      } else {
        this.physics.drag(id, m.x, m.z, m.rotY); // glide over; physics closes the last gap (or reports stuck)
      }
    }
    if (!this.pending.size) this.finish();
  }

  /** The person grabbed something mid-apply: it stays in their hand, the rest continue. */
  exclude(id: string) {
    if (this.pending.delete(id)) this.physics.setMovers([...this.pending.keys()]);
    if (!this.pending.size && this.onDone) this.finish();
  }

  cancel() {
    for (const id of this.pending.keys()) this.physics.release(id);
    this.pending.clear();
    this.physics.setMovers([]);
    this.onDone = null;
  }

  private finish() {
    this.physics.setMovers([]);
    const done = this.onDone;
    this.onDone = null;
    done?.({ arrived: this.arrived, stuck: this.stuck });
  }
}

/** Ease in and out: slow start, slow landing. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

function shortest(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}
