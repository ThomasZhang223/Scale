import * as THREE from 'three';

/*
 * The transcript: a card floating in front of you, a little below eye level, that follows
 * your head lazily — it stays put while you read and glides over only when you turn well
 * away from it. It shows what was heard and what the designer said back — the summary, why
 * the layout is the way it is, the trade-off, and any error, in full. It never truncates:
 * lines wrap and the card grows downward. It leaves on its own once the dialogue is over
 * (speech finished, or nothing new for a while), or at once from the × in its corner; a new
 * message brings it back. Hidden in the spectator view, where the laptop has its own log.
 */

export type Tone = 'heard' | 'info' | 'warn' | 'error';
export interface HudLine {
  text: string;
  tone: Tone;
}

const PX = 2400;                 // canvas px per metre
const WIDTH = 0.72;              // metres, at DISTANCE: comfortable reading width
const PAD = 0.024;
const LINE_H = 0.03;             // metres per wrapped line
const GAP = 0.01;                // between entries
const RADIUS = 0.024;
const MAX_LINES = 12;            // the panel's ceiling; older lines fall off the top
const DISTANCE = 1.25;           // metres in front of the eyes
const DROP = 0.12;               // below eye level, so it never covers what you are looking at
const REANCHOR_ANGLE = 0.5;      // rad: how far the head turns before the card follows
const REANCHOR_DIST = 0.45;      // metres: how far the head moves before the card follows
const FOLLOW = 5;                // 1/s: glide rate toward the new spot
const AUTO_HIDE_MS = 12_000;     // nothing new for this long → gone
const AFTER_SPEECH_MS = 2_000;   // spoken dialogue finished → gone shortly after

const COLOR: Record<Tone, string> = {
  heard: 'rgba(235,235,245,0.60)',
  info: '#FFFFFF',
  warn: '#FF9F0A',
  error: '#FF453A',
};
const BACKGROUND = 'rgba(28,28,30,0.88)';
const CLOSE_R = 0.036;           // the × button's radius (top-right corner): a real target for a ray
const CLOSE_INSET = 0.046;
const FONT = `${0.02 * PX}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`;

export class Hud {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private lines: HudLine[] = [];
  private presenting = false;
  private dismissed = false;
  private hideAt = 0;              // performance.now() deadline; 0 = none
  private anchored = false;
  /** The × in the top-right corner; the only part of the panel a ray can hit. */
  private readonly close: THREE.Mesh;

  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly toCard = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();

  constructor() {
    this.group.name = 'hud';
    this.group.visible = false;
    this.close = closeButton();
    this.group.add(this.close);
  }

  /** True when the ray is on the × button. */
  hitTest(raycaster: THREE.Raycaster): boolean {
    return this.group.visible && raycaster.intersectObject(this.close, false).length > 0;
  }

  /** Hides the card until the next message arrives. */
  dismiss() {
    this.dismissed = true;
    this.hideAt = 0;
    this.group.visible = false;
  }

  /** The spoken reply has finished: the card has done its job, let it go shortly. */
  speechEnded() {
    if (this.dismissed) return;
    this.hideAt = now() + AFTER_SPEECH_MS;
  }

  /** Add to the scene; place() moves it every frame. */
  attachTo(scene: THREE.Object3D) {
    scene.add(this.group);
  }

  /**
   * Once a frame. The card sits DISTANCE ahead of the eyes along the head's yaw (never
   * pitch: looking down must not push it into the floor), DROP below eye level, facing the
   * eyes. It re-anchors only when the head has turned or moved well away from it, and then
   * glides rather than jumps. Expired cards are let go here too.
   */
  place(head: THREE.Object3D, dt = 1 / 72) {
    if (this.hideAt && now() >= this.hideAt) this.dismiss();
    head.getWorldPosition(this.eye);
    head.getWorldQuaternion(this.quat);
    this.forward.set(0, 0, -1).applyQuaternion(this.quat);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    this.target.copy(this.eye).addScaledVector(this.forward, DISTANCE);
    this.target.y = this.eye.y - DROP;

    if (!this.anchored) {
      this.group.position.copy(this.target);
      this.anchored = true;
    } else {
      this.toCard.subVectors(this.group.position, this.eye);
      this.toCard.y = 0;
      const dist = this.toCard.length();
      const angle = dist > 1e-6 ? Math.acos(Math.max(-1, Math.min(1, this.toCard.dot(this.forward) / dist))) : 0;
      if (angle > REANCHOR_ANGLE || Math.abs(dist - DISTANCE) > REANCHOR_DIST || Math.abs(this.group.position.y - this.target.y) > REANCHOR_DIST) {
        this.group.position.lerp(this.target, Math.min(1, FOLLOW * dt));
      }
    }
    this.group.lookAt(this.eye);
    this.group.visible = this.presenting && this.mesh !== null && !this.dismissed;
  }

