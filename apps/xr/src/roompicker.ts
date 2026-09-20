import * as THREE from 'three';

/*
 * The room picker: a third window, one tile per room, that fades in over the room you are in.
 *
 * Changing rooms used to mean typing ?room= into the Quest browser, which drops the XR session.
 * This is the in-headset way. It only ever names rooms from the committed list (rooms.ts) — the
 * rooms table is full of throwaway captures from four panels, so there is no honest "list the
 * rooms" source, and an empty list says so rather than inventing one.
 *
 * It is a DraggableWindow like the tablet and the popout: world-anchored, moved by the band
 * across its title, and opaque to a raycast over its whole body, so the delete button cannot
 * reach an object through it.
 *
 * It does not switch rooms itself. It calls switchRoom() and then goes inert until the switch
 * says it is over, because the room it is drawn in is on its way out.
 */

export interface RoomChoice {
  id: string;
  label: string;
}

/** What the picker is doing. `error` is a switch that failed, in the room you are still in. */
export type PickerState = 'idle' | 'switching' | { error: string };

export type PickerHit = { kind: 'room'; id: string } | { kind: 'close' } | null;

const PX = 2400;
const WIDTH = 0.46;
const PAD = 0.022;
const TITLE_H = 0.05;
const TILE_H = 0.088;
const TILE_GAP = 0.008;
const NOTE_H = 0.038;
const RADIUS = 0.024;
const CLOSE_R = 0.022;
const CLOSE_INSET = 0.034;
// Where it opens: nearer than the popout and dead ahead, because it is a decision to make now
// rather than a list to read beside something else.
const SPAWN_AHEAD = 1.15;
const SPAWN_DROP = 0.1;
const GRAB_H = TITLE_H + PAD * 0.6;
const GRAB_LEFT = 2 * CLOSE_INSET + CLOSE_R;
// The fade. Short enough not to be a wait, long enough to read as a window arriving.
const FADE_MS = 250;
const RISE = 0.06; // metres it comes up through while fading in

const BACKGROUND = 'rgba(28,28,30,0.94)';
const TILE_BG = 'rgba(44,44,46,0.95)';
const TILE_CURRENT = 'rgba(10,132,255,0.22)';
const TEXT = '#FFFFFF';
const SECONDARY = 'rgba(235,235,245,0.60)';
const ACCENT = '#0A84FF';
const WARN = '#FF9F0A';
const FONT = (size: number, weight = 400) => `${weight} ${size * PX}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`;

/** Tile i occupies [y, y+h) metres below the top edge. Pure, so hit tests are testable. */
export function tileRects(count: number): { y: number; h: number }[] {
  const out: { y: number; h: number }[] = [];
  for (let i = 0; i < count; i++) out.push({ y: PAD + TITLE_H + i * (TILE_H + TILE_GAP), h: TILE_H });
  return out;
}

/**
 * The line under the tiles, or null when there is nothing to say. One job each: the tiles are
 * the choice, this says why the choice cannot be made right now.
 */
export function pickerNote(state: PickerState, rooms: readonly RoomChoice[]): string | null {
  if (typeof state === 'object') return state.error;
  if (state === 'switching') return 'Switching room…';
  if (!rooms.length) return 'No rooms configured.';
  if (rooms.length === 1) return 'This is the only room configured.';
  return null;
}

export class RoomPicker {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private body: THREE.Mesh | null = null;
  private readonly close: THREE.Mesh;
  private readonly grab: THREE.Mesh;
  private tiles: THREE.Mesh[] = [];

  private rooms: readonly RoomChoice[] = [];
  private current = '';
  private state: PickerState = 'idle';
  private presenting = false;
  /** 0 hidden, 1 fully there. Everything about being on screen is driven from this. */
  private fade = 0;
  private target = 0;
  private posed = false;
  private meshHeight = 0;

  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  constructor() {
    this.group.name = 'room-picker';
    this.group.visible = false;
    this.close = closeDisc();
    this.group.add(this.close);
    this.grab = hitPlane(WIDTH - GRAB_LEFT - PAD, GRAB_H, 'picker-grab');
    this.group.add(this.grab);
  }

  attachTo(scene: THREE.Object3D) {
    scene.add(this.group);
  }

  setPresenting(on: boolean) {
    this.presenting = on;
    this.applyVisibility();
  }

  /** The rooms to offer and which one is on screen. Safe to call while it is open. */
  setRooms(rooms: readonly RoomChoice[], current: string) {
    this.rooms = rooms;
    this.current = current;
    this.redraw();
  }

