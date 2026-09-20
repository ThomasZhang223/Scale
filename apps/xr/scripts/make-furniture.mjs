// Generates simple stand-in furniture GLBs (real-world sizes, metres) into public/objects/ (not
// served by the page any more: the built-in furniture lives in the cloud library, source 'primitive'),
// one per kind the Rearrange rules know about, so the rearrangement can be watched without
// waiting for real scans. Run: node scripts/make-furniture.mjs
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter reads its own Blob through FileReader, which Node doesn't have.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((buf) => { this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`; this.onloadend?.(); }); }
};

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
const box = (w, h, d, material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y + h / 2, z);
  return m;
};

const wood = mat(0x8a6a4f), dark = mat(0x2e3238), fabric = mat(0x5a6b8c), white = mat(0xe8e4dc), green = mat(0x3f7d4e), metal = mat(0x9aa5b1, { metalness: 0.4, roughness: 0.5 });

// [name, builder] — sizes are width (x), height (y), depth (z, front to back); the front faces +Z.
const pieces = [
  ['bed', (g) => {
    g.add(box(1.6, 0.25, 2.0, wood));                    // frame
    g.add(box(1.5, 0.22, 1.9, white, 0, 0.25, 0));       // mattress
    g.add(box(1.6, 0.9, 0.08, wood, 0, 0, -0.96));       // headboard at the back
    g.add(box(0.7, 0.12, 0.45, fabric, 0, 0.47, -0.6));  // pillow
  }],
  ['desk', (g) => {
    g.add(box(1.4, 0.04, 0.7, wood, 0, 0.71, 0));
    for (const [x, z] of [[-0.66, -0.31], [0.66, -0.31], [-0.66, 0.31], [0.66, 0.31]]) g.add(box(0.05, 0.71, 0.05, metal, x, 0, z));
    g.add(box(0.5, 0.35, 0.02, dark, 0.2, 0.75, -0.2));  // monitor
  }],
  ['dining table', (g) => {
    g.add(box(1.6, 0.05, 0.9, wood, 0, 0.7, 0));
    for (const [x, z] of [[-0.72, -0.37], [0.72, -0.37], [-0.72, 0.37], [0.72, 0.37]]) g.add(box(0.07, 0.7, 0.07, wood, x, 0, z));
  }],
  ['coffee table', (g) => {
    g.add(box(1.0, 0.04, 0.6, wood, 0, 0.38, 0));
    for (const [x, z] of [[-0.45, -0.25], [0.45, -0.25], [-0.45, 0.25], [0.45, 0.25]]) g.add(box(0.05, 0.38, 0.05, metal, x, 0, z));
  }],
  ['tv', (g) => {
    g.add(box(1.4, 0.45, 0.4, wood));                    // stand
    g.add(box(1.2, 0.7, 0.05, dark, 0, 0.47, 0.05));     // screen, front toward +Z
    g.add(box(1.1, 0.6, 0.01, mat(0x1b3a5c, { emissive: 0x1b3a5c, emissiveIntensity: 0.4 }), 0, 0.52, 0.08));
  }],
  ['storage', (g) => {
    g.add(box(0.8, 1.8, 0.4, wood));
    for (const y of [0.45, 0.9, 1.35]) g.add(box(0.74, 0.02, 0.36, white, 0, y, 0.02));
    for (const [x, y, w] of [[-0.15, 0.05, 0.4], [0.2, 0.5, 0.3], [-0.05, 0.95, 0.5], [0.1, 1.4, 0.35]]) g.add(box(w, 0.28, 0.2, fabric, x, y, 0.05));
  }],
  ['lamp', (g) => {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.03, 24), metal)).position.y = 0.015;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.3, 12), metal);
    pole.position.y = 0.68;
    g.add(pole);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, 0.25, 24, 1, true), mat(0xf0e6c8, { side: THREE.DoubleSide, emissive: 0xf0e6c8, emissiveIntensity: 0.25 }));
    shade.position.y = 1.38;
    g.add(shade);
  }],
  ['plant', (g) => {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.3, 20), mat(0xb0654a));
    pot.position.y = 0.15;
    g.add(pot);
    for (const [x, y, z, r] of [[0, 0.65, 0, 0.3], [0.15, 0.5, 0.1, 0.2], [-0.15, 0.55, -0.1, 0.22], [0.05, 0.9, -0.05, 0.22]]) {
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), green);
      leaf.position.set(x, y, z);
      g.add(leaf);
    }
  }],
];

const exporter = new GLTFExporter();
for (const [name, build] of pieces) {
  const group = new THREE.Group();
  group.name = name;
  build(group);
  const glb = await exporter.parseAsync(group, { binary: true });
  const file = `public/objects/${name.replace(/\s+/g, '-')}.glb`;
  writeFileSync(file, Buffer.from(glb));
  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  console.log(`${file}: ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m, ${(glb.byteLength / 1024).toFixed(0)} KB`);
}
