import * as THREE from 'three';

/*
 * The item palette: a small panel on the left controller listing every object in the
 * catalogue. Point the other controller's ray at a tile and pull the trigger to pull a
 * fresh copy out into the room. The panel is deliberately not a physics pickable, so it
 * can never be grabbed itself.
 */

export interface PaletteItem {
  url: string;
  name: string;
  scale?: number;
  size?: THREE.Vector3; // known once the GLB has loaded
  action?: string; // an action tile (Reset, Clear) instead of an object to pull out
  objectId?: string; // the server's Object v1 id, when it came from there
  label?: boolean; // a text line (status, log): drawn, never hit
  severity?: 'info' | 'warn'; // labels only: amber for warnings
  accent?: boolean; // a highlighted action (Accept)
}

const ACTION_TILE = 0x2a2f36;
const LABEL_TILE = 0x14171b;
const WARN_TILE = 0x4a3410;
const ACCENT_TILE = 0x1f6b45;

function tileColor(item: PaletteItem): number {
  if (item.label) return item.severity === 'warn' ? WARN_TILE : LABEL_TILE;
  if (item.accent) return ACCENT_TILE;
  return item.action ? ACTION_TILE : TILE;
}

const TILE_W = 0.12;
const TILE_H = 0.032;
const GAP = 0.005;
const PAD = 0.007;
const TILE = 0x2d5d86;
const TILE_HOVER = 0x4c8ac0;
const PANEL = 0x14171b;

export class Palette {
  /** Attach this to the left controller's grip. Hidden until it has items. */
  readonly group = new THREE.Group();
  private tiles: THREE.Mesh[] = [];
  private hovered: THREE.Mesh | null = null;

  constructor() {
    this.group.name = 'palette';
    this.group.visible = false;
    // Sits just above the back of the hand, tilted toward the eyes when you look at your wrist.
    this.group.position.set(0, 0.07, -0.02);
    this.group.rotation.x = -Math.PI / 3;
  }

  attachTo(grip: THREE.Object3D) {
    grip.add(this.group);
  }

  setItems(items: PaletteItem[]) {
    this.group.clear();
    this.tiles = [];
    this.hovered = null;
    this.group.visible = items.length > 0;
    if (!items.length) return;

    const height = items.length * (TILE_H + GAP) - GAP + 2 * PAD;
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE_W + 2 * PAD, height),
      new THREE.MeshBasicMaterial({ color: PANEL, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    back.position.z = -0.001;
    back.raycast = () => {}; // only tiles are hit-tested
    this.group.add(back);

    items.forEach((item, i) => {
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(TILE_W, TILE_H),
        new THREE.MeshBasicMaterial({ color: tileColor(item), side: THREE.DoubleSide, map: label(item) }),
      );
      tile.position.y = height / 2 - PAD - TILE_H / 2 - i * (TILE_H + GAP);
      tile.userData.item = item;
      if (item.label) tile.raycast = () => {}; // text lines are never hit
      else this.tiles.push(tile);
      this.group.add(tile);
    });
  }

  /** The item under the ray, if any. */
  hitTest(raycaster: THREE.Raycaster): PaletteItem | null {
    if (!this.group.visible) return null;
    const [hit] = raycaster.intersectObjects(this.tiles, false);
    return hit ? (hit.object.userData.item as PaletteItem) : null;
  }

  hover(item: PaletteItem | null) {
    const tile = item ? this.tiles.find((t) => t.userData.item === item) ?? null : null;
    if (tile === this.hovered) return;
    const base = (t: THREE.Mesh) => tileColor(t.userData.item as PaletteItem);
    if (this.hovered) (this.hovered.material as THREE.MeshBasicMaterial).color.setHex(base(this.hovered));
    if (tile) (tile.material as THREE.MeshBasicMaterial).color.setHex(TILE_HOVER);
    this.hovered = tile;
  }
}

/** Name and size drawn onto a small canvas. Skipped where there's no DOM (tests). */
function label(item: PaletteItem): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 136;
  const ctx = canvas.getContext('2d')!;
  // Dark text on white: the tile's colour multiplies through the texture, so the
  // background takes the tile colour and the text stays dark.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = 'middle';
  ctx.font = item.label ? '40px system-ui, sans-serif' : 'bold 56px system-ui, sans-serif';
  ctx.fillStyle = item.label ? '#e8edf2' : '#10233a';
  if (item.label) {
    // Labels keep their own dark background; fit the text to the tile.
    ctx.fillStyle = item.severity === 'warn' ? '#4a3410' : '#14171b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = item.severity === 'warn' ? '#ffd27a' : '#e8edf2';
    ctx.fillText(fitText(ctx, item.name, canvas.width - 40), 20, 68);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
  ctx.fillText(fitText(ctx, item.name, canvas.width - 40), 24, item.size ? 46 : 68);
  if (item.size) {
    ctx.font = '38px system-ui, sans-serif';
    ctx.fillStyle = '#2a4a6e';
    ctx.fillText(`${item.size.x.toFixed(2)} × ${item.size.y.toFixed(2)} × ${item.size.z.toFixed(2)} m`, 24, 100);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Truncates with an ellipsis so a line stays readable at arm's length. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}
