import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import type { Physics } from './physics';
import type { Palette, PaletteItem } from './palette';
import { Halo } from './halo';

/*
 * Moving scanned objects, in the headset and on the laptop.
 *
 * Quest: point at an object (the ray turns blue), hold the trigger, and it follows your
 * ray across the floor. Thumbstick left/right turns it smoothly; A/X and B/Y on either
 * controller turn it a quarter turn at a time. Let go and it stays.
 * Laptop: drag an object with the mouse; scroll while dragging to turn it.
 *
 * Neither moves objects directly. Both hand physics a target, so walls and other
 * furniture stop an object instead of it passing through.
 */

const IDLE_RAY = 0xffffff;
const HOVER_RAY = 0x5fb3ff;
const TURN_SPEED = 2.2;          // rad/s at full thumbstick
const TURN_STEP = Math.PI / 2;   // per press of A/X (clockwise) or B/Y (counter-clockwise)
const BUTTON_AX = 4;             // xr-standard gamepad mapping
const BUTTON_BY = 5;
const WHEEL_STEP = Math.PI / 12; // 15° per scroll notch
const PALETTE_RAY = 0x4cd28a;

interface Grab {
  id: string;
  offset: THREE.Vector3; // keeps the grabbed point under the ray instead of snapping to center
  rotY: number;
}

interface Hand {
  controller: THREE.XRTargetRaySpace;
  ray: THREE.Line;
  source?: XRInputSource;
  grab?: Grab;
  pulling?: boolean; // trigger still held while a palette pull is loading
  pressed: boolean[]; // face buttons last frame, to act once per press
}

