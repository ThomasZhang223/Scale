import * as THREE from 'three';
import { wrap } from './hud.ts';
import type { Recommendation, StageInfo, FindStage } from './listings.ts';

/*
 * The find panel: what Browserbase is doing on each store, then the listings that came back.
 * A canvas texture on a plane, like hud.ts, but head-locked ahead and to the right so it sits
 * beside the transcript rather than behind the phone. Three states: searching (one stage row
 * per store), results (cards you can point at), generating (the picked card's progress line).
 * Only the cards and the × are hittable; everything else ignores the ray.
 */

export type PanelHit = { kind: 'card'; objectId: string } | { kind: 'close' } | null;

const PX = 2400;
const WIDTH = 0.6;
const PAD = 0.024;
const TITLE_H = 0.05;
const ROW_H = 0.036;       // a stage row
const CARD_H = 0.11;       // a listing card
const CARD_GAP = 0.008;
const THUMB = 0.09;
const RADIUS = 0.024;
const MAX_CARDS = 6;
const AHEAD = 0.9;         // metres in front of the eyes
const RIGHT = 0.28;        // metres to the right of the gaze line
const DOWN = 0.05;
const CLOSE_R = 0.022;
const CLOSE_INSET = 0.034;

const BACKGROUND = 'rgba(28,28,30,0.90)';
const CARD_BG = 'rgba(44,44,46,0.95)';
const TEXT = '#FFFFFF';
const SECONDARY = 'rgba(235,235,245,0.60)';
const ACCENT = '#0A84FF';
const STAGE_COLOR: Record<FindStage, string> = { searching: '#FF9F0A', measuring: '#FFD60A', done: '#30D158', failed: '#FF453A' };
const FONT = (size: number, weight = 400) => `${weight} ${size * PX}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`;