  /** Only shown inside the headset; the spectator view has the laptop panel. */
  setPresenting(on: boolean) {
    this.presenting = on;
    this.group.visible = on && this.mesh !== null;
  }

  /**
   * Replaces the transcript. Empty hides the card. Only a genuinely new message brings a
   * dismissed card back — a redraw of the same lines (the palette refreshing) does not.
   */
  set(lines: HudLine[]) {
    const next = lines.filter((l) => l.text.trim());
    const changed = next.length !== this.lines.length || next.some((l, i) => l.text !== this.lines[i]?.text || l.tone !== this.lines[i]?.tone);
    this.lines = next;
    if (changed) {
      this.dismissed = false;
      this.hideAt = now() + AUTO_HIDE_MS;
      this.anchored = false; // a fresh message appears where you are looking now
    }
    this.redraw();
  }

  /** Adds one line at the bottom, dropping the oldest when the card is full. */
  push(text: string, tone: Tone = 'info') {
    if (!text.trim()) return;
    this.lines.push({ text, tone });
    this.dismissed = false;
    this.hideAt = now() + AUTO_HIDE_MS;
    this.redraw();
  }

  clear() {
    this.set([]);
  }

  private redraw() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      ((this.mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture | null)?.dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
    if (!this.lines.length || typeof document === 'undefined') {
      this.group.visible = false;
      return;
    }
    // Measure with a throwaway context so the canvas can be sized to the wrapped text.
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = FONT;
    const maxTextPx = (WIDTH - 2 * PAD) * PX;
    let wrapped: { text: string; tone: Tone; first: boolean }[] = [];
    for (const l of this.lines) {
      wrap(probe, l.text, maxTextPx).forEach((t, i) => wrapped.push({ text: t, tone: l.tone, first: i === 0 }));
    }
    // Newest at the bottom; the oldest lines fall off the top.
    if (wrapped.length > MAX_LINES) {
      wrapped = wrapped.slice(-MAX_LINES);
      wrapped[0].first = true;
    }
    const entries = wrapped.filter((w) => w.first).length;
    const height = 2 * PAD + wrapped.length * LINE_H + Math.max(0, entries - 1) * GAP;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(WIDTH * PX);
    canvas.height = Math.round(height * PX);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = BACKGROUND;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, RADIUS * PX);
    ctx.fill();
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    let y = PAD * PX;
    for (const w of wrapped) {
      if (w.first && y > PAD * PX) y += GAP * PX;
      ctx.fillStyle = COLOR[w.tone];
      ctx.fillText(w.text, PAD * PX, y + (LINE_H * PX) / 2);
      y += LINE_H * PX;
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, height),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 999; // always readable, never clipped by a wall or the phone
    this.mesh.raycast = () => {};
    // Grow downward: the top edge stays put as the panel gets taller.
    this.mesh.position.y = -height / 2;
    this.group.add(this.mesh);
    this.close.position.set(WIDTH / 2 - CLOSE_INSET, -CLOSE_INSET, 0.002);
    this.group.visible = this.presenting && !this.dismissed;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** A grey disc with a white ×, drawn once. */
function closeButton(): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
  if (typeof document !== 'undefined') {
    const px = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(120,120,128,0.85)';
    ctx.beginPath();
    ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    const a = px * 0.33, b = px * 0.67;
    ctx.beginPath();
    ctx.moveTo(a, a); ctx.lineTo(b, b);
    ctx.moveTo(b, a); ctx.lineTo(a, b);
    ctx.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    material.map = texture;
  }
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(CLOSE_R, 32), material);
  mesh.renderOrder = 1000;
  mesh.name = 'hud-close';
  return mesh;
}

/** Greedy word wrap; a single word longer than the line is broken by characters. */
export function wrap(ctx: { measureText(s: string): { width: number } }, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = '';
      let piece = word;
      while (ctx.measureText(piece).width > maxWidth && piece.length > 1) {
        let cut = piece.length - 1;
        while (cut > 1 && ctx.measureText(piece.slice(0, cut)).width > maxWidth) cut--;
        out.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      line = piece;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}
