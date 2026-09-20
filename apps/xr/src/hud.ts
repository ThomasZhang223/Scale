import * as THREE from 'three';

/*
 * The transcript: its own panel, standing behind the phone on the left hand — further from
 * the eyes than the phone, on the line from the head through the phone, facing the head. So
 * the phone (items, arrangement options) is in front and the dialogue reads behind it, and
 * both move with the hand. It shows what was heard and what the designer said back — the
 * summary, why the layout is the way it is, the trade-off, and any error, in full. It never
 * truncates: lines wrap and the panel grows downward. Hidden in the spectator view, where
 * the laptop has its own log.
 */

export type Tone = 'heard' | 'info' | 'warn' | 'error';
export interface HudLine {
  text: string;
  tone: Tone;
}

const PX = 2400;                 // canvas px per metre
const WIDTH = 0.6;               // metres: wider than the phone, so it shows on both sides of it
const PAD = 0.024;
const LINE_H = 0.03;             // metres per wrapped line
const GAP = 0.01;                // between entries
const RADIUS = 0.024;
const MAX_LINES = 12;            // the panel's ceiling; older lines fall off the top
const BEHIND = 0.5;              // metres past the phone, away from the eyes
const LIFT = 0.12;               // raised so the phone covers the panel's lower part, not its text

const COLOR: Record<Tone, string> = {
  heard: 'rgba(235,235,245,0.60)',
  info: '#FFFFFF',
  warn: '#FF9F0A',
  error: '#FF453A',
};
const BACKGROUND = 'rgba(28,28,30,0.88)';
const FONT = `${0.02 * PX}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`;

export class Hud {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private lines: HudLine[] = [];
  private presenting = false;

  private readonly eye = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor() {
    this.group.name = 'hud';
    this.group.visible = false;
  }

  /** Add to the scene; place() moves it every frame. */
  attachTo(scene: THREE.Object3D) {
    scene.add(this.group);
  }

  /**
   * Once a frame: stand BEHIND metres past the phone on the line from the eyes through it,
   * lifted a little, facing the eyes. With no phone yet (no left controller), stay hidden.
   */
  place(head: THREE.Object3D, phone: THREE.Object3D | null) {
    if (!phone || !phone.visible || !phone.parent) {
      this.group.visible = false;
      return;
    }
    head.getWorldPosition(this.eye);
    phone.getWorldPosition(this.anchor);
    this.dir.subVectors(this.anchor, this.eye).normalize();
    this.group.position.copy(this.anchor).addScaledVector(this.dir, BEHIND);
    this.group.position.y += LIFT;
    this.group.lookAt(this.eye);
    this.group.visible = this.presenting && this.mesh !== null;
  }

  /** Only shown inside the headset; the spectator view has the laptop panel. */
  setPresenting(on: boolean) {
    this.presenting = on;
    this.group.visible = on && this.mesh !== null;
  }

  /** Replaces the transcript. Empty hides the panel. */
  set(lines: HudLine[]) {
    this.lines = lines.filter((l) => l.text.trim());
    this.redraw();
  }

  /** Adds one line at the bottom, dropping the oldest when the panel is full. */
  push(text: string, tone: Tone = 'info') {
    if (!text.trim()) return;
    this.lines.push({ text, tone });
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
    this.group.visible = this.presenting;
  }
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