interface StageRow { merchant: string; stage: FindStage | 'queued'; detail: string }

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
  private query = '';
  private rows: StageRow[] = [];
  private recs: Recommendation[] = [];
  private note: string | null = null;
  private progress = new Map<string, string>();
  private thumbs = new Map<string, HTMLImageElement>();

  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor() {
    this.group.name = 'find-panel';
    this.group.visible = false;
    this.close = closeDisc();
    this.group.add(this.close);
  }

  attachTo(scene: THREE.Object3D) { scene.add(this.group); }

  setPresenting(on: boolean) {
    this.presenting = on;
    this.group.visible = on && this.mode !== 'hidden' && !this.dismissed;
  }

  dismiss() {
    this.dismissed = true;
    this.group.visible = false;
  }

  /** Once a frame: ahead of the eyes, offset right, facing them. Head-locked, so it never gets lost. */
  place(head: THREE.Object3D) {
    if (this.mode === 'hidden' || this.dismissed) { this.group.visible = false; return; }
    head.getWorldPosition(this.eye);
    head.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    this.right.crossVectors(this.forward, new THREE.Vector3(0, 1, 0)).normalize();
    this.group.position.copy(this.eye).addScaledVector(this.forward, AHEAD).addScaledVector(this.right, RIGHT);
    this.group.position.y -= DOWN;
    this.group.lookAt(this.eye);
    this.group.visible = this.presenting && this.mesh !== null;
  }

  showSearching(query: string, merchants: readonly string[]) {
    this.mode = 'searching';
    this.dismissed = false;
    this.query = query;
    this.rows = merchants.map((merchant) => ({ merchant, stage: 'queued', detail: 'waiting…' }));
    this.recs = [];
    this.progress.clear();
    this.redraw();
  }

  setStage(info: StageInfo) {
    const row = this.rows.find((r) => r.merchant === info.merchant);
    if (row) { row.stage = info.stage; row.detail = info.detail; }
    else this.rows.push({ ...info });
    if (this.mode === 'searching') this.redraw();
  }

  showResults(recs: Recommendation[], note: string | null) {
    this.mode = 'results';
    this.dismissed = false;
    this.recs = recs.slice(0, MAX_CARDS);
    this.note = note;
    this.loadThumbs();
    this.redraw();
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

  private loadThumbs() {
    if (typeof Image === 'undefined') return;
    for (const { listing } of this.recs) {
      if (!listing.imageUrl || this.thumbs.has(listing.objectId)) continue;
      const img = new Image();
      img.crossOrigin = 'anonymous'; // Shopify's CDN sends CORS headers; without this the canvas taints
      img.onload = () => this.redraw();
      img.onerror = () => { this.thumbs.delete(listing.objectId); };
      img.src = listing.imageUrl;
      this.thumbs.set(listing.objectId, img);
    }
  }

  private height(): number {
    if (this.mode === 'searching') return PAD + TITLE_H + this.rows.length * ROW_H + PAD;
    const n = Math.max(1, this.recs.length);
    return PAD + TITLE_H + n * (CARD_H + CARD_GAP) - CARD_GAP + (this.note ? ROW_H : 0) + PAD;
  }

  private redraw() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      ((this.mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture | null)?.dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
    for (const m of this.cardMeshes) { m.geometry.dispose(); m.removeFromParent(); }
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

    // Title
    ctx.fillStyle = TEXT;
    ctx.font = FONT(0.022, 600);
    const title = this.mode === 'searching' ? `Searching Shopify via Browserbase — “${this.query}”` : `${this.recs.length ? this.recs.length : 'No'} listings for “${this.query}”`;
    ctx.fillText(ellipsis(ctx, title, (WIDTH - 2 * PAD - 0.06) * PX), (PAD + 0.05) * PX, (PAD + TITLE_H / 2) * PX);

    if (this.mode === 'searching') {
      this.rows.forEach((row, i) => {
        const cy = (PAD + TITLE_H + i * ROW_H + ROW_H / 2) * PX;
        ctx.fillStyle = row.stage === 'queued' ? SECONDARY : STAGE_COLOR[row.stage];
        ctx.beginPath();
        ctx.arc((PAD + 0.012) * PX, cy, 0.008 * PX, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = TEXT;
        ctx.font = FONT(0.019, 500);
        ctx.fillText(row.merchant, (PAD + 0.032) * PX, cy);
        ctx.fillStyle = SECONDARY;
        ctx.font = FONT(0.017);
        ctx.fillText(ellipsis(ctx, row.detail, (WIDTH - PAD - 0.24 - PAD) * PX), (PAD + 0.24) * PX, cy);
      });
    } else {
      if (!this.recs.length) {
        ctx.fillStyle = SECONDARY;
        ctx.font = FONT(0.018);
        ctx.fillText('Nothing fits that. Try a wider gap or another kind.', PAD * PX, (PAD + TITLE_H + CARD_H / 2) * PX);
      }
      cardRects(this.recs.length).forEach((r, i) => {
        const { listing: l, reasons } = this.recs[i];
        const x0 = PAD * PX, y0 = r.y * PX, w = (WIDTH - 2 * PAD) * PX, h = r.h * PX;
        ctx.fillStyle = CARD_BG;
        ctx.beginPath();
        ctx.roundRect(x0, y0, w, h, 0.012 * PX);
        ctx.fill();
        if (i === 0) { ctx.strokeStyle = ACCENT; ctx.lineWidth = 0.002 * PX; ctx.stroke(); }
        // Thumbnail
        const img = this.thumbs.get(l.objectId);
        const tx = x0 + 0.01 * PX, ty = y0 + (r.h - THUMB) / 2 * PX, ts = THUMB * PX;
        ctx.fillStyle = 'rgba(120,120,128,0.35)';
        ctx.fillRect(tx, ty, ts, ts);
        if (img?.complete && img.naturalWidth) {
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
        const price = l.price ? ` · ${(l.price.cents / 100).toFixed(0)} ${l.price.currency}` : '';
        ctx.fillStyle = SECONDARY;
        ctx.font = FONT(0.016);
        ctx.fillText(ellipsis(ctx, `${l.merchant ?? 'catalogue'} · ${cm(bw)} × ${cm(bh)} × ${cm(bd)} cm${price}`, cw), cx, y0 + 0.05 * PX);
        const conf = l.measure?.confidence ?? 0.5;
        const badge = conf < 0.7 ? { text: 'size unverified', color: SECONDARY } : { text: 'fits', color: STAGE_COLOR.done };
        const status = this.progress.get(l.objectId);
        ctx.fillStyle = status ? ACCENT : badge.color;
        ctx.font = FONT(0.016, 500);
        ctx.fillText(ellipsis(ctx, status ?? `${badge.text} · ${reasons[0] ?? ''}`, cw), cx, y0 + 0.078 * PX);
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