  /**
   * Inert while a switch runs, and showing why when one fails. The picker is drawn in the room
   * that is leaving, so it must not take a second choice on top of the first.
   */
  setState(state: PickerState) {
    this.state = state;
    this.redraw();
  }

  get open(): boolean {
    return this.target > 0;
  }

  /** Fades in, in front of the user, and takes a fresh pose every time it is asked for. */
  show() {
    this.target = 1;
    this.posed = false; // it is a decision to make now: always in front, never where it was left
    // A failed switch leaves its reason on the panel, which is right while the panel is up and
    // wrong the next time it is opened: an error from an attempt the person has already walked
    // away from reads as a fresh failure. Found by rendering the empty state after the error
    // one and seeing the error still there.
    if (typeof this.state === 'object') this.state = 'idle';
    this.redraw();
  }

  /** Fades out. It keeps its rows, so a failed switch can bring the same list back. */
  hide() {
    this.target = 0;
  }

  /** The title band under the ray: the handle for dragging the window. */
  hitGrab(raycaster: THREE.Raycaster): THREE.Intersection | null {
    if (!this.group.visible) return null;
    const [hit] = raycaster.intersectObject(this.grab, false);
    return hit ?? null;
  }

  /** Anywhere on the window at all, so the delete button cannot reach through it. */
  hitSurface(raycaster: THREE.Raycaster): boolean {
    return this.group.visible && !!this.body && raycaster.intersectObject(this.body, false).length > 0;
  }

  /** A room tile or the ×. Nothing is pressable while a switch runs, or on the current room. */
  hitTest(raycaster: THREE.Raycaster): PickerHit {
    if (!this.group.visible) return null;
    if (raycaster.intersectObject(this.close, false).length) return { kind: 'close' };
    if (this.state === 'switching') return null;
    const [hit] = raycaster.intersectObjects(this.tiles, false);
    return hit ? { kind: 'room', id: hit.object.userData.roomId as string } : null;
  }

  /** Puts the window ahead of the eyes, facing them. Same shape as the other two windows. */
  placeInFront(eye: THREE.Vector3, forward: THREE.Vector3) {
    this.group.position.copy(eye).addScaledVector(forward, SPAWN_AHEAD);
    this.group.position.y = eye.y - SPAWN_DROP;
    this.group.lookAt(eye);
    this.posed = true;
  }

  /**
   * Once a frame. It does not follow the head: like the other two windows it is placed once and
   * then stands in the room. All this does is drive the fade and place it the first frame it is
   * asked for.
   */
  place(head: THREE.Object3D, dt = 1 / 72) {
    if (this.target > 0 && !this.posed) {
      head.getWorldPosition(this.eye);
      head.getWorldDirection(this.forward);
      this.forward.y = 0;
      if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
      this.forward.normalize();
      this.placeInFront(this.eye, this.forward);
    }
    const step = dt / (FADE_MS / 1000);
    this.fade = this.target > this.fade ? Math.min(this.target, this.fade + step) : Math.max(this.target, this.fade - step);
    this.applyVisibility();
  }

