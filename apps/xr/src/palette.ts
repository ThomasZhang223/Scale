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
  page?: string; // the tab this item lives under; a section with no page is its own page
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
// One page at a time, so the window no longer has to hold everything: it is ~0.74 m wide
// instead of ~1.05 m. Body text still measures ~1.6 cm cap height at arm's length and rows
// are ~5.7 cm tall, both above what a Quest can read and hit comfortably.
const WINDOW_SCALE = 1.55;       // the phone-scale layout, blown up to a window ~0.74 m wide
const WINDOW_DISTANCE = 1.4;     // metres ahead of the eyes when first shown
const WINDOW_DROP = 0.2;         // metres below eye level (window centre)
const BAR = { w: 0.14, h: 0.012, gap: 0.014 }; // the drag bar under the window, Quest-style
const GAP_X = 0.006;
const ROW_H = 0.037;
// An object cell is more than twice a row, because it carries a picture of the thing itself.
// Every finished phone scan is called "Captured object", so the picture is the only way to
// tell two of them apart — it gets the top two thirds of the cell and the words get the rest.
const CELL_H = 0.096;
const CELL_THUMB = 0.052;
const HEADER_H = 0.022;
const GROUP_GAP = 0.012;
const MARGIN = 0.012;
const BEZEL = 0.007;
// The tab bar along the top, like a browser tab: a title, no notch.
const TAB_H = 0.02;
const TAB_GAP = 0.004;
// The page tabs, a segmented control across the top of the screen, under the title. They sit
// inside the screen and not on the title plate, which is the window's drag handle: a press
// meant to change page must never start a drag.
const PAGE_TAB_H = 0.034;
const PAGE_TAB_GAP = 0.004;
// A one-tile page would otherwise draw a window a few centimetres tall, which reads as broken
// rather than as empty.
const MIN_CONTENT_H = 0.10;
// And a page taller than this is split, rather than growing a window you cannot see the top
// of. Three rows of object cells, which is twelve of them; the catalogue is heading for about
// thirty. ceiling: a split that lands inside a group leaves that chunk without the group's
// header. No page that overflows has more than one section today — the Furniture page is one
// section whose header is already suppressed for repeating its tab — so nothing is lost yet.
// The upgrade is to carry the open section's name onto the next chunk.
const MAX_CONTENT_H = 0.32;
const PAGER_H = 0.030;
const PAGE_KEY = 'fullscale.tablet.page'; // the page this session was last left on
const ROW_W = COLS * COL_W + (COLS - 1) * GAP_X;
const SCREEN_W = ROW_W + 2 * MARGIN;
const RADIUS_CELL = 0.004; // ~12 pt, grouped list corners
const RADIUS_SCREEN = 0.014;
const RADIUS_FRAME = RADIUS_SCREEN + BEZEL;
const LABEL_LINE_H = 0.0145; // one wrapped footnote line; a label row grows by this per extra line
const LABEL_PAD = 64; // canvas px, the leading text inset of a row
// Canvas px a line of each font occupies, used to stack an object cell's two lines.
const BODY_LINE = 17 * 3.4;
const FOOTNOTE_LINE = 13 * 3.4;

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
  private items: PaletteItem[] = [];
  private page: string | null = null;
  private sub = 0; // which slice of a page too long to show at once
  /**
   * Where an object cell's picture comes from. The palette pulls, rather than being handed a
   * picture per item, so only the cells on the page you are looking at ever ask for one —
   * which is what keeps the thumbnail work off every other page by construction. null while
   * the mesh is still loading, and the cell draws a placeholder.
   */
  thumbFor: ((item: PaletteItem) => CanvasImageSource | null) | null = null;

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

  /** The page now on screen, or null when the window is empty. */
  get activePage(): string | null {
    return this.page;
  }

  /** A step through a page too long to show at once, from the `scroll:` tiles under it. */
  scrollBy(delta: number) {
    this.sub += delta;
    this.render();
  }

  /** Switches tab. Called for a `page:<name>` action, which is what a tab tile carries. */
  showPage(name: string) {
    if (this.page === name) return;
    this.page = name;
    this.sub = 0; // a fresh page starts at its top
    try {
      sessionStorage.setItem(PAGE_KEY, name);
    } catch {
      // A Quest browser in private mode has no sessionStorage. The page still switches; it
      // is only the memory of it across a reload that is lost.
    }
    this.render();
  }

  setItems(items: PaletteItem[]) {
    this.items = items;
    this.render();
  }

  private render() {
    const items = this.items;
    this.group.clear();
    this.tiles = [];
    this.hovered = null;
    this.group.visible = items.length > 0;
    if (!items.length) return;

    // One tab per page, in the order the pages first appear. An item with neither a page nor
    // a section belongs to the unnamed page, which is the only page in that case and so needs
    // no tab at all.
    const pages: string[] = [];
    for (const it of items) {
      const p = pageOf(it);
      if (!pages.includes(p)) pages.push(p);
    }
    if (!this.page || !pages.includes(this.page)) this.page = remembered(pages) ?? pages[0];

    const chunks = paginate(layout(items.filter((it) => pageOf(it) === this.page), this.page));
    if (this.sub >= chunks.length) this.sub = 0;
    const slots = chunks[this.sub] ?? [];
    const contentH = slots.length ? slots.at(-1)!.y + slots.at(-1)!.h / 2 : 0;
    const stripH = pages.length > 1 ? PAGE_TAB_H + PAGE_TAB_GAP : 0;
    const pagerH = chunks.length > 1 ? PAGER_H + GAP_X : 0;
    const screenH = Math.max(contentH, MIN_CONTENT_H) + pagerH + MARGIN + TAB_H + TAB_GAP + stripH;
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

    let top = screenH / 2 - TAB_H - TAB_GAP; // y of the screen's usable top edge
    if (stripH) {
      const w = (ROW_W - (pages.length - 1) * PAGE_TAB_GAP) / pages.length;
      pages.forEach((name, i) => {
        const t = pageTab(name, name === this.page, w, PAGE_TAB_H);
        t.position.set((i - (pages.length - 1) / 2) * (w + PAGE_TAB_GAP), top - PAGE_TAB_H / 2, 0);
        this.tiles.push(t); // hit like any other tile, so a trigger sends its `page:` action
        this.group.add(t);
      });
      top -= stripH;
    }
    for (const s of slots) {
      if (s.header) {
        const h = text(s.header, ROW_W, HEADER_H, { font: 'footnote', color: C.secondary, background: null, padding: 16 });
        h.position.set(0, top - (s.y - s.h / 2 - HEADER_H / 2), 0);
        h.raycast = () => {};
        this.group.add(h);
      }
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(s.w, s.h),
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, map: draw(s, this.thumbFor?.(s.item) ?? null) }),
      );
      tile.position.set(s.x, top - s.y, 0);
      tile.userData.item = s.item;
      if (s.item.label) tile.raycast = () => {}; // text lines are never hit
      else this.tiles.push(tile);
      this.group.add(tile);
    }

    if (pagerH) {
      // Under the rows: back, where you are, forward. The step you cannot take is left out
      // rather than greyed — there is no hover on a controller ray to explain a dead tile.
      const y = top - Math.max(contentH, MIN_CONTENT_H) - GAP_X - PAGER_H / 2;
      const edge = (ROW_W - COL_W) / 2;
      if (this.sub > 0) this.group.add(this.pagerTile('‹', 'scroll:back', -edge, y));
      const count = text(`${this.sub + 1} of ${chunks.length}`, ROW_W - 2 * (COL_W + GAP_X), PAGER_H, { font: 'footnote', color: C.secondary, background: null, padding: 0, centre: true });
      count.position.set(0, y, 0);
      count.raycast = () => {};
      this.group.add(count);
      if (this.sub < chunks.length - 1) this.group.add(this.pagerTile('›', 'scroll:next', edge, y));
    }
  }

  /** One step tile of the pager, hit like any other tile so it goes through the one dispatcher. */
  private pagerTile(glyph: string, action: string, x: number, y: number): THREE.Mesh {
    const tile = pageTab(glyph, false, COL_W, PAGER_H);
    tile.position.set(x, y, 0);
    tile.userData.item = { url: '', name: glyph, action } satisfies PaletteItem;
    this.tiles.push(tile);
    return tile;
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

/**
 * Cuts a page too long to show into slices, each starting at y = 0.
 *
 * It cuts between slots, never inside a row: the cells of one widget row share a y, so the
 * first cell that would overflow opens the new slice and its neighbours land there with it.
 */
function paginate(slots: Slot[]): Slot[][] {
  const last = slots.at(-1);
  if (!last || last.y + last.h / 2 <= MAX_CONTENT_H) return [slots];
  const out: Slot[][] = [];
  let current: Slot[] = [];
  let top = 0;
  for (const s of slots) {
    if (current.length && s.y + s.h / 2 - top > MAX_CONTENT_H) {
      out.push(current);
      current = [];
      top = s.y - s.h / 2;
    }
    current.push({ ...s, y: s.y - top });
  }
  if (current.length) out.push(current);
  return out;
}

// ---------- pages ----------

/** The tab an item belongs under. A section with no page of its own is its own page. */
function pageOf(item: PaletteItem): string {
  return item.page ?? item.section ?? '';
}

/** The page this session was left on, but only while it still exists. Never a guess. */
function remembered(pages: string[]): string | null {
  let stored: string | null = null;
  try {
    stored = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(PAGE_KEY);
  } catch {
    stored = null; // private mode: fall through to the first page
  }
  return stored && pages.includes(stored) ? stored : null;
}

/** One segment of the page control: filled and white when it is the page on screen. */
function pageTab(name: string, selected: boolean, w: number, h: number): THREE.Mesh {
  const c = canvasFor(w, h);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true });
  if (c) {
    const { canvas, ctx } = c;
    ctx.fillStyle = selected ? C.accent : C.cell;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, RADIUS_CELL * PX);
    ctx.fill();
    ctx.font = selected ? FONT.headline : FONT.body;
    ctx.fillStyle = selected ? C.label : C.secondary;
    ctx.textBaseline = 'middle';
    const label = fitText(ctx, name, canvas.width - 32);
    ctx.fillText(label, (canvas.width - ctx.measureText(label).width) / 2, canvas.height / 2 + 4);
    material.map = texture(canvas);
  }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  mesh.userData.item = { url: '', name, action: `page:${name}` } satisfies PaletteItem;
  return mesh;
}

