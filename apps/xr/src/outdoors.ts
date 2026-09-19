import * as THREE from 'three';

/*
 * The outdoors around the room: a sky dome with drifting procedural clouds and a grass field
 * at floor level. Both are self-contained (no textures to load), so the page has a world the
 * moment it opens, in the spectator view and inside the headset alike.
 */

const SKY_RADIUS = 300;
const GRASS_SIZE = 600;

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
      vec2 uv = d.xz / (h + 0.08) * 1.6 + vec2(uTime * 0.012, uTime * 0.004);
      float n = fbm(uv);
      float cover = smoothstep(0.50, 0.72, n);          // where the clouds are
      float lit = 0.85 + 0.15 * smoothstep(0.55, 0.9, n); // brighter in their middles
      float fade = smoothstep(0.02, 0.25, h);           // thin out toward the horizon
      sky = mix(sky, vec3(lit), cover * fade * 0.95);
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

export class Outdoors {
  readonly group = new THREE.Group();
  private readonly sky: THREE.ShaderMaterial;

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
  }

  /** Drift the clouds. Seconds since load. */
  update(timeSeconds: number) {
    this.sky.uniforms.uTime.value = timeSeconds;
  }
}
