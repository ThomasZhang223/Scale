import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import type { Physics } from './physics';
import type { Palette, PaletteItem } from './palette';
import { Halo, LandingPad } from './halo';
import { BUTTON_A, BUTTON_B, LIFT_HEIGHT, STICK_X, STICK_Y, stickUse } from './controls';

/*
 * Moving scanned objects, in the headset and on the laptop.
 *
 * Quest: point at an object (the ray turns blue), hold the trigger, and it follows your
 * ray across the floor. Thumbstick left/right turns it smoothly; A/X and B/Y on either
 * controller turn it a quarter turn at a time. Let go and it stays.
 *
 * Moving yourself: left thumbstick glides where you look; right thumbstick flick snap-turns
 * 45°. Walking physically still works on top of it.
 * Laptop: drag an object with the mouse; scroll while dragging to turn it.
 *
 * Neither moves objects directly. Both hand physics a target, so walls and other
 * furniture stop an object instead of it passing through.
 */

const IDLE_RAY = 0xffffff;
const HOVER_RAY = 0x5fb3ff;
const TURN_SPEED = 2.2;          // rad/s at full thumbstick
const MOVE_SPEED = 1.6;          // m/s at full left thumbstick — a brisk indoor walk
const SNAP_TURN = Math.PI / 4;   // right thumbstick flick: 45° per snap
const STICK_DEAD = 0.15;
const WHEEL_STEP = Math.PI / 12; // 15° per scroll notch
const PALETTE_RAY = 0x4cd28a;

interface Grab {
  id: string;
  offset: THREE.Vector3; // keeps the grabbed point under the ray instead of snapping to center
  rotY: number;
  lift: number;          // metres above the floor while carried; 0 = sliding on the ground
  lifted?: boolean;      // picked up with B, so a trigger press elsewhere must not let go of it
}

/** The other hand raising a carried object: its trigger held, the object follows its height. */
interface Lift {
  grab: Grab;
  hand: Hand;
  y0: number;    // the lifting hand's height when its trigger was pressed
  lift0: number; // the object's lift at that moment
}

/**
 * A floating window a controller can take hold of and move: the tablet, and the search popout.
 * Structural, so neither module has to import anything from here to qualify.
 */
export interface DraggableWindow {
  readonly group: THREE.Group;
  hitGrab(raycaster: THREE.Raycaster): THREE.Intersection | null;
}

/** A hand dragging a window: which one, at what distance along the ray, offset as grabbed. */
interface WindowDrag {
  group: THREE.Object3D;
  distance: number;
  offset: THREE.Vector3;
}

interface Hand {
  controller: THREE.XRTargetRaySpace;
  ray: THREE.Line;
  source?: XRInputSource;
  grab?: Grab;
  pulling?: boolean; // trigger still held while a palette pull is loading
  windowDrag?: WindowDrag;
  holding?: string; // a "hold:" palette action pressed and not yet released (push-to-talk)
  pressed: boolean[]; // face buttons last frame, to act once per press
}

