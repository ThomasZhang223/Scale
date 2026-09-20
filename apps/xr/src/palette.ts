import * as THREE from 'three';
import { wrap } from './hud.ts';

/*
 * The wrist panel, drawn as a phone: a dark rounded body on the left controller with an
 * iOS-style screen (docs: apple-ui-styling.md, dark mode) — inset grouped lists with
 * section headers, hairline separators and 44 pt rows, a widget grid for the furniture,
 * one accent colour for actions, red only for the destructive one, orange for warnings.
 * Point the other controller's ray at a row and pull the trigger. The panel is never a
 * physics pickable, so it can't be grabbed itself.
 */

export interface PaletteItem {
  url: string;
  name: string;
  scale?: number;
  size?: THREE.Vector3; // known once the GLB has loaded
  action?: string; // an action row (Reset, Accept…) instead of an object to pull out
  objectId?: string; // the server's Object v1 id, when it came from there
  label?: boolean; // a text line (status, log): drawn, never hit
  severity?: 'info' | 'warn'; // labels only: orange for warnings
  accent?: boolean; // the one prominent, filled action (Accept, Rearrange)
  destructive?: boolean; // red text (Clear objects)
  section?: string; // grouped list section; consecutive items share one group
}

// iOS dark-mode tokens, from apple-ui-styling.md.
const C = {
  screen: '#000000',
  cell: '#1C1C1E',
  cellPressed: '#2C2C2E',
  frame: '#2C2C2E',
  island: '#151517',
  label: '#FFFFFF',
  secondary: 'rgba(235,235,245,0.60)',
  tertiary: 'rgba(235,235,245,0.30)',
  separator: 'rgba(84,84,88,0.60)',
  accent: '#0A84FF',
  red: '#FF453A',
  orange: '#FF9F0A',
  orangeFill: 'rgba(255,159,10,0.16)',
};

// Metres on the wrist; canvas pixels map 1 m → 4000 px, so a 44 pt row is 0.034 m.
const PX = 4000;
const COLS = 4;                  // four cells across: wide and short
const COL_W = 0.115;
const WINDOW_SCALE = 2.2;        // the phone-scale layout, blown up to a window ~1 m wide
const WINDOW_DISTANCE = 1.4;     // metres ahead of the eyes when first shown
const WINDOW_DROP = 0.2;         // metres below eye level (window centre)
const BAR = { w: 0.14, h: 0.012, gap: 0.014 }; // the drag bar under the window, Quest-style
const GAP_X = 0.006;
const ROW_H = 0.037;
const HEADER_H = 0.022;
const GROUP_GAP = 0.012;
const MARGIN = 0.012;
const BEZEL = 0.007;
// The tab bar along the top, like a browser tab: a title, no notch.
const TAB_H = 0.02;
const TAB_GAP = 0.004;
const ROW_W = COLS * COL_W + (COLS - 1) * GAP_X;
const SCREEN_W = ROW_W + 2 * MARGIN;
const RADIUS_CELL = 0.004; // ~12 pt, grouped list corners
const RADIUS_SCREEN = 0.014;
const RADIUS_FRAME = RADIUS_SCREEN + BEZEL;
const LABEL_LINE_H = 0.0145; // one wrapped footnote line; a label row grows by this per extra line
const LABEL_PAD = 64; // canvas px, the leading text inset of a row

interface Slot {
  item: PaletteItem;
  x: number; // centre
  y: number; // centre, from the top of the screen (positive down)
  w: number;
  h: number;
  corners: [boolean, boolean, boolean, boolean]; // TL, TR, BR, BL rounded
  separator: boolean;
  header?: string; // a section header drawn above this slot's group
  lines?: string[]; // labels only: the text wrapped to the row's width, never truncated
}

/** A throwaway context for measuring text at layout time; null in tests (no document). */
let measurer: CanvasRenderingContext2D | null | undefined;
function measure(): CanvasRenderingContext2D | null {
  if (measurer === undefined) measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  return measurer;
}

export class Palette {
  /**
   * A window floating in the room, like the Quest's own: it stands where you leave it, you
   * drag it by its bar (or its frame) and push it further or pull it closer with the stick,
   * and it never closes. Hidden until it has items.
   */
  readonly group = new THREE.Group();
  private tiles: THREE.Mesh[] = [];
  private grabTargets: THREE.Object3D[] = [];
  private hovered: THREE.Mesh | null = null;

  constructor() {
    this.group.name = 'palette';
    this.group.visible = false;
    // The layout is drawn at phone scale (metres per row, canvas px per metre) and the whole
    // window is scaled up: text, tiles and bar grow together, nothing is re-typeset.
    this.group.scale.setScalar(WINDOW_SCALE);
  }

  attachTo(parent: THREE.Object3D) {
    parent.add(this.group);
  }

  /** Puts the window ahead of the eyes, a little below eye level, facing them. */
  placeInFront(eye: THREE.Vector3, forward: THREE.Vector3) {
    this.group.position.copy(eye).addScaledVector(forward, WINDOW_DISTANCE);
    this.group.position.y = eye.y - WINDOW_DROP;
    this.group.lookAt(eye);
  }

