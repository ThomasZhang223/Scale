import * as THREE from 'three';
import { wrap } from './hud.ts';
import type { Recommendation, StageInfo, FindStage } from './listings.ts';

/*
 * The find panel: the popout window a search opens, in front of you and to the right, so
 * results never become rows inside the tablet. A canvas texture on a plane, with a × to close
 * it. The cards, the × and the title band are hittable; everything else ignores the ray.
 *
 * It stands in the room, it does not follow your head. A search puts it in front of you once
 * and then leaves it there, and you move it by grabbing the band across its title — the same
 * grab, on the same trigger, that moves the tablet (interaction.ts). Reading a list that
 * slides away every time you look down at the thing you are choosing for is what that fixes.
 *
 * It answers two searches, and the difference is `kind`:
 *
 *   shop    the merchants. Searching shows one small browser window per store with what
 *           Browserbase is doing there; the results are listings, with the store's own
 *           product photo, its merchant and its price.
 *   scans   the user's own phone captures, and nothing else — no catalogue GLB and no
 *           primitive. There is no searching phase, because the library is already on the
 *           server. Every row is called "Captured object", so the picture is a render of
 *           the mesh itself and is the only thing that tells two rows apart.
 */

export type PanelHit = { kind: 'card'; objectId: string } | { kind: 'close' } | null;

const PX = 2400;
const WIDTH = 0.6;
const PAD = 0.024;
const TITLE_H = 0.05;
const ROW_H = 0.036;       // a note row
// While searching, each store is a small browser window: a tab bar with its address, a
// status line, and the product photos its page yielded, as they arrive.
const WIN_TAB_H = 0.03;
const WIN_STATUS_H = 0.03;
const WIN_STRIP = 0.075;   // photo strip height
const WIN_GAP = 0.008;
const WIN_PAD = 0.01;
const CARD_H = 0.11;       // a listing card
const CARD_GAP = 0.008;
const THUMB = 0.09;
const RADIUS = 0.024;
const MAX_CARDS = 6;
const CLOSE_R = 0.022;
const CLOSE_INSET = 0.034;
// Where a search puts the panel the first time: ahead of where you are looking, a little below
// eye line, and far enough to the right to clear the tablet, which spawns dead ahead at 1.4 m
// and is 0.74 m wide. Half the tablet plus half this panel is 0.67 m, so 0.75 m leaves a gap.
const SPAWN_AHEAD = 1.35;
const SPAWN_SIDE = 0.75;
const SPAWN_DROP = 0.15;
// It stays where you left it. These two are the only reasons to move it back in front of you:
// you walked away from it, or you turned your back on it, and either way it is lost.
const RESPAWN_DIST = 3;
// The drag handle: a band across the title, stopping clear of the × so a press meant to close
// the panel never starts a drag instead.
const GRAB_H = TITLE_H + PAD * 0.6;
const GRAB_LEFT = 2 * CLOSE_INSET + CLOSE_R;
const POSE_KEY = 'fullscale.findpanel.pose'; // where this session last left it
const POSE_SAVE_MS = 1000;

const BACKGROUND = 'rgba(28,28,30,0.90)';
const CARD_BG = 'rgba(44,44,46,0.95)';
const TEXT = '#FFFFFF';
const SECONDARY = 'rgba(235,235,245,0.60)';
const ACCENT = '#0A84FF';
const STAGE_COLOR: Record<FindStage, string> = { searching: '#FF9F0A', measuring: '#FFD60A', done: '#30D158', failed: '#FF453A' };
const FONT = (size: number, weight = 400) => `${weight} ${size * PX}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`;

interface StageRow { merchant: string; stage: FindStage | 'queued'; detail: string; url?: string | null; photos?: string[] }

/** A store window's height: tab + status, plus the photo strip once its page has answered. */
function windowHeight(row: StageRow): number {
  return WIN_TAB_H + WIN_STATUS_H + (row.photos?.length ? WIN_STRIP + WIN_PAD : 0) + WIN_PAD;
}

/** Card i occupies [y, y+h) metres below the panel's top edge. Pure, so hit tests are testable. */
export function cardRects(count: number): { y: number; h: number }[] {
  const out: { y: number; h: number }[] = [];
  for (let i = 0; i < Math.min(count, MAX_CARDS); i++) out.push({ y: PAD + TITLE_H + i * (CARD_H + CARD_GAP), h: CARD_H });
  return out;
}

