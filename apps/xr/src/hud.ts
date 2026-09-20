import * as THREE from 'three';

/*
 * The transcript: a head-locked card a metre in front of the eyes, just under the line of
 * sight, that shows what was heard and what the designer said back — the summary, why the
 * layout is the way it is, the trade-off, and any error, in full. It never truncates: lines
 * wrap and the card grows downward. It is a child of the camera, so it follows the head in
 * the headset and is hidden in the spectator view (the laptop has its own log).
 *
 * The wrist stays for buttons; explanations live here so they can be read without looking
 * down at your hand.
 */

export type Tone = 'heard' | 'info' | 'warn' | 'error';
export interface HudLine {
  text: string;
  tone: Tone;
}

const PX = 1600;                 // canvas px per metre
const WIDTH = 0.72;              // metres; at 1.1 m that is ~36° wide
const PAD = 0.03;
const LINE_H = 0.036;            // metres per wrapped line
const GAP = 0.012;               // between entries
const RADIUS = 0.03;
const MAX_LINES = 14;            // keep the card from covering the room
const DISTANCE = 1.1;
const DROP = -0.22;              // below the line of sight; the room stays visible above it

const COLOR: Record<Tone, string> = {
  heard: 'rgba(235,235,245,0.60)',
  info: '#FFFFFF',
  warn: '#FF9F0A',
  error: '#FF453A',
};
const BACKGROUND = 'rgba(28,28,30,0.88)';
const FONT = `${0.026 * PX}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`;

export class Hud {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private lines: HudLine[] = [];
  private presenting = false;

  constructor() {
    this.group.name = 'hud';
    this.group.position.set(0, DROP, -DISTANCE);
    this.group.rotation.x = -0.12; // tilted up toward the eyes
    this.group.visible = false;
  }

  /** Attach to the camera (which must itself be in the scene) so the card follows the head. */
  attachTo(camera: THREE.Object3D) {
    camera.add(this.group);
  }

  /** Only shown inside the headset; the spectator view has the laptop panel. */
  setPresenting(on: boolean) {
    this.presenting = on;
    this.group.visible = on && this.mesh !== null;
  }

  /** Replaces the transcript. Empty hides the card. */
  set(lines: HudLine[]) {
    this.lines = lines.filter((l) => l.text.trim());
    this.redraw();
  }

  /** Adds one line at the bottom, dropping the oldest when the card is full. */
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
    this.mesh.renderOrder = 999; // always on top of the room, never clipped by a wall
    this.mesh.raycast = () => {};
    // Grow downward: the top edge stays put as the card gets taller.
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
