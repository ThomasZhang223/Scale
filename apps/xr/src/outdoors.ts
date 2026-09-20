import * as THREE from 'three';

/*
 * The outdoors around the room: a sky dome with drifting procedural clouds and a grass field
 * at floor level. Both are self-contained (no textures to load), so the page has a world the
 * moment it opens, in the spectator view and inside the headset alike.
 */

const SKY_RADIUS = 300;
const GRASS_SIZE = 600;
const BLADES = 60000;          // instanced blades around the room
const BLADE_RADIUS = 45;       // how far out they reach
const CLEAR_X = 3.6, CLEAR_Z = 2.8; // no blades inside the room's footprint (6.4 × 4.8 m + a margin)

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Gradient sky plus value-noise fbm clouds projected onto a flat layer above the viewer.
const skyFragment = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  uniform float uTime;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -1.0, 1.0);
    vec3 zenith = vec3(0.19, 0.47, 0.95);
    vec3 horizon = vec3(0.80, 0.90, 1.00);
    vec3 sky = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
    // Below the horizon the grass covers everything; fade the dome to a soft haze anyway.
    sky = mix(vec3(0.72, 0.84, 0.94), sky, smoothstep(-0.05, 0.05, h));

    if (h > 0.01) {
      // Cloud layer at a fixed height: where the view ray meets it, sampled with the wind.
      float fade = smoothstep(0.02, 0.22, h);           // thin out toward the horizon
      // Two layers: big cumulus low and slow, a thinner wispy layer higher and faster.
      vec2 uv1 = d.xz / (h + 0.10) * 1.2 + vec2(uTime * 0.010, uTime * 0.003);
      float n1 = fbm(uv1);
      float cover1 = smoothstep(0.42, 0.62, n1);
      float lit1 = 0.80 + 0.20 * smoothstep(0.5, 0.85, n1);   // bright tops, grey undersides
      vec3 cloud1 = mix(vec3(0.78, 0.80, 0.86), vec3(1.0), lit1);
      sky = mix(sky, cloud1, cover1 * fade);
      vec2 uv2 = d.xz / (h + 0.06) * 2.8 + vec2(-uTime * 0.02, uTime * 0.008) + 40.0;
      float n2 = fbm(uv2);
      float cover2 = smoothstep(0.55, 0.75, n2);
      sky = mix(sky, vec3(0.97), cover2 * fade * 0.6);
    }

    // The sun: a soft disc plus glow, high in the sky, same direction as the scene's light.
    vec3 sunDir = normalize(vec3(3.0, 6.0, 2.0));
    float s = max(dot(d, sunDir), 0.0);
    sky += vec3(1.0, 0.95, 0.8) * (pow(s, 600.0) * 1.2 + pow(s, 12.0) * 0.12);

    gl_FragColor = vec4(sky, 1.0);
  }
`;

/** A tiling grass texture drawn on a canvas: mottled greens with a few blades' worth of streaks. */
function grassTexture(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#5a9b3c';
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
  for (let i = 0; i < 14000; i++) {
    const x = rand() * size, y = rand() * size;
    const g = 120 + rand() * 60, r = 60 + rand() * 40, b = 40 + rand() * 30;
    ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.35 + rand() * 0.4})`;
    ctx.fillRect(x, y, 2 + rand() * 3, 1 + rand() * 2);
  }
  ctx.strokeStyle = 'rgba(40, 90, 30, 0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 1500; i++) {
    const x = rand() * size, y = rand() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 4, y - 4 - rand() * 6);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GRASS_SIZE / 3, GRASS_SIZE / 3);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A field of tapered blades, instanced, swaying in the vertex shader. */
function grassBlades(): THREE.InstancedMesh {
  // Two stacked quads per blade so it can bend: 0.04 wide at the base, tapering to a point.
  const geometry = new THREE.BufferGeometry();
  const pos: number[] = [], idx: number[] = [];
  const h = 0.32;
  const rings = [[0, 0.02], [0.5 * h, 0.012], [h, 0]];
  for (const [y, w] of rings) pos.push(-w, y, 0, w, y, 0);
  idx.push(0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();

  const material = new THREE.MeshLambertMaterial({ color: 0x6db54a, side: THREE.DoubleSide });
  const uniforms = { uTime: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vHeight;')
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        vHeight = position.y / ${h.toFixed(2)};
        // Bend from the base with a wind that varies across the field.
        vec4 world = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float wind = sin(uTime * 1.6 + world.x * 0.7 + world.z * 0.5) * 0.5 + sin(uTime * 2.7 + world.z * 1.3) * 0.25;
        transformed.x += vHeight * vHeight * wind * 0.12;
        transformed.z += vHeight * vHeight * wind * 0.06;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHeight;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.55, 1.15, vHeight); // dark at the roots, bright tips');
  };
  material.userData.uniforms = uniforms;

  const mesh = new THREE.InstancedMesh(geometry, material, BLADES);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let seed = 3;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const color = new THREE.Color();
  let i = 0;
  while (i < BLADES) {
    // Denser near the room, thinning outward: radius ∝ sqrt of a biased random.
    const r = 1.5 + Math.pow(rand(), 0.7) * BLADE_RADIUS;
    const a = rand() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) < CLEAR_X && Math.abs(z) < CLEAR_Z) continue;
    p.set(x, 0, z);
    q.setFromAxisAngle(up, rand() * Math.PI);
    const s = 0.7 + rand() * 0.8;
    sc.set(s, s, s);
    mesh.setMatrixAt(i, m.compose(p, q, sc));
    mesh.setColorAt(i, color.setHSL(0.26 + rand() * 0.06, 0.55 + rand() * 0.2, 0.36 + rand() * 0.14));
    i++;
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

export class Outdoors {
  readonly group = new THREE.Group();
  private readonly sky: THREE.ShaderMaterial;
  private readonly blades: THREE.InstancedMesh;

  constructor() {
    this.sky = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: { uTime: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 24), this.sky);
    dome.renderOrder = -1;
    dome.frustumCulled = false;
    this.group.add(dome);

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(GRASS_SIZE, GRASS_SIZE),
      new THREE.MeshLambertMaterial({ map: grassTexture() }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.01; // just under the room's floor so the floor wins where they overlap
    this.group.add(grass);

    this.blades = grassBlades();
    this.group.add(this.blades);
  }

  /** Drift the clouds. Seconds since load. */
  update(timeSeconds: number) {
    this.sky.uniforms.uTime.value = timeSeconds;
    (this.blades.material as THREE.Material).userData.uniforms.uTime.value = timeSeconds;
  }
}