export class FindPanel {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private readonly close: THREE.Mesh;
  private cardMeshes: THREE.Mesh[] = [];
  private presenting = false;
  private dismissed = false;
  private mode: 'hidden' | 'searching' | 'results' = 'hidden';
  private kind: 'shop' | 'scans' = 'shop';
  private query = '';
  /**
   * A render of a row's own mesh, for a row that has no product photo — which is every scan.
   * Set once by main.ts and shared with the tablet, so a mesh is drawn once for both.
   */
  thumbFor: ((objectId: string, glbUrl: string | null) => CanvasImageSource | null) | null = null;
  private rows: StageRow[] = [];
  private recs: Recommendation[] = [];
  private note: string | null = null;
  private progress = new Map<string, string>();
  private thumbs = new Map<string, HTMLImageElement>();

  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly toPanel = new THREE.Vector3();
  /** Where the panel stands. It is put there once and then left alone; you move it by hand. */
  private posed = false;
  private checkPose = true;
  private savedAt = 0;
  /** The band across the title that a controller grabs to move the window. */
  private readonly grab: THREE.Mesh;

  constructor() {
    this.group.name = 'find-panel';
    this.group.visible = false;
    this.close = closeDisc();
    this.group.add(this.close);
    // opacity 0, not visible:false — three.js skips raycasting a mesh whose material is
    // invisible, and this one exists only to be hit. What you see is the lighter band the
    // canvas draws behind the title.
    this.grab = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH - GRAB_LEFT - PAD, GRAB_H),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.grab.name = 'find-grab';
    this.group.add(this.grab);
  }

  /**
   * The title band under the ray: the handle for dragging the window. Same shape as the
   * tablet's, so interaction.ts moves both with one implementation and one gesture.
   */
  hitGrab(raycaster: THREE.Raycaster): THREE.Intersection | null {
    if (!this.group.visible) return null;
    const [hit] = raycaster.intersectObject(this.grab, false);
    return hit ?? null;
  }

  /** Puts the panel ahead of the eyes, off to the right of the tablet, facing them. */
  placeInFront(eye: THREE.Vector3, forward: THREE.Vector3) {
    this.group.position.copy(eye).addScaledVector(forward, SPAWN_AHEAD);
    // (-fz, 0, fx) is the floor-plane forward turned a quarter turn to the right.
    this.group.position.x += -forward.z * SPAWN_SIDE;
    this.group.position.z += forward.x * SPAWN_SIDE;
    this.group.position.y = eye.y - SPAWN_DROP;
    this.group.lookAt(eye);
    this.posed = true;
  }

  attachTo(scene: THREE.Object3D) { scene.add(this.group); }

  setPresenting(on: boolean) {
    this.presenting = on;
    this.group.visible = on && this.mode !== 'hidden' && !this.dismissed;
  }

  /** Brought back on purpose: the listings are still there after the panel was closed. */
  reopen() {
    this.dismissed = false;
    this.checkPose = true;
  }

  /** Closed by hand. Closing is a decision about where it was, so the next search re-places it. */
  dismiss() {
    this.dismissed = true;
    this.posed = false;
    this.group.visible = false;
  }

  /**
   * Once a frame, and it does NOT move the panel. The panel stands in the room where it was
   * put, like a thing on a table: reading a list while it slides with your head is what this
   * replaces. All this does is note where the head is, decide a pose on the frames where one
   * is owed, and keep the visibility right.
   *
   * A pose is owed when a search has just opened the panel. Even then it is only re-placed if
   * the panel has no pose yet, or has been left behind — see strayed(). A second search while
   * it is open changes the rows and leaves the panel alone.
   */
  place(head: THREE.Object3D) {
    if (this.mode === 'hidden' || this.dismissed) { this.group.visible = false; return; }
    head.getWorldPosition(this.eye);
    head.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    if (this.checkPose) {
      this.checkPose = false;
      if (!this.posed && this.restorePose(this.eye)) {
        // Put back where this session last left it.
      } else if (!this.posed || this.strayed()) {
        this.placeInFront(this.eye, this.forward);
      }
    }
    this.savePose();
    this.group.visible = this.presenting && this.mesh !== null;
  }

  /** Too far to read, or behind you: either way you cannot see it, so a search brings it back. */
  private strayed(): boolean {
    if (this.group.position.distanceTo(this.eye) > RESPAWN_DIST) return true;
    this.toPanel.subVectors(this.group.position, this.eye);
    this.toPanel.y = 0;
    return this.toPanel.dot(this.forward) <= 0;
  }

  /**
   * Keeps the pose across a reload, which in a headset is one stray gesture away. Throttled,
   * because this writes to sessionStorage and a drag would otherwise write every frame.
   */
  private savePose() {
    if (!this.posed) return;
    const at = now();
    if (at - this.savedAt < POSE_SAVE_MS) return;
    this.savedAt = at;
    try {
      const { x, y, z } = this.group.position;
      const q = this.group.quaternion;
      sessionStorage.setItem(POSE_KEY, JSON.stringify({ p: [x, y, z], q: [q.x, q.y, q.z, q.w] }));
    } catch {
      // Private mode has no sessionStorage. The panel still works; only the memory is lost.
    }
  }

  /** True when a stored pose was used. A stored pose you cannot see is ignored, not trusted. */
  private restorePose(eye: THREE.Vector3): boolean {
    let raw: string | null = null;
    try {
      raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(POSE_KEY);
    } catch {
      return false;
    }
    if (!raw) return false;
    try {
      const { p, q } = JSON.parse(raw) as { p: number[]; q: number[] };
      if (p?.length !== 3 || q?.length !== 4 || [...p, ...q].some((n) => !Number.isFinite(n))) return false;
      this.group.position.set(p[0], p[1], p[2]);
      this.group.quaternion.set(q[0], q[1], q[2], q[3]);
      this.posed = true;
      // The room may have changed under it, so the same test a search uses applies here.
      if (this.strayed()) {
        this.placeInFront(eye, this.forward);
      }
      return true;
    } catch {
      return false; // unreadable: spawn fresh rather than guess a pose
    }
  }

  showSearching(query: string, merchants: readonly string[]) {
    this.mode = 'searching';
    this.kind = 'shop'; // only the merchants have a search worth watching happen
    this.dismissed = false;
    this.checkPose = true;
    this.query = query;
    this.rows = merchants.map((merchant) => ({ merchant, stage: 'queued', detail: 'waiting…' }));
    this.recs = [];
    this.progress.clear();
    this.redraw();
  }

  setStage(info: StageInfo) {
    const row = this.rows.find((r) => r.merchant === info.merchant);
    if (row) {
      row.stage = info.stage;
      row.detail = info.detail;
      if (info.url !== undefined) row.url = info.url;
      if (info.photos) row.photos = info.photos;
    } else this.rows.push({ ...info });
    for (const u of info.photos ?? []) this.loadThumb(u, u);
    if (this.mode === 'searching') this.redraw();
  }

  /**
   * The rows a search came back with. `kind` says which library they came from, which decides
   * the title, the picture and what the second line of a card says. `query` is what was asked
   * — a scans search has no searching phase to have set it already.
   */
  showResults(recs: Recommendation[], note: string | null, kind: 'shop' | 'scans' = 'shop', query = this.query) {
    this.mode = 'results';
    this.kind = kind;
    this.query = query;
    this.dismissed = false;
    this.checkPose = true;
    // ceiling: six cards, no paging; the upgrade is a scroll or a "+N more" row.
    this.recs = recs.slice(0, MAX_CARDS);
    this.note = note;
    this.loadThumbs();
    this.redraw();
  }

  /** Redraws what is already showing, for a picture that has only now been rendered. */
  refresh() {
    if (this.mode !== 'hidden') this.redraw();
  }

  setProgress(objectId: string, text: string) {
    this.progress.set(objectId, text);
    if (this.mode === 'results') this.redraw();
  }

  hitTest(raycaster: THREE.Raycaster): PanelHit {
    if (!this.group.visible) return null;
    if (raycaster.intersectObject(this.close, false).length) return { kind: 'close' };
    const [hit] = raycaster.intersectObjects(this.cardMeshes, false);
    return hit ? { kind: 'card', objectId: hit.object.userData.objectId as string } : null;
  }

  /**
   * Asks for every row's picture as the rows arrive, not while drawing them: a panel shows at
   * most MAX_CARDS rows and all of them are on screen, so there is nothing to defer, and the
   * request must not depend on a canvas existing. A merchant photo comes over HTTP; a row
   * with no photo — which is every scan — gets a render of its own mesh instead.
   */
  private loadThumbs() {
    for (const { listing } of this.recs) {
      if (listing.imageUrl && this.kind !== 'scans') this.loadThumb(listing.objectId, listing.imageUrl);
      else this.thumbFor?.(listing.objectId, listing.glbUrl ?? null);
    }
  }

  /**
   * One image into the cache, redrawing when it lands. Loaded with CORS so the canvas stays
   * clean for WebGL; a CDN that refuses is retried once through the dev server's image
   * relay (vite.config.ts /local/image), which makes it same-origin.
   * ceiling: the relay is dev-only; the deployed page has none, so such images stay blank.
   */
  private loadThumb(key: string, url: string) {
    if (typeof Image === 'undefined' || this.thumbs.has(key)) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let relayed = false;
    img.onload = () => this.redraw();
    img.onerror = () => {
      if (relayed) { this.thumbs.delete(key); return; }
      relayed = true;
      img.src = `/local/image?url=${encodeURIComponent(url)}`;
    };
    img.src = url;
    this.thumbs.set(key, img);
  }

  private height(): number {
    if (this.mode === 'searching') return PAD + TITLE_H + this.rows.reduce((a, r) => a + windowHeight(r) + WIN_GAP, 0) - WIN_GAP + PAD;
    const n = Math.max(1, this.recs.length);
    return PAD + TITLE_H + n * (CARD_H + CARD_GAP) - CARD_GAP + (this.note ? ROW_H : 0) + PAD;
  }

  private redraw() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      ((this.mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture | null)?.dispose();
      (this.mesh.material as THREE.MeshBasicMaterial).dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
    for (const m of this.cardMeshes) { m.geometry.dispose(); (m.material as THREE.MeshBasicMaterial).dispose(); m.removeFromParent(); }
    this.cardMeshes = [];
    if (this.mode === 'hidden') { this.group.visible = false; return; }

    const height = this.height();
    // Invisible hit planes for the cards exist even without a document, so hitTest is testable.
    if (this.mode === 'results') {
      cardRects(this.recs.length).forEach((r, i) => {
        // opacity 0, not visible:false — three.js skips raycasting a mesh whose material is invisible.
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH - 2 * PAD, r.h), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
        plane.position.set(0, -(r.y + r.h / 2), 0.001);
        plane.userData.objectId = this.recs[i].listing.objectId;
        this.cardMeshes.push(plane);
        this.group.add(plane);
      });
    }
    this.close.position.set(-WIDTH / 2 + CLOSE_INSET, -CLOSE_INSET, 0.002);
    // The drag band spans the title, starting clear of the × on its left.
    this.grab.position.set((GRAB_LEFT - PAD) / 2, -(PAD + TITLE_H) / 2, 0.001);

    if (typeof document === 'undefined') { this.group.visible = this.presenting && !this.dismissed; return; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(WIDTH * PX);
    canvas.height = Math.round(height * PX);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = BACKGROUND;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, RADIUS * PX);
    ctx.fill();
    ctx.textBaseline = 'middle';

    // The title sits on a lighter band, which is also the handle you grab to move the window —
    // the same cue the store windows' tab bars use, so it reads as something to take hold of.
    ctx.fillStyle = 'rgba(58,58,60,0.95)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, (PAD + TITLE_H) * PX, [RADIUS * PX, RADIUS * PX, 0, 0]);
    ctx.fill();

    // Title
    ctx.fillStyle = TEXT;
    ctx.font = FONT(0.022, 600);
    const count = this.recs.length ? String(this.recs.length) : 'No';
    const title =
      this.mode === 'searching'
        ? `Searching Shopify via Browserbase — “${this.query}”`
        : this.kind === 'scans'
          ? `${count} of your scans for “${this.query}”`
          : `${count} listings for “${this.query}”`;
    ctx.fillText(ellipsis(ctx, title, (WIDTH - 2 * PAD - 0.06) * PX), (PAD + 0.05) * PX, (PAD + TITLE_H / 2) * PX);

    if (this.mode === 'searching') {
      let y = PAD + TITLE_H;
      const x0 = PAD * PX, w = (WIDTH - 2 * PAD) * PX;
      for (const row of this.rows) {
        const h = windowHeight(row);
        // The window: a card with a lighter tab bar along its top.
        ctx.fillStyle = CARD_BG;
        ctx.beginPath();
        ctx.roundRect(x0, y * PX, w, h * PX, 0.01 * PX);
        ctx.fill();
        ctx.fillStyle = 'rgba(58,58,60,0.95)';
        ctx.beginPath();
        ctx.roundRect(x0, y * PX, w, WIN_TAB_H * PX, [0.01 * PX, 0.01 * PX, 0, 0]);
        ctx.fill();
        // Tab: status dot, store, address.
        const ty = (y + WIN_TAB_H / 2) * PX;
        ctx.fillStyle = row.stage === 'queued' ? SECONDARY : STAGE_COLOR[row.stage];
        ctx.beginPath();
        ctx.arc(x0 + 0.014 * PX, ty, 0.006 * PX, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = TEXT;
        ctx.font = FONT(0.016, 600);
        ctx.fillText(row.merchant, x0 + 0.028 * PX, ty);
        const nameW = ctx.measureText(row.merchant).width;
        ctx.fillStyle = SECONDARY;
        ctx.font = FONT(0.014);
        const addr = (row.url ?? '').replace(/^https?:\/\//, '');
        if (addr) ctx.fillText(ellipsis(ctx, addr, w - 0.05 * PX - nameW - 0.02 * PX), x0 + 0.028 * PX + nameW + 0.014 * PX, ty);
        // Status line.
        const sy = (y + WIN_TAB_H + WIN_STATUS_H / 2) * PX;
        ctx.fillStyle = row.stage === 'failed' ? STAGE_COLOR.failed : SECONDARY;
        ctx.font = FONT(0.016);
        ctx.fillText(ellipsis(ctx, row.detail, w - 0.028 * PX), x0 + 0.014 * PX, sy);
        // The page's product photos, left to right, as they load; a grey tile while loading.
        if (row.photos?.length) {
          const ts = WIN_STRIP * PX;
          let tx = x0 + 0.014 * PX;
          const yy = (y + WIN_TAB_H + WIN_STATUS_H) * PX;
          for (const u of row.photos) {
            if (tx + ts > x0 + w - 0.014 * PX) break;
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.beginPath();
            ctx.roundRect(tx, yy, ts, ts, 0.006 * PX);
            ctx.fill();
            const img = this.thumbs.get(u);
            if (img && img.complete && img.naturalWidth) {
              const s = Math.min(ts / img.naturalWidth, ts / img.naturalHeight);
              ctx.save();
              ctx.beginPath();
              ctx.roundRect(tx, yy, ts, ts, 0.006 * PX);
              ctx.clip();
              ctx.drawImage(img, tx + (ts - img.naturalWidth * s) / 2, yy + (ts - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
              ctx.restore();
            }
            tx += ts + 0.008 * PX;
          }
        }
        y += h + WIN_GAP;
      }
    } else {
      if (!this.recs.length) {
        ctx.fillStyle = SECONDARY;
        ctx.font = FONT(0.018);
        const empty = this.kind === 'scans' ? 'No finished scans. Capture something on the phone first.' : 'Nothing fits that. Try a wider gap or another kind.';
        ctx.fillText(empty, PAD * PX, (PAD + TITLE_H + CARD_H / 2) * PX);
      }
      cardRects(this.recs.length).forEach((r, i) => {
        const { listing: l, reasons } = this.recs[i];
        const x0 = PAD * PX, y0 = r.y * PX, w = (WIDTH - 2 * PAD) * PX, h = r.h * PX;
        ctx.fillStyle = CARD_BG;
        ctx.beginPath();
        ctx.roundRect(x0, y0, w, h, 0.012 * PX);
        ctx.fill();
        if (i === 0) { ctx.strokeStyle = ACCENT; ctx.lineWidth = 0.002 * PX; ctx.stroke(); }
        // The picture. A merchant listing has a product photo; a scan never does, so it gets a
        // render of its own mesh instead. A row with neither keeps the plain plate — it is
        // never given another row's picture to look complete.
        const tx = x0 + 0.01 * PX, ty = y0 + (r.h - THUMB) / 2 * PX, ts = THUMB * PX;
        ctx.fillStyle = 'rgba(120,120,128,0.35)';
        ctx.fillRect(tx, ty, ts, ts);
        const img = this.thumbs.get(l.objectId);
        const mesh = this.kind === 'scans' || !img ? this.thumbFor?.(l.objectId, l.glbUrl ?? null) ?? null : null;
        if (mesh) {
          // "Contain": a mesh is framed to its own bounding box, and cropping it would make a
          // tall piece and a wide one look alike.
          const mw = Number((mesh as { width: number }).width) || ts;
          const mh = Number((mesh as { height: number }).height) || ts;
          const s = Math.min(ts / mw, ts / mh);
          ctx.drawImage(mesh, tx + (ts - mw * s) / 2, ty + (ts - mh * s) / 2, mw * s, mh * s);
        } else if (img?.complete && img.naturalWidth) {
          const s = Math.max(ts / img.naturalWidth, ts / img.naturalHeight);
          ctx.save(); ctx.beginPath(); ctx.rect(tx, ty, ts, ts); ctx.clip();
          ctx.drawImage(img, tx + (ts - img.naturalWidth * s) / 2, ty + (ts - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
          ctx.restore();
        }
        // Text column
        const cx = tx + ts + 0.014 * PX;
        const cw = x0 + w - cx - 0.01 * PX;
        ctx.fillStyle = TEXT;
        ctx.font = FONT(0.019, 600);
        ctx.fillText(ellipsis(ctx, l.name, cw), cx, y0 + 0.022 * PX);
        const { w: bw, h: bh, d: bd } = l.bboxMeters;
        const cm = (m: number) => Math.round(m * 100); // UI edge: the only place metres become cm
        const size = `${cm(bw)} × ${cm(bh)} × ${cm(bd)} cm`;
        const price = l.price ? ` · ${(l.price.cents / 100).toFixed(0)} ${l.price.currency}` : '';
        ctx.fillStyle = SECONDARY;
        ctx.font = FONT(0.016);
        // A scan has no merchant and no price, so it says where it came from instead of
        // printing "catalogue" over something the user captured themselves.
        const meta = this.kind === 'scans' ? `Scanned on your phone · ${size}` : `${l.merchant ?? 'catalogue'} · ${size}${price}`;
        ctx.fillText(ellipsis(ctx, meta, cw), cx, y0 + 0.05 * PX);
        const conf = l.measure?.confidence ?? 0.5;
        const badge = conf < 0.7 ? { text: 'size unverified', color: SECONDARY } : { text: 'fits', color: STAGE_COLOR.done };
        const status = this.progress.get(l.objectId);
        // A scan is already measured and already has its mesh, so it has no third line to
        // write: "fits" is a merchant's claim about a size it declared, and the reason a scan
        // came back is already the line above it. Only real progress gets written.
        const line = status ?? (this.kind === 'scans' ? null : `${badge.text} · ${reasons[0] ?? ''}`);
        if (line) {
          ctx.fillStyle = status ? ACCENT : badge.color;
          ctx.font = FONT(0.016, 500);
          ctx.fillText(ellipsis(ctx, line, cw), cx, y0 + 0.078 * PX);
        }
      });
      if (this.note) {
        ctx.fillStyle = STAGE_COLOR.searching;
        ctx.font = FONT(0.016);
        const lines = wrap(ctx, this.note, (WIDTH - 2 * PAD) * PX);
        ctx.fillText(lines[0], PAD * PX, (height - PAD - ROW_H / 2) * PX);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, height),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 998;
    this.mesh.raycast = () => {};
    this.mesh.position.y = -height / 2;
    this.group.add(this.mesh);
    this.group.visible = this.presenting && !this.dismissed;
  }
}

/** performance.now() where there is one; Date.now() in a test runner. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(text.slice(0, cut) + '…').width > maxPx) cut--;
  return text.slice(0, cut) + '…';
}

/** Same grey × as hud.ts, drawn once. */
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
  mesh.name = 'find-close';
  return mesh;
}