// ---------- layout ----------

/** Rows for actions and text, a two-column widget grid for objects, grouped by section. */
function layout(items: PaletteItem[], pageName?: string | null): Slot[] {
  const slots: Slot[] = [];
  let y = 0;
  let i = 0;
  let lastSection: string | undefined;
  const isObject = (it: PaletteItem) => !it.action && !it.label;
  // A section that gave the page its name is already written on the selected tab; drawing it
  // again a centimetre below costs a line of screen and says nothing.
  const titled = (section: string) => Boolean(section) && section !== pageName;
  while (i < items.length) {
    const item = items[i];
    const section = item.section ?? '';
    const newGroup = slots.length === 0 || section !== lastSection;
    if (newGroup) {
      y += slots.length ? GROUP_GAP : 0;
      if (titled(section)) y += HEADER_H;
    }
    lastSection = section;
    const header = newGroup && titled(section) ? section : undefined;
    const groupEnd = (k: number) => k >= items.length || (items[k].section ?? '') !== section;
    if (isObject(item)) {
      // A row of up to COLS widget cells, left to right.
      const row: PaletteItem[] = [];
      for (let k = i; k < i + COLS && !groupEnd(k) && isObject(items[k]); k++) row.push(items[k]);
      row.forEach((p, col) => {
        slots.push({
          item: p, x: (col - (COLS - 1) / 2) * (COL_W + GAP_X), y: y + CELL_H / 2, w: COL_W, h: CELL_H,
          corners: [true, true, true, true], separator: false, header: col === 0 ? header : undefined,
        });
      });
      y += CELL_H + GAP_X;
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
function text(str: string, w: number, h: number, o: { font: Font; color: string; background: string | null; padding: number; centre?: boolean }): THREE.Mesh {
  const c = canvasFor(w, h);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true });
  if (c) {
    const { canvas, ctx } = c;
    if (o.background) { ctx.fillStyle = o.background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.font = FONT[o.font];
    ctx.fillStyle = o.color;
    ctx.textBaseline = 'middle';
    const line = fitText(ctx, str, canvas.width - 2 * o.padding);
    ctx.fillText(line, o.centre ? (canvas.width - ctx.measureText(line).width) / 2 : o.padding, canvas.height / 2 + 4);
    material.map = texture(canvas);
  }
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
}

/** One row or widget cell, iOS-style. */
function draw(s: Slot, thumb: CanvasImageSource | null): THREE.Texture | null {
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
    // Object cell: the thing itself on top, then its name and its size in metres. The
    // picture is what tells two captures apart, so it gets the room.
    const inset = pad * 0.5;
    const band = CELL_THUMB * PX;
    // A lighter plate under the picture. The render is transparent, and a dark scan on the
    // cell's own near-black would disappear.
    ctx.fillStyle = C.frame;
    ctx.beginPath();
    ctx.roundRect(inset, inset, W - 2 * inset, band, RADIUS_CELL * PX);
    ctx.fill();
    if (thumb) {
      // "Contain", never "cover": a mesh framed to its own bounding box must not be cropped,
      // or a tall lamp and a wide table start to look alike.
      const sw = Number((thumb as { width: number }).width) || band;
      const sh = Number((thumb as { height: number }).height) || band;
      const k = Math.min((W - 2 * inset) / sw, band / sh);
      ctx.drawImage(thumb, (W - sw * k) / 2, inset + (band - sh * k) / 2, sw * k, sh * k);
    }
    // No else: with no mesh yet, or none at all, the bare plate is the placeholder. A tile
    // never borrows another object's picture to look finished.
    // Two baselines measured from the line heights, not from fractions of the cell: the name
    // is a body line and the size a footnote, and at these sizes a fraction puts one on top
    // of the other.
    const nameY = inset + band + 0.5 * BODY_LINE + 6;
    const sizeY = nameY + 0.5 * BODY_LINE + 0.5 * FOOTNOTE_LINE;
    ctx.font = FONT.body;
    ctx.fillStyle = C.label;
    ctx.fillText(fitText(ctx, it.name, W - 2 * inset - 30), inset, nameY);
    if (it.size) {
      ctx.font = FONT.footnote;
      ctx.fillStyle = C.secondary;
      ctx.fillText(`${it.size.x.toFixed(2)} × ${it.size.y.toFixed(2)} × ${it.size.z.toFixed(2)} m`, inset, sizeY);
    }
    ctx.font = FONT.headline;
    ctx.fillStyle = C.tertiary;
    ctx.fillText('›', W - pad * 0.75, nameY);
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