  /** The bar or frame under the ray: the handle for dragging the window. */
  hitGrab(raycaster: THREE.Raycaster): THREE.Intersection | null {
    if (!this.group.visible) return null;
    const [hit] = raycaster.intersectObjects(this.grabTargets, false);
    return hit ?? null;
  }

  setItems(items: PaletteItem[]) {
    this.group.clear();
    this.tiles = [];
    this.hovered = null;
    this.group.visible = items.length > 0;
    if (!items.length) return;

    const slots = layout(items);
    const screenH = (slots.at(-1)!.y + slots.at(-1)!.h / 2) + MARGIN + TAB_H + TAB_GAP;
    const frameW = SCREEN_W + 2 * BEZEL;
    const frameH = screenH + 2 * BEZEL;

    // The window: a thin frame, the screen, a title bar along the top, and the drag bar below.
    const frame = plate(frameW, frameH, RADIUS_FRAME, C.frame, -0.0025);
    this.group.add(frame);
    this.group.add(plate(SCREEN_W, screenH, RADIUS_SCREEN, C.screen, -0.0015));
    const tab = text('Full Scale  ·  drag the bar to move, stick to push or pull', ROW_W, TAB_H, { font: 'footnote', color: C.secondary, background: C.island, padding: 20 });
    tab.position.set(0, screenH / 2 - TAB_H / 2 - 0.002, -0.0005);
    this.group.add(tab);
    const bar = plate(BAR.w, BAR.h, BAR.h / 2, 'rgba(235,235,245,0.85)', 0);
    bar.position.y = -frameH / 2 - BAR.gap;
    this.group.add(bar);
    this.grabTargets = [bar, tab, frame];

    const top = screenH / 2 - TAB_H - TAB_GAP; // y of the screen's usable top edge
    for (const s of slots) {
      if (s.header) {
        const h = text(s.header, ROW_W, HEADER_H, { font: 'footnote', color: C.secondary, background: null, padding: 16 });
        h.position.set(0, top - (s.y - s.h / 2 - HEADER_H / 2), 0);
        h.raycast = () => {};
        this.group.add(h);
      }
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(s.w, s.h),
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, map: draw(s) }),
      );
      tile.position.set(s.x, top - s.y, 0);
      tile.userData.item = s.item;
      if (s.item.label) tile.raycast = () => {}; // text lines are never hit
      else this.tiles.push(tile);
      this.group.add(tile);
    }
  }

  /** The item under the ray, if any. */
  hitTest(raycaster: THREE.Raycaster): PaletteItem | null {
    if (!this.group.visible) return null;
    const [hit] = raycaster.intersectObjects(this.tiles, false);
    return hit ? (hit.object.userData.item as PaletteItem) : null;
  }

  /** iOS press feedback: the row dims while the ray rests on it. */
  hover(item: PaletteItem | null) {
    const tile = item ? this.tiles.find((t) => t.userData.item === item) ?? null : null;
    if (tile === this.hovered) return;
    if (this.hovered) (this.hovered.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
    if (tile) (tile.material as THREE.MeshBasicMaterial).color.setHex(0xb8b8b8);
    this.hovered = tile;
  }
}

// ---------- layout ----------

/** Rows for actions and text, a two-column widget grid for objects, grouped by section. */
function layout(items: PaletteItem[]): Slot[] {
  const slots: Slot[] = [];
  let y = 0;
  let i = 0;
  let lastSection: string | undefined;
  const isObject = (it: PaletteItem) => !it.action && !it.label;
  while (i < items.length) {
    const item = items[i];
    const section = item.section ?? '';
    const newGroup = slots.length === 0 || section !== lastSection;
    if (newGroup) {
      y += slots.length ? GROUP_GAP : 0;
      if (section) y += HEADER_H;
    }
    lastSection = section;
    const header = newGroup && section ? section : undefined;
    const groupEnd = (k: number) => k >= items.length || (items[k].section ?? '') !== section;
    if (isObject(item)) {
      // A row of up to COLS widget cells, left to right.
      const row: PaletteItem[] = [];
      for (let k = i; k < i + COLS && !groupEnd(k) && isObject(items[k]); k++) row.push(items[k]);
      row.forEach((p, col) => {
        slots.push({
          item: p, x: (col - (COLS - 1) / 2) * (COL_W + GAP_X), y: y + ROW_H / 2, w: COL_W, h: ROW_H,
          corners: [true, true, true, true], separator: false, header: col === 0 ? header : undefined,
        });
      });
      y += ROW_H + GAP_X;
      i += row.length;
      continue;
    }
    const first = newGroup || isObject(items[i - 1]);
    const last = groupEnd(i + 1) || isObject(items[i + 1]);
    const w = ROW_W;
    // A label (an error, a log line) shows every word: it wraps, and the row grows to fit.
    // Buttons and furniture cells stay one line.
    let lines: string[] | undefined;
    let h = ROW_H;
    if (item.label) {
      const ctx = measure();
      if (ctx) {
        ctx.font = FONT.footnote;
        lines = wrap(ctx, item.name, w * PX - 2 * LABEL_PAD);
        h = ROW_H + Math.max(0, lines.length - 1) * LABEL_LINE_H;
      }
    }
    slots.push({
      item, x: 0, y: y + h / 2, w, h,
      corners: [first, first, last, last], separator: !last, header, lines,
    });
    y += h;
    i++;
  }
  return slots;
}

