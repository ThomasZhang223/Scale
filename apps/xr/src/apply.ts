import type { Physics } from './physics';

/*
 * Applying a proposal with physics (docs/agent/04_HEADSET.md): every move becomes a drag
 * target through the same path as grabbing, so objects still stop at walls. While applying,
 * movers don't collide with each other (or two objects swapping places jam halfway); an
 * object is done within 2 cm and 2° of its target, and anything still moving after 4 s is
 * released where physics left it, which is honest and visible.
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
const TIMEOUT_S = 4;

export class ProposalApplier {
  private pending = new Map<string, Move>();
  private arrived: string[] = [];
  private stuck: string[] = [];
  private elapsed = 0;
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
    for (const m of moves) {
      if (excluded.includes(m.id) || !this.physics.nodeOf(m.id)) continue;
      this.pending.set(m.id, m);
    }
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
      if (this.elapsed >= TIMEOUT_S) {
        this.physics.release(id);
        this.stuck.push(id);
        this.pending.delete(id);
        continue;
      }
      this.physics.drag(id, m.x, m.z, m.rotY);
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

function shortest(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}
