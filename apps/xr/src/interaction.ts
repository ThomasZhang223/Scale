import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import type { Physics } from './physics';

/*
 * Moving scanned objects, in the headset and on the laptop.
 *
 * Quest: point at an object (the ray turns blue), hold the trigger, and it follows your
 * ray across the floor. Thumbstick left/right turns it. Let go and it stays.
 * Laptop: drag an object with the mouse; scroll while dragging to turn it.
 *
 * Neither moves objects directly. Both hand physics a target, so walls and other
 * furniture stop an object instead of it passing through.
 */

const IDLE_RAY = 0xffffff;
const HOVER_RAY = 0x5fb3ff;
const TURN_SPEED = 2.2;          // rad/s at full thumbstick
const WHEEL_STEP = Math.PI / 12; // 15° per scroll notch

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
}

export class Interaction {
  private hands: Hand[] = [];
  private raycaster = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hit = new THREE.Vector3();
  private mouse = new THREE.Vector2();
  private mouseGrab?: Grab;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private camera: THREE.Camera,
    private controls: OrbitControls,
    private physics: Physics,
  ) {
    this.setUpControllers(renderer, scene);
    this.setUpMouse(renderer.domElement);
  }

  update(dt: number) {
    for (const hand of this.hands) {
      this.raycaster.setFromXRController(hand.controller);
      if (hand.grab) {
        const stick = hand.source?.gamepad?.axes[2] ?? 0;
        if (Math.abs(stick) > 0.2) hand.grab.rotY -= stick * TURN_SPEED * dt;
        this.follow(hand.grab);
        continue;
      }
      const hovering = this.raycaster.intersectObjects(this.physics.pickables(), true).length > 0;
      (hand.ray.material as THREE.LineBasicMaterial).color.setHex(hovering ? HOVER_RAY : IDLE_RAY);
    }
    if (this.mouseGrab) {
      this.raycaster.setFromCamera(this.mouse, this.camera);
      this.follow(this.mouseGrab);
    }
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

      const hand: Hand = { controller, ray };
      controller.addEventListener('connected', (e) => (hand.source = e.data));
      controller.addEventListener('disconnected', () => (hand.source = undefined));
      controller.addEventListener('selectstart', () => {
        this.raycaster.setFromXRController(controller);
        hand.grab = this.tryGrab();
        if (hand.grab) hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 40);
      });
      controller.addEventListener('selectend', () => {
        if (hand.grab) this.physics.release(hand.grab.id);
        hand.grab = undefined;
      });
      this.hands.push(hand);
    }
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
      const over = this.raycaster.intersectObjects(this.physics.pickables(), true).length > 0;
      canvas.style.cursor = over ? 'grab' : '';
    });

    const end = () => {
      if (!this.mouseGrab) return;
      this.physics.release(this.mouseGrab.id);
      this.mouseGrab = undefined;
      this.controls.enabled = true;
      canvas.style.cursor = '';
    };
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
