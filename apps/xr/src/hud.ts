import * as THREE from 'three';

/*
 * The transcript: a card on the left hand, just past the top of the phone panel (the phone
 * grows down from the hand, this grows up from the phone's top edge), that shows what was
 * heard and what the designer said back — the summary, why the layout is the way it is, the
 * trade-off, and any error, in full. It never truncates: lines wrap and the card grows.
 * It is a child of Palette.above, so it shares the phone's tilt and follows the hand.
 *
 * The phone keeps the buttons; the reasons live here, in the same glance.
 */

export type Tone = 'heard' | 'info' | 'warn' | 'error';
export interface HudLine {
  text: string;
  tone: Tone;
}

const PX = 4000;                 // canvas px per metre, the same density as the phone
const WIDTH = 0.284;             // metres: the phone's frame width, so the two read as one stack
const PAD = 0.012;
const LINE_H = 0.0145;           // metres per wrapped footnote line, as on the phone
const GAP = 0.006;               // between entries
const RADIUS = 0.018;
const MAX_LINES = 18;            // the card's ceiling; older lines fall off the top
const GAP_ABOVE_PHONE = 0.008;

const COLOR: Record<Tone, string> = {
  heard: 'rgba(235,235,245,0.60)',
  info: '#FFFFFF',
  warn: '#FF9F0A',
  error: '#FF453A',
};
const BACKGROUND = 'rgba(28,28,30,0.88)';
const FONT = `${13 * 3.4}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`;

export class Hud {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private lines: HudLine[] = [];

  constructor() {
    this.group.name = 'hud';
    this.group.position.y = GAP_ABOVE_PHONE;
    this.group.visible = false;
  }

  /** Attach to Palette.above: the phone's top edge, in the phone's own plane. */
  attachTo(anchor: THREE.Object3D) {
    anchor.add(this.group);
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
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide }),
    );
    this.mesh.raycast = () => {};
    // Grow upward, away from the phone: the bottom edge stays on the phone's top edge.
    this.mesh.position.y = height / 2;
    this.group.add(this.mesh);
    this.group.visible = true;
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
