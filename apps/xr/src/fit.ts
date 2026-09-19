import * as THREE from 'three';

/*
 * FitReport v1 drawn on the floor: every violation's geometry as a red ribbon (amber for
 * warnings), so a blocked door swing or a too-narrow walkway is visible from inside the
 * room without re-deriving anything from the numbers.
 *
 * Geometry is in the room's capture frame (x, z on the floor); the overlay applies the same
 * offset the room got when it was recentered. The three types below are the whole list:
 * adding one is a contract change.
 */

export type FitGeometry =
  | { type: 'arc'; center: [number, number]; radiusM: number; startDeg: number; endDeg: number }
  | { type: 'polyline'; points: [number, number][] }
  | { type: 'rect'; min: [number, number]; max: [number, number] };

export interface FitViolation {
  kind: 'door_swing' | 'clearance' | 'wall_gap' | 'window_occlusion';
  severity: 'block' | 'warn';
  placementId: string;
  detailMeters: number;
  message: string;
  geometry: FitGeometry;
}

export interface FitReport {
  schemaVersion: number;
  ok: boolean;
  checkedAt: string;
  violations: FitViolation[];
}

const COLORS = { block: 0xff4d4d, warn: 0xffb347 };
const HEIGHT = 0.015; // just above the floor, never z-fighting with it
const WIDTH = 0.04;
const ARC_SEGMENTS = 32;

/**
 * Floor points (capture frame) tracing a geometry. Arc angles follow the contract: degrees
 * counter-clockwise seen from +Y, i.e. from +X toward −Z, the same sense as three.js
 * rotation.y and Placement v1 yawDeg.
 */
export function geometryPoints(g: FitGeometry): [number, number][] {
  switch (g.type) {
    case 'arc': {
      const out: [number, number][] = [];
      for (let i = 0; i <= ARC_SEGMENTS; i++) {
        const deg = g.startDeg + ((g.endDeg - g.startDeg) * i) / ARC_SEGMENTS;
        const a = (deg * Math.PI) / 180;
        out.push([g.center[0] + Math.cos(a) * g.radiusM, g.center[1] - Math.sin(a) * g.radiusM]);
      }
      return out;
    }
    case 'polyline':
      return g.points;
    case 'rect': {
      const [x0, z0] = g.min;
      const [x1, z1] = g.max;
      return [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
    }
  }
}

export class FitOverlay {
  readonly group = new THREE.Group();
  private offset = new THREE.Vector3();
  private materials = {
    block: new THREE.MeshBasicMaterial({ color: COLORS.block, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }),
    warn: new THREE.MeshBasicMaterial({ color: COLORS.warn, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }),
  };

  constructor() {
    this.group.name = 'fit-overlay';
  }

  /** The recentering offset of the room the report belongs to. */
  setRoomOffset(offset: [number, number, number]) {
    this.offset.set(offset[0], offset[1], offset[2]);
  }

  show(report: FitReport) {
    this.clear();
    for (const v of report.violations) {
      const points = geometryPoints(v.geometry).map(
        ([x, z]) => new THREE.Vector3(x + this.offset.x, this.offset.y + HEIGHT, z + this.offset.z),
      );
      const mesh = new THREE.Mesh(ribbon(points, WIDTH), this.materials[v.severity]);
      mesh.raycast = () => {}; // never grabbed
      mesh.userData.violation = v;
      this.group.add(mesh);
    }
  }

  clear() {
    for (const child of this.group.children) (child as THREE.Mesh).geometry?.dispose();
    this.group.clear();
  }
}

/** A flat strip along a floor path: visible at VR scale where a 1 px line is not. */
function ribbon(points: THREE.Vector3[], width: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const half = width / 2;
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    dir.subVectors(b, a).setY(0).normalize();
    side.set(-dir.z, 0, dir.x).multiplyScalar(half);
    const p = points[i];
    positions.push(p.x + side.x, p.y, p.z + side.z, p.x - side.x, p.y, p.z - side.z);
  }
  const index: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const l = i * 2;
    index.push(l, l + 1, l + 2, l + 1, l + 3, l + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}