export class Interaction {
  /**
   * The player rig: camera and both controllers live inside it, so moving or turning it
   * moves the whole person. Locomotion never touches the reference space; three keeps
   * the head pose relative to this group.
   */
  readonly rig = new THREE.Group();
  private hands: Hand[] = [];
  private snapLatched = false;
  private lift: Lift | null = null;
  private windowPlaced = false;
  private xrFrames = 0;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly eye = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private raycaster = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hit = new THREE.Vector3();
  private mouse = new THREE.Vector2();
  private mouseGrab?: Grab;
  private mouseHover: string | null = null;
  private halo = new Halo();
  /** Every window a controller can take hold of, in the order they were added. */
  private windows: DraggableWindow[] = [];
  private landing = new LandingPad();

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private camera: THREE.Camera,
    private controls: OrbitControls,
    private physics: Physics,
    private palette: Palette,
    /** Puts a fresh copy of a catalogue item into the room; resolves to its id, or null. */
    private spawn: (item: PaletteItem, at: { x: number; z: number }) => Promise<string | null>,
    /** A palette action tile (Reset, Clear) was pressed. */
    private onAction: (action: string) => void,
    /** An object was let go: the layout changed. */
    private onRelease: (id: string) => void,
    /** An object was grabbed (the designer agent treats it as pinned). */
    private onGrab: (id: string) => void = () => {},
    /** A: remove exactly this object. Never a guess about which one — it does not come back. */
    private onDelete: (id: string) => void = () => {},
    /** An action for a ray on one of the head-locked panels ('hud:close', 'find:close', 'find:pick:<objectId>'), or null. */
    private panelHit: (raycaster: THREE.Raycaster) => string | null = () => null,
  ) {
    this.renderer = renderer;
    scene.add(this.rig);
    scene.add(this.landing.mesh);
    this.rig.add(camera);
    // The window lives in the room, not on a hand; it is placed in front of you on entry.
    this.palette.attachTo(scene);
    this.windows.push(palette);
    this.setUpControllers(renderer);
    this.setUpMouse(renderer.domElement);
  }

  /**
   * Another window the same grab can move. The tablet is added by the constructor; the search
   * popout adds itself, so both are dragged by one implementation and one gesture.
   */
  addWindow(window: DraggableWindow) {
    if (!this.windows.includes(window)) this.windows.push(window);
  }

  /** The nearest window handle under the ray, so a window in front of another takes the grab. */
  private hitWindow(): { window: DraggableWindow; hit: THREE.Intersection } | null {
    let best: { window: DraggableWindow; hit: THREE.Intersection } | null = null;
    for (const window of this.windows) {
      const hit = window.hitGrab(this.raycaster);
      if (hit && (!best || hit.distance < best.hit.distance)) best = { window, hit };
    }
    return best;
  }

  /** Eye position and floor-plane forward, from the (XR) camera. */
  private headPose() {
    this.camera.getWorldPosition(this.eye);
    this.camera.getWorldQuaternion(this.q);
    this.fwd.set(0, 0, -1).applyQuaternion(this.q);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
    this.fwd.normalize();
  }

  update(dt: number) {
    // First frames in VR: put the window in front of you once tracking has settled.
    if (this.renderer.xr.isPresenting) {
      if (!this.windowPlaced && ++this.xrFrames > 20) {
        this.headPose();
        this.palette.placeInFront(this.eye, this.fwd);
        this.windowPlaced = true;
      }
    } else {
      this.windowPlaced = false;
      this.xrFrames = 0;
    }
    if (this.lift) {
      // The object follows the lifting hand's height, amplified so a small raise goes far.
      const y = this.lift.hand.controller.getWorldPosition(this.hit).y;
      this.lift.grab.lift = Math.max(0, this.lift.lift0 + (y - this.lift.y0) * 2.5);
    }
    let overPalette: PaletteItem | null = null;
    let hoverId: string | null = null;
    for (const hand of this.hands) {
      this.raycaster.setFromXRController(hand.controller);
      this.objectButtons(hand); // after the ray: A and B both act on what it is pointing at
      // The `hand.windowDrag &&` is what narrows the type for the body; stickUse is the rule.
      if (hand.windowDrag && stickUse({ draggingWindow: true, handedness: hand.source?.handedness, holding: !!hand.grab, pointingAt: null }) === 'window') {
        const pad = hand.source?.gamepad;
        const push = pad?.axes[STICK_Y] ?? 0; // stick forward = further away, back = closer
        if (Math.abs(push) > STICK_DEAD) hand.windowDrag.distance = Math.min(3.5, Math.max(0.45, hand.windowDrag.distance - push * 1.2 * dt));
        const dragged = hand.windowDrag.group;
        dragged.position.copy(this.raycaster.ray.origin).addScaledVector(this.raycaster.ray.direction, hand.windowDrag.distance).add(hand.windowDrag.offset);
        this.headPose();
        dragged.lookAt(this.eye);
        continue;
      }
      if (this.lift?.hand === hand) continue; // its trigger is busy lifting
      if (hand.grab) {
        // stickUse says 'object' for a held one; the turn is applied through the grab's own yaw.
        const stick = hand.source?.gamepad?.axes[STICK_X] ?? 0;
        if (Math.abs(stick) > 0.2) hand.grab.rotY -= stick * TURN_SPEED * dt;
        this.follow(hand.grab);
        continue;
      }
      const item = this.palette.hitTest(this.raycaster);
      if (item) overPalette = item;
      const onClose = !item && this.panelHit(this.raycaster) !== null;
      const over = item || onClose ? null : this.hitId();
      if (over) hoverId = over;
      /*
       * Where the right stick goes, in three cases that never overlap:
       *   1. a window is being dragged — handled above, that branch already `continue`d;
       *   2. an object is held or pointed at — it turns, here;
       *   3. neither — locomotion, which is the left stick's glide and the right's snap turn.
       * So pointing at an object costs you the snap turn while you point at it. That is the
       * trade the mapping asks for: the stick belongs to whatever you are aiming at.
       */
      const use = stickUse({ draggingWindow: false, handedness: hand.source?.handedness, holding: false, pointingAt: over });
      if (use === 'object') this.turnStick(hand, over!, dt);
      else this.locomotion(hand, dt);
      (hand.ray.material as THREE.LineBasicMaterial).color.setHex(item || onClose ? PALETTE_RAY : over ? HOVER_RAY : IDLE_RAY);
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
    // And the surface it would land on: the floor, or the top of whatever is under it. While
    // an object is in the air nothing else says whether it will land ON the table or beside it.
    const carried = held ? this.physics.nodeOf(held) : null;
    const under = held ? this.physics.footprintOf(held) : null;
    if (carried && under) this.landing.show(carried.position.x, this.physics.supportUnder(held!)?.top ?? 0, carried.position.z, under);
    else this.landing.hide();
  }

  /**
   * Lets go of `id` without a physical release: the object is about to be removed, so no
   * drop, no onRelease, no layout push for it.
   */
  drop(id: string) {
    for (const hand of this.hands) if (hand.grab?.id === id) hand.grab = undefined;
    if (this.mouseGrab?.id === id) {
      this.mouseGrab = undefined;
      this.controls.enabled = true;
    }
    if (this.mouseHover === id) this.mouseHover = null;
    this.halo.hide();
  }

  /** Everything currently in someone's hand. */
  heldIds(): string[] {
    const ids = this.hands.flatMap((h) => (h.grab ? [h.grab.id] : []));
    if (this.mouseGrab) ids.push(this.mouseGrab.id);
    return ids;
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
    return { id, offset, rotY: this.physics.rotationY(id), lift: 0 };
  }

  private follow(grab: Grab) {
    if (!this.raycaster.ray.intersectPlane(this.floor, this.hit)) return;
    this.physics.drag(grab.id, this.hit.x + grab.offset.x, this.hit.z + grab.offset.z, grab.rotY, grab.lift > 0 ? grab.lift : undefined);
  }

  private isHeld(id: string) {
    return this.mouseGrab?.id === id || this.hands.some((h) => h.grab?.id === id);
  }

  // ---------- locomotion ----------

  /**
   * Left thumbstick glides you across the floor in the direction you are looking (head yaw
   * only — pushing forward never sinks you into the floor). Right thumbstick flicked left or
   * right snap-turns 45° about your own head, so the room pivots around you rather than you
   * swinging around the room. Only a hand that is not holding an object steers: a held
   * object's own thumbstick turn keeps priority, see update().
   */
  /** Turns an object that is pointed at but not held. What rests on it turns with it. */
  private turnStick(hand: Hand, id: string, dt: number) {
    const stick = hand.source?.gamepad?.axes[STICK_X] ?? 0;
    if (Math.abs(stick) < STICK_DEAD) return;
    this.physics.turn(id, this.physics.rotationY(id) - stick * TURN_SPEED * dt);
    this.onRelease(id); // the layout changed, debounced by the caller
  }

  private locomotion(hand: Hand, dt: number) {
    const pad = hand.source?.gamepad;
    if (!pad) return;
    const x = pad.axes[STICK_X] ?? 0;
    const y = pad.axes[STICK_Y] ?? 0;
    if (hand.source?.handedness === 'left') {
      if (Math.abs(x) < STICK_DEAD && Math.abs(y) < STICK_DEAD) return;
      const yaw = this.headYaw();
      // Stick forward is -y on the xr-standard mapping; forward in three is -Z.
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const step = MOVE_SPEED * dt;
      this.rig.position.x += (fx * -y + rx * x) * step;
      this.rig.position.z += (fz * -y + rz * x) * step;
      return;
    }
    if (hand.source?.handedness === 'right') {
      if (Math.abs(x) < 0.3) {
        this.snapLatched = false;
        return;
      }
      if (this.snapLatched || Math.abs(x) < 0.7) return;
      this.snapLatched = true;
      this.snapTurn(x > 0 ? -SNAP_TURN : SNAP_TURN);
      pad.hapticActuators?.[0]?.pulse?.(0.3, 30);
    }
  }

  private headYaw(): number {
    const q = this.camera.getWorldQuaternion(new THREE.Quaternion());
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return Math.atan2(-f.x, -f.z);
  }

  /** Rotate the rig about the head's floor position so the view pivots in place. */
  private snapTurn(angle: number) {
    const head = this.camera.getWorldPosition(new THREE.Vector3());
    this.rig.rotation.y += angle;
    this.rig.updateMatrixWorld(true);
    const after = this.camera.getWorldPosition(new THREE.Vector3());
    this.rig.position.x += head.x - after.x;
    this.rig.position.z += head.z - after.z;
  }

  // ---------- Quest controllers ----------

  private setUpControllers(renderer: THREE.WebGLRenderer) {
    const models = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: IDLE_RAY }),
      );
      ray.scale.z = 5;
      controller.add(ray);
      this.rig.add(controller);

      const grip = renderer.xr.getControllerGrip(i);
      grip.add(models.createControllerModel(grip));
      this.rig.add(grip);

      const hand: Hand = { controller, ray, pressed: [] };
      controller.addEventListener('connected', (e) => {
        hand.source = e.data;
      });
      controller.addEventListener('disconnected', () => (hand.source = undefined));
      controller.addEventListener('selectstart', () => {
        this.raycaster.setFromXRController(controller);
        const panelAction = this.panelHit(this.raycaster);
        if (panelAction) return this.onAction(panelAction);
        // A window's handle: start dragging it. Nearest first, so a window in front of another
        // takes the grab. The panels' own buttons were already answered by panelHit above.
        const windowHit = this.hitWindow();
        if (windowHit) {
          hand.windowDrag = { group: windowHit.window.group, distance: windowHit.hit.distance, offset: windowHit.window.group.position.clone().sub(windowHit.hit.point) };
          hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.3, 30);
          return;
        }
        const item = this.palette.hitTest(this.raycaster);
        if (item?.action?.startsWith('hold:')) {
          // Press-and-release actions: the caller gets ":down" now and ":up" when the trigger lets go.
          hand.holding = item.action;
          hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.6, 60);
          return this.onAction(`${item.action}:down`);
        }
        if (item?.action) return this.onAction(item.action);
        if (item) return this.pull(hand, item);
        // The other hand already carries something: this trigger lifts it. Raise the hand,
        // the object rises; let go of this trigger and it stays at that height until dropped.
        const carrying = this.hands.find((h) => h !== hand && h.grab);
        if (carrying?.grab && !this.lift) {
          this.lift = { grab: carrying.grab, hand, y0: controller.getWorldPosition(new THREE.Vector3()).y, lift0: carrying.grab.lift };
          hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.3, 30);
          return;
        }
        if (hand.grab?.lifted) return; // B is carrying it; the trigger is for tiles and windows
        hand.grab = this.tryGrab();
        if (hand.grab) {
          hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 40);
          this.onGrab(hand.grab.id);
        }
      });
      controller.addEventListener('selectend', () => {
        hand.pulling = false;
        hand.windowDrag = undefined;
        if (this.lift?.hand === hand) this.lift = null;
        if (hand.holding) {
          this.onAction(`${hand.holding}:up`);
          hand.holding = undefined;
        }
        if (hand.grab && !hand.grab.lifted) {
          this.physics.release(hand.grab.id);
          this.onRelease(hand.grab.id);
          hand.grab = undefined;
        }
      });
      this.hands.push(hand);
    }
  }

  /**
   * A deletes, B picks up. Right hand only: A and B are the right controller's buttons, and the
   * left controller's X and Y report at the same two indices — binding those as well would put
   * "delete, permanently" under a thumb otherwise used only for walking.
   */
  private objectButtons(hand: Hand) {
    const buttons = hand.source?.gamepad?.buttons;
    if (!buttons || hand.source?.handedness !== 'right') return;
    for (const index of [BUTTON_A, BUTTON_B]) {
      const down = buttons[index]?.pressed ?? false;
      const pressedNow = down && !hand.pressed[index];
      hand.pressed[index] = down;
      if (!pressedNow) continue; // the down edge only: holding A must not delete a whole room
      if (index === BUTTON_A) this.deleteTargeted(hand);
      else this.toggleLift(hand);
    }
  }

  /**
   * A: removes the object in this hand, or the one under this ray, and nothing else.
   *
   * Never "the last one added". A wrong guess about which object costs the person their work,
   * and there is no undo: the layout that comes back from Undo only moves objects that still
   * exist. hitId() only ever hits the pick boxes of placed objects, so the room itself is safe.
   */
  private deleteTargeted(hand: Hand) {
    const id = hand.grab?.id ?? this.hitId();
    if (!id) return;
    if (hand.grab?.id === id) hand.grab = undefined; // it is about to stop existing
    hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.6, 60);
    this.onDelete(id);
  }

  /**
   * B: picks up what the ray is on, or lets go of what B picked up.
   *
   * A lifted object hangs at LIFT_HEIGHT with gravity suspended and follows the ray; the landing
   * outline under it says what it would come to rest on. Press again and it falls onto that.
   * The trigger keeps its own grab, because the trigger is also how tiles and windows are pressed.
   */
  private toggleLift(hand: Hand) {
    if (hand.grab?.lifted) {
      this.physics.release(hand.grab.id);
      this.onRelease(hand.grab.id);
      hand.grab = undefined;
      return;
    }
    if (hand.grab) return; // already carrying it with the trigger
    const grab = this.tryGrab();
    if (!grab) return;
    grab.lift = LIFT_HEIGHT;
    grab.lifted = true;
    hand.grab = grab;
    this.onGrab(grab.id);
    hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 40);
  }

  /** Trigger on a palette tile: a copy appears under the ray and is carried while the trigger is held. */
  private pull(hand: Hand, item: PaletteItem) {
    const at = this.raycaster.ray.intersectPlane(this.floor, this.hit);
    const spot = at ? { x: at.x, z: at.z } : this.inFront(hand.controller);
    hand.pulling = true;
    hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 40);
    void this.spawn(item, spot).then((id) => {
      // Trigger already released while the file loaded: the object simply stays where it landed.
      if (id && hand.pulling) hand.grab = { id, offset: new THREE.Vector3(), rotY: 0, lift: 0 };
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
      this.onGrab(grab.id);
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
      this.onRelease(this.mouseGrab.id);
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