export class Interaction {
  private hands: Hand[] = [];
  private raycaster = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hit = new THREE.Vector3();
  private mouse = new THREE.Vector2();
  private mouseGrab?: Grab;
  private mouseHover: string | null = null;
  private halo = new Halo();

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private camera: THREE.Camera,
    private controls: OrbitControls,
    private physics: Physics,
    private palette: Palette,
    /** Puts a fresh copy of a catalogue item into the room; resolves to its id, or null. */
    private spawn: (item: PaletteItem, at: { x: number; z: number }) => Promise<string | null>,
  ) {
    this.setUpControllers(renderer, scene);
    this.setUpMouse(renderer.domElement);
  }

  update(dt: number) {
    let overPalette: PaletteItem | null = null;
    let hoverId: string | null = null;
    for (const hand of this.hands) {
      this.turnButtons(hand);
      this.raycaster.setFromXRController(hand.controller);
      if (hand.grab) {
        const stick = hand.source?.gamepad?.axes[2] ?? 0;
        if (Math.abs(stick) > 0.2) hand.grab.rotY -= stick * TURN_SPEED * dt;
        this.follow(hand.grab);
        continue;
      }
      const item = this.palette.hitTest(this.raycaster);
      if (item) overPalette = item;
      const over = item ? null : this.hitId();
      if (over) hoverId = over;
      (hand.ray.material as THREE.LineBasicMaterial).color.setHex(item ? PALETTE_RAY : over ? HOVER_RAY : IDLE_RAY);
    }
    this.palette.hover(overPalette);
    if (this.mouseGrab) {
      this.raycaster.setFromCamera(this.mouse, this.camera);
      this.follow(this.mouseGrab);
    }
    // One halo: bright on the held object, dim on whatever a ray or the mouse is over.
    const held = this.mouseGrab?.id ?? this.hands.find((h) => h.grab)?.grab?.id ?? null;
    const node = this.physics.nodeOf(held ?? hoverId ?? this.mouseHover ?? '');
    if (node) this.halo.show(node, held ? 0.85 : 0.35);
    else this.halo.hide();
  }

  /** The object under whatever ray the raycaster currently holds. */
  private hitId(): string | null {
    const [first] = this.raycaster.intersectObjects(this.physics.pickables(), true);
    return this.physics.idFromObject(first?.object ?? null);
  }

  // ---------- shared ----------

  /** Uses whatever ray the raycaster currently holds. */
  private tryGrab(): Grab | undefined {
    const [first] = this.raycaster.intersectObjects(this.physics.pickables(), true);
    const id = this.physics.idFromObject(first?.object ?? null);
    if (!id || this.isHeld(id)) return undefined;
    const node = first.object;
    let root: THREE.Object3D = node;
    while (root.parent && this.physics.idFromObject(root.parent) === id) root = root.parent;
    const anchor = this.raycaster.ray.intersectPlane(this.floor, this.hit) ?? first.point;
    const offset = new THREE.Vector3(root.position.x - anchor.x, 0, root.position.z - anchor.z);
    return { id, offset, rotY: this.physics.rotationY(id) };
  }

  private follow(grab: Grab) {
    if (!this.raycaster.ray.intersectPlane(this.floor, this.hit)) return;
    this.physics.drag(grab.id, this.hit.x + grab.offset.x, this.hit.z + grab.offset.z, grab.rotY);
  }

  private isHeld(id: string) {
    return this.mouseGrab?.id === id || this.hands.some((h) => h.grab?.id === id);
  }

  // ---------- Quest controllers ----------

  private setUpControllers(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const models = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: IDLE_RAY }),
      );
      ray.scale.z = 5;
      controller.add(ray);
      scene.add(controller);

      const grip = renderer.xr.getControllerGrip(i);
      grip.add(models.createControllerModel(grip));
      scene.add(grip);

      const hand: Hand = { controller, ray, pressed: [] };
      controller.addEventListener('connected', (e) => {
        hand.source = e.data;
        if (e.data.handedness === 'left') this.palette.attachTo(grip);
      });
      controller.addEventListener('disconnected', () => (hand.source = undefined));
      controller.addEventListener('selectstart', () => {
        this.raycaster.setFromXRController(controller);
        const item = this.palette.hitTest(this.raycaster);
        if (item) return this.pull(hand, item);
        hand.grab = this.tryGrab();
        if (hand.grab) hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 40);
      });
      controller.addEventListener('selectend', () => {
        hand.pulling = false;
        if (hand.grab) this.physics.release(hand.grab.id);
        hand.grab = undefined;
      });
      this.hands.push(hand);
    }
  }

  /**
   * A/X and B/Y turn the held object a quarter turn per press. Either controller's buttons
   * work: they act on this hand's object, or on the other hand's if this one is empty.
   */
  private turnButtons(hand: Hand) {
    const buttons = hand.source?.gamepad?.buttons;
    if (!buttons) return;
    for (const [index, direction] of [[BUTTON_AX, -1], [BUTTON_BY, 1]] as const) {
      const down = buttons[index]?.pressed ?? false;
      if (down && !hand.pressed[index]) {
        const grab = hand.grab ?? this.hands.find((h) => h !== hand && h.grab)?.grab;
        if (grab) grab.rotY += direction * TURN_STEP;
      }
      hand.pressed[index] = down;
    }
  }

  /** Trigger on a palette tile: a copy appears under the ray and is carried while the trigger is held. */
  private pull(hand: Hand, item: PaletteItem) {
    const at = this.raycaster.ray.intersectPlane(this.floor, this.hit);
    const spot = at ? { x: at.x, z: at.z } : this.inFront(hand.controller);
    hand.pulling = true;
    hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 40);
    void this.spawn(item, spot).then((id) => {
      // Trigger already released while the file loaded: the object simply stays where it landed.
      if (id && hand.pulling) hand.grab = { id, offset: new THREE.Vector3(), rotY: 0 };
      hand.pulling = false;
    });
  }

  private inFront(controller: THREE.Object3D): { x: number; z: number } {
    const p = new THREE.Vector3(0, 0, -1).applyMatrix4(controller.matrixWorld);
    return { x: p.x, z: p.z };
  }

  // ---------- laptop mouse ----------

  private setUpMouse(canvas: HTMLCanvasElement) {
    const toMouse = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };

    // Capture phase, so a press on an object never reaches the orbit controls.
    canvas.addEventListener('pointerdown', (e) => {
      toMouse(e);
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const grab = this.tryGrab();
      if (!grab) return;
      e.stopImmediatePropagation();
      this.mouseGrab = grab;
      this.controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    }, { capture: true });

    canvas.addEventListener('pointermove', (e) => {
      toMouse(e);
      if (this.mouseGrab) return;
      this.raycaster.setFromCamera(this.mouse, this.camera);
      this.mouseHover = this.hitId();
      canvas.style.cursor = this.mouseHover ? 'grab' : '';
    });

    const end = () => {
      if (!this.mouseGrab) return;
      this.physics.release(this.mouseGrab.id);
      this.mouseGrab = undefined;
      this.controls.enabled = true;
      canvas.style.cursor = '';
    };
    canvas.addEventListener('pointerleave', () => (this.mouseHover = null));
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener('wheel', (e) => {
      if (!this.mouseGrab) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // turn the object, don't zoom
      this.mouseGrab.rotY += Math.sign(e.deltaY) * WHEEL_STEP;
    }, { capture: true, passive: false });
  }
}