// ---------- drawing ----------

function plate(w: number, h: number, r: number, color: string, z: number): THREE.Mesh {
  const shape = new THREE.Shape();
  const x0 = -w / 2, y0 = -h / 2;
  shape.moveTo(x0 + r, y0);
  shape.lineTo(x0 + w - r, y0);
  shape.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  shape.lineTo(x0 + w, y0 + h - r);
  shape.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  shape.lineTo(x0 + r, y0 + h);
  shape.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  shape.lineTo(x0, y0 + r);
  shape.quadraticCurveTo(x0, y0, x0 + r, y0);
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 8), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  mesh.position.z = z;
  mesh.raycast = () => {};
  return mesh;
}

type Font = 'body' | 'headline' | 'footnote';

const FONT: Record<Font, string> = {
  body: `${17 * 3.4}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`,
  headline: `600 ${17 * 3.4}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`,
  footnote: `${13 * 3.4}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`,
};

function canvasFor(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null; // tests: geometry only
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * PX);
  canvas.height = Math.round(h * PX);
  return { canvas, ctx: canvas.getContext('2d')! };
}

function texture(canvas: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A plain text plate (section headers). */
function text(str: string, w: number, h: number, o: { font: Font; color: string; background: string | null; padding: number }): THREE.Mesh {
  const c = canvasFor(w, h);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true });
  if (c) {
    const { canvas, ctx } = c;
    if (o.background) { ctx.fillStyle = o.background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.font = FONT[o.font];
    ctx.fillStyle = o.color;
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, str, canvas.width - 2 * o.padding), o.padding, canvas.height / 2 + 4);
    material.map = texture(canvas);
  }
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
}

/** One row or widget cell, iOS-style. */
function draw(s: Slot): THREE.Texture | null {
  const c = canvasFor(s.w, s.h);
  if (!c) return null;
  const { canvas, ctx } = c;
  const it = s.item;
  const W = canvas.width, H = canvas.height;
  const r = RADIUS_CELL * PX;
  const radii = s.corners.map((on) => (on ? r : 0)) as [number, number, number, number];

  // Background: grouped cell, the accent fill for the one prominent action, an orange
  // tint for warnings; hairline separator inset from the leading text edge.
  ctx.fillStyle = it.accent ? C.accent : it.label && it.severity === 'warn' ? C.orangeFill : C.cell;
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, radii);
  ctx.fill();
  if (s.separator) {
    ctx.fillStyle = C.separator;
    ctx.fillRect(64, H - 2, W - 64, 2);
  }

  const pad = LABEL_PAD;
  ctx.textBaseline = 'middle';
  if (it.label) {
    ctx.font = FONT.footnote;
    ctx.fillStyle = it.severity === 'warn' ? C.orange : C.secondary;
    const lines = s.lines ?? [fitText(ctx, it.name, W - 2 * pad)];
    const step = LABEL_LINE_H * PX;
    const y0 = H / 2 + 4 - ((lines.length - 1) * step) / 2;
    lines.forEach((line, k) => ctx.fillText(line, pad, y0 + k * step));
  } else if (it.action) {
    ctx.font = it.accent ? FONT.headline : FONT.body;
    ctx.fillStyle = it.accent ? C.label : it.destructive ? C.red : C.accent;
    if (it.accent) {
      const tw = ctx.measureText(it.name).width;
      ctx.fillText(it.name, (W - tw) / 2, H / 2 + 4);
    } else {
      ctx.fillText(fitText(ctx, it.name, W - 2 * pad - 40), pad, H / 2 + 4);
    }
  } else {
    // Furniture cell: name, size in the footnote, a trailing chevron.
    ctx.font = FONT.body;
    ctx.fillStyle = C.label;
    const nameY = it.size ? H * 0.36 : H / 2;
    ctx.fillText(fitText(ctx, it.name, W - 2 * pad - 30), pad * 0.6, nameY + 4);
    if (it.size) {
      ctx.font = FONT.footnote;
      ctx.fillStyle = C.secondary;
      ctx.fillText(`${it.size.x.toFixed(2)} × ${it.size.y.toFixed(2)} × ${it.size.z.toFixed(2)} m`, pad * 0.6, H * 0.72 + 4);
    }
    ctx.font = FONT.headline;
    ctx.fillStyle = C.tertiary;
    ctx.fillText('›', W - pad * 0.75, H / 2 + 4);
  }
  return texture(canvas);
}

/** Truncates with an ellipsis so a line stays readable at arm's length. */
function fitText(ctx: CanvasRenderingContext2D, str: string, maxWidth: number): string {
  if (ctx.measureText(str).width <= maxWidth) return str;
  let cut = str;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}