  /**
   * Opacity and a small rise, from one number. Ease-out on the way in so it settles rather than
   * arriving flat; the rise is along the window's own up, so it works at any angle.
   */
  private applyVisibility() {
    const eased = 1 - (1 - this.fade) * (1 - this.fade);
    // Deliberately not "&& this.mesh !== null": the canvas is what you SEE, not what makes the
    // window present. Tying visibility to it added nothing in a browser — redraw() always makes
    // the mesh before this runs — and made every state of this class untestable.
    this.group.visible = this.presenting && this.fade > 0.001;
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (!m || !('opacity' in m)) return;
      const full = o.userData.baseOpacity as number | undefined;
      if (full === undefined) return;
      m.opacity = full * eased;
    });
    this.group.scale.setScalar(0.96 + 0.04 * eased);
    // The rise lives in the mesh's own offset rather than the group's position, so dragging the
    // window while it fades does not fight the animation.
    if (this.mesh) this.mesh.position.y = -this.meshHeight / 2 - RISE * (1 - eased);
  }

  private height(): number {
    const rows = Math.max(this.rooms.length, 1);
    return PAD + TITLE_H + rows * (TILE_H + TILE_GAP) - TILE_GAP + (pickerNote(this.state, this.rooms) ? NOTE_H : 0) + PAD;
  }

  private redraw() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      ((this.mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture | null)?.dispose();
      (this.mesh.material as THREE.MeshBasicMaterial).dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
    for (const t of this.tiles) t.removeFromParent();
    this.tiles = [];
    if (this.body) { this.body.removeFromParent(); this.body = null; }

    const height = this.height();
    this.meshHeight = height;

    // Hit planes exist without a document, so hitTest is testable. The current room gets none:
    // it is marked and not pressable, because switching to where you already are is not a
    // choice, and a tile that looks pressable and does nothing reads as a broken window.
    const rects = tileRects(this.rooms.length);
    this.rooms.forEach((room, i) => {
      if (room.id === this.current) return;
      const plane = hitPlane(WIDTH - 2 * PAD, rects[i].h, `picker-room-${room.id}`);
      plane.position.set(0, -(rects[i].y + rects[i].h / 2), 0.001);
      plane.userData.roomId = room.id;
      this.tiles.push(plane);
      this.group.add(plane);
    });
    this.close.position.set(-WIDTH / 2 + CLOSE_INSET, -CLOSE_INSET, 0.002);
    this.grab.position.set((GRAB_LEFT - PAD) / 2, -(PAD + TITLE_H) / 2, 0.001);
    this.body = hitPlane(WIDTH, height, 'picker-body');
    this.body.position.set(0, -height / 2, -0.002);
    this.group.add(this.body);

    if (typeof document === 'undefined') { this.applyVisibility(); return; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(WIDTH * PX);
    canvas.height = Math.round(height * PX);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = BACKGROUND;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, RADIUS * PX);
    ctx.fill();
    ctx.textBaseline = 'middle';

    // Title band, which is also the drag handle.
    ctx.fillStyle = 'rgba(58,58,60,0.95)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, (PAD + TITLE_H) * PX, [RADIUS * PX, RADIUS * PX, 0, 0]);
    ctx.fill();
    ctx.fillStyle = TEXT;
    ctx.font = FONT(0.022, 600);
    ctx.fillText('Rooms', (PAD + 0.05) * PX, (PAD + TITLE_H / 2) * PX);

    this.rooms.forEach((room, i) => {
      const r = rects[i];
      const isCurrent = room.id === this.current;
      const x0 = PAD * PX, y0 = r.y * PX, w = (WIDTH - 2 * PAD) * PX, h = r.h * PX;
      ctx.fillStyle = isCurrent ? TILE_CURRENT : TILE_BG;
      ctx.beginPath();
      ctx.roundRect(x0, y0, w, h, 0.012 * PX);
      ctx.fill();
      if (isCurrent) { ctx.strokeStyle = ACCENT; ctx.lineWidth = 0.002 * PX; ctx.stroke(); }
      ctx.fillStyle = this.state === 'switching' ? SECONDARY : TEXT;
      ctx.font = FONT(0.021, 600);
      ctx.fillText(ellipsis(ctx, room.label, w - 0.16 * PX), x0 + 0.018 * PX, y0 + h * 0.42);
      ctx.font = FONT(0.015);
      ctx.fillStyle = SECONDARY;
      ctx.fillText(isCurrent ? 'You are here' : 'Go here', x0 + 0.018 * PX, y0 + h * 0.74);
    });

    const note = pickerNote(this.state, this.rooms);
    if (note) {
      ctx.font = FONT(0.016);
      ctx.fillStyle = typeof this.state === 'object' ? WARN : SECONDARY;
      ctx.fillText(ellipsis(ctx, note, (WIDTH - 2 * PAD) * PX), PAD * PX, (height - PAD - NOTE_H / 2) * PX);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, height),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 1, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 997;
    this.mesh.raycast = () => {};
    this.mesh.userData.baseOpacity = 1;
    this.mesh.position.y = -height / 2;
    this.group.add(this.mesh);
    this.applyVisibility();
  }
}

/** An invisible plane that exists only to be hit. opacity 0, because three.js skips an
 * invisible material when raycasting. */
function hitPlane(w: number, h: number, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  mesh.name = name;
  return mesh;
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(text.slice(0, cut) + '…').width > maxPx) cut--;
  return text.slice(0, cut) + '…';
}

/** The same grey × the other two windows use. */
function closeDisc(): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
  if (typeof document !== 'undefined') {
    const px = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(120,120,128,0.7)';
    ctx.beginPath(); ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 10; ctx.lineCap = 'round';
    const a = px * 0.33, b = px * 0.67;
    ctx.beginPath(); ctx.moveTo(a, a); ctx.lineTo(b, b); ctx.moveTo(b, a); ctx.lineTo(a, b); ctx.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    material.map = texture;
  }
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(CLOSE_R, 32), material);
  mesh.renderOrder = 1000;
  mesh.name = 'picker-close';
  mesh.userData.baseOpacity = 1;
  return mesh;
}
