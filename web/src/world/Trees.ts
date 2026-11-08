import * as THREE from 'three';
import { COMMON, CURVATURE } from '../shaders/common';
import { ATMO_PARAMS, ATMO_RUNTIME } from '../shaders/atmosphere';
import { SHADOWS, LIGHTING } from '../shaders/lighting';
import { U } from '../core/uniforms';

// Tree kinds from the pipeline: broadleaf, raintree, palm, forest, small, casuarina
// Three mesh archetypes: 0 = broad crown (shape varies per kind), 1 = palm, 2 = casuarina

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Geometry builder: position, normal, aPart (0 trunk / 1 foliage), aAO */
class G {
  p: number[] = []; n: number[] = []; part: number[] = []; ao: number[] = []; idx: number[] = [];
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, part: number, ao: number) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.part.push(part); this.ao.push(ao);
    return this.p.length / 3 - 1;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aAO', new THREE.Float32BufferAttribute(this.ao, 1));
    g.setIndex(this.idx);
    return g;
  }
}

function cylinder(g: G, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1: number, sides: number) {
  const base = g.p.length / 3;
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const L = Math.hypot(dx, dy, dz);
  const ax = new THREE.Vector3(dx / L, dy / L, dz / L);
  const t = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(ax, t).normalize();
  const w = new THREE.Vector3().crossVectors(ax, u);
  for (let s = 0; s <= sides; s++) {
    const a = (s / sides) * Math.PI * 2;
    const c = Math.cos(a), sn = Math.sin(a);
    const nx = u.x * c + w.x * sn, ny = u.y * c + w.y * sn, nz = u.z * c + w.z * sn;
    g.v(x0 + nx * r0, y0 + ny * r0, z0 + nz * r0, nx, ny, nz, 0, 0.5);
    g.v(x1 + nx * r1, y1 + ny * r1, z1 + nz * r1, nx, ny, nz, 0, 0.9);
  }
  for (let s = 0; s < sides; s++) {
    const a = base + s * 2;
    g.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

function icosphere(sub: number) {
  const t = (1 + Math.sqrt(5)) / 2;
  let v: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  v = v.map((p) => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; });
  for (let s = 0; s < sub; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = cache.get(k);
      if (i === undefined) {
        const p = [(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2];
        const l = Math.hypot(p[0], p[1], p[2]);
        v.push([p[0] / l, p[1] / l, p[2] / l]);
        i = v.length - 1;
        cache.set(k, i);
      }
      return i;
    };
    const nf: number[][] = [];
    for (const [a, b, c] of f) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = nf;
  }
  return { v, f };
}

function blob(g: G, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, sub: number, r: () => number, aoBias: number) {
  const ico = icosphere(sub);
  const base = g.p.length / 3;
  const jit = ico.v.map(() => 0.85 + r() * 0.3);
  ico.v.forEach((p, i) => {
    const k = jit[i];
    const x = cx + p[0] * rx * k, y = cy + p[1] * ry * k, z = cz + p[2] * rz * k;
    // normal of the ellipsoid, bent outwards from the crown centre for softer shading
    let nx = p[0] / rx, ny = p[1] / ry, nz = p[2] / rz;
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    const ao = Math.min(1, Math.max(0, 0.45 + 0.4 * p[1] + aoBias));
    g.v(x, y, z, nx, ny, nz, 1, ao);
  });
  for (const [a, b, c] of ico.f) g.idx.push(base + a, base + c, base + b);
}

/** Broad crown (unit height 1, crown radius ~0.5) */
function broadTree(lod: number) {
  const g = new G();
  const r = rng(11 + lod);
  cylinder(g, 0, -0.2, 0, 0, 0.62, 0, 0.045, 0.028, lod === 0 ? 7 : 4);
  if (lod === 0) {
    // three main limbs into the crown
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      cylinder(g, 0, 0.45, 0, Math.cos(a) * 0.22, 0.72, Math.sin(a) * 0.22, 0.022, 0.012, 4);
    }
    blob(g, 0, 0.74, 0, 0.36, 0.2, 0.36, 1, r, 0.05);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.5;
      const d = 0.28 + r() * 0.08;
      blob(g, Math.cos(a) * d, 0.66 + r() * 0.1, Math.sin(a) * d, 0.24 + r() * 0.05, 0.16 + r() * 0.04, 0.24 + r() * 0.05, 1, r, -0.05);
    }
    blob(g, 0.04, 0.88, -0.03, 0.24, 0.13, 0.24, 1, r, 0.15);
  } else {
    blob(g, 0, 0.74, 0, 0.5, 0.24, 0.5, 1, r, 0.0);
  }
  return g.build();
}

function palm(lod: number) {
  const g = new G();
  const segs = lod === 0 ? 6 : 3;
  // gently curved trunk
  let px = 0, pz = 0, py = -0.1;
  for (let i = 0; i < segs; i++) {
    const t1 = (i + 1) / segs;
    const nx = Math.sin(t1 * 1.2) * 0.06, nz = 0, ny = -0.1 + t1 * 1.02;
    cylinder(g, px, py, pz, nx, ny, nz, 0.022, 0.018, lod === 0 ? 6 : 4);
    px = nx; py = ny; pz = nz;
  }
  // fronds
  const fr = lod === 0 ? 11 : 6;
  const r = rng(7);
  for (let f = 0; f < fr; f++) {
    const a = (f / fr) * Math.PI * 2 + r() * 0.3;
    const len = 0.42 + r() * 0.12;
    const droop = 0.25 + r() * 0.2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const steps = lod === 0 ? 6 : 3;
    const base = g.p.length / 3;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const d = t * len;
      const y = py + 0.02 + Math.sin(t * Math.PI * 0.55) * 0.12 - t * t * droop;
      const w = Math.sin(Math.min(1, t * 1.4) * Math.PI) * 0.07 + 0.005;
      const cx = px + ca * d, cz = pz + sa * d;
      // flat leaf blade across the rib
      const nx = -sa, nz = ca;
      g.v(cx + nx * w, y - w * 0.3, cz + nz * w, 0, 1, 0, 1, 0.5 + t * 0.4);
      g.v(cx - nx * w, y - w * 0.3, cz - nz * w, 0, 1, 0, 1, 0.5 + t * 0.4);
    }
    for (let s = 0; s < steps; s++) {
      const a0 = base + s * 2;
      g.idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
      g.idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3); // double sided
    }
  }
  return g.build();
}

function casuarina(lod: number) {
  const g = new G();
  const r = rng(5);
  cylinder(g, 0, -0.1, 0, 0, 0.5, 0, 0.035, 0.02, lod === 0 ? 6 : 4);
  blob(g, 0, 0.55, 0, 0.3, 0.28, 0.3, 1, r, 0);
  blob(g, 0, 0.78, 0, 0.2, 0.22, 0.2, lod === 0 ? 1 : 0, r, 0.1);
  return g.build();
}

const VS = /* glsl */ `
in vec4 aInst0;   // x, yBase, z, height
in vec4 aInst1;   // crown radius, kind, seed, unused
in float aPart;
in float aAO;
out vec3 vWorld;
out vec3 vNormal;
out float vPart;
out float vAO;
flat out vec3 vTint;
flat out float vKind;
uniform float uTime;
uniform vec2 uWind;
${CURVATURE}
vec3 hsv(float h, float s, float v) { vec3 c = clamp(abs(mod(h * 6.0 + vec3(0, 4, 2), 6.0) - 3.0) - 1.0, 0.0, 1.0); return v * mix(vec3(1.0), c, s); }
void main() {
  float h = aInst0.w;
  float cr = aInst1.x;
  float kind = aInst1.y;
  float seed = aInst1.z;
  vec3 p = position;
  // crown proportions per kind: rain trees are wide umbrellas, forest giants tall
  float wScale = cr * 2.0;
  float hScale = h;
  if (kind > 0.5 && kind < 1.5) { wScale = max(cr * 2.0, h * 1.25); p.y = p.y < 0.6 ? p.y : 0.6 + (p.y - 0.6) * 0.75; }
  if (kind > 2.5 && kind < 3.5) { wScale = cr * 1.9; }
  if (kind > 3.5 && kind < 4.5) { wScale = max(cr * 2.0, h * 0.8); }
  float rot = seed * 6.2831;
  float c = cos(rot), s = sin(rot);
  vec3 q = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  vec3 local = vec3(q.x * wScale, q.y * hScale, q.z * wScale);
  // trunks stay slender regardless of crown width
  if (aPart < 0.5) { local.x = q.x * h * 0.9; local.z = q.z * h * 0.9; }
  // wind: sway grows with height, gusts travel across the city
  float sway = sin(uTime * 1.3 + aInst0.x * 0.05 + aInst0.z * 0.04 + seed * 6.0) * 0.5 + 0.5;
  float gust = sin(uTime * 0.37 + aInst0.x * 0.004) * 0.5 + 0.5;
  float bend = pow(max(position.y, 0.0), 2.0) * h * 0.012 * (0.4 + gust);
  local.xz += uWind * bend * sway;
  if (aPart > 0.5) local += normal * sin(uTime * 3.1 + seed * 40.0 + position.x * 9.0) * 0.04 * h * 0.02;
  vec3 wp = vec3(aInst0.x, aInst0.y, aInst0.z) + local;
  wp = (modelMatrix * vec4(wp, 1.0)).xyz;
  vWorld = wp;
  vec3 n = vec3(normal.x * c - normal.z * s, normal.y, normal.x * s + normal.z * c);
  vNormal = normalize(n / vec3(wScale, hScale, wScale));
  vPart = aPart;
  vAO = aAO;
  vKind = kind;
  // per-tree tint: tropical greens, palms lighter & yellower, casuarinas darker
  float hue = 0.22 + (fract(seed * 7.3) - 0.5) * 0.06;
  float sat = 0.55 + fract(seed * 3.7) * 0.2;
  float val = 0.20 + fract(seed * 13.1) * 0.12;
  if (kind > 1.5 && kind < 2.5) { hue = 0.19; sat = 0.55; val = 0.32; }
  if (kind > 4.5) { hue = 0.25; sat = 0.4; val = 0.17; }
  if (kind > 0.5 && kind < 1.5) { val *= 0.9; }
  vTint = hsv(hue, sat, val);
  gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(wp), 1.0);
}
`;

const FS = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
in float vPart;
in float vAO;
flat in vec3 vTint;
flat in float vKind;
out vec4 fragColor;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${SHADOWS}
${LIGHTING}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1)), h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
void main() {
  vec3 wp = vWorld;
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 col;
  float alpha = 1.0;
  if (vPart < 0.5) {
    vec3 bark = srgbToLinear(vec3(0.33, 0.29, 0.25)) * (0.8 + 0.3 * vnoise(wp.xz * 3.0 + wp.y * 2.0));
    float sh = sunShadow(wp, N, dist);
    col = shadeSurface(bark, N, V, 0.9, 0.03, sh, 0.6, wp);
  } else {
    // leaf clumps: perturb the normal and break up the silhouette
    float f = dist < 600.0 ? 1.0 : 0.0;
    float clump = vnoise3(wp * 0.9) * 0.6 + vnoise3(wp * 2.3) * 0.4;
    vec3 g = vec3(vnoise3(wp * 1.3 + 3.1), vnoise3(wp * 1.3 + 7.7), vnoise3(wp * 1.3 + 1.9)) - 0.5;
    N = normalize(N + g * 0.9 * f);
    float rim = 1.0 - abs(dot(N, V));
    alpha = smoothstep(0.18, 0.42, clump + (1.0 - rim) * 0.25 + (dist > 900.0 ? 0.4 : 0.0));
    if (vKind > 1.5 && vKind < 2.5) alpha = max(alpha, 0.9);
    vec3 albedo = vTint * (0.75 + 0.5 * clump);
    float ao = vAO * (0.7 + 0.3 * clump);
    float sh = sunShadow(wp, N, dist);
    vec3 L = uSunDir;
    float NoL = dot(N, L);
    vec3 sun = sunLight();
    // wrapped diffuse (light scattered through leaves) + translucency when backlit
    float wrap = saturate((NoL + 0.35) / 1.35);
    float trans = pow(saturate(dot(-V, L)), 4.0) * 0.55;
    vec3 diff = albedo / PI * sun * (wrap + trans) * sh;
    vec3 amb = albedo * ambientCube(N) / PI * ao;
    vec3 spec = sun * pow(saturate(dot(reflect(-L, N), V)), 24.0) * 0.03 * sh;
    col = diff + amb + spec + uMoonLight * albedo * 0.2;
  }
  col = applyAerial(col, wp);
  fragColor = vec4(col, alpha);
}
`;

interface TileTrees { key: string; meshes: THREE.Mesh[]; count: number; ox: number; oy: number; data: Float32Array }

export class Trees {
  group = new THREE.Group();
  material: THREE.ShaderMaterial;
  depthMaterial: THREE.ShaderMaterial;
  private geoms: THREE.BufferGeometry[][];   // [archetype][lod]
  private tiles = new Map<string, TileTrees>();
  range = 1800;
  density = 1;

  constructor() {
    this.geoms = [[broadTree(0), broadTree(1)], [palm(0), palm(1)], [casuarina(0), casuarina(1)]];
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: U,
      side: THREE.DoubleSide, alphaToCoverage: true, transparent: false,
    });
    this.depthMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VS,
      fragmentShader: COMMON + `in vec3 vWorld; in vec3 vNormal; in float vPart; in float vAO; flat in vec3 vTint; flat in float vKind; out vec4 fragColor; void main() { fragColor = vec4(1.0); }`,
      uniforms: U, side: THREE.DoubleSide, colorWrite: false,
    });
  }

  /** data: Float32 x7 per tree (x, yBase, z, h, r, kind, seed), tile-relative */
  addTile(key: string, data: Float32Array, ox: number, oy: number) {
    const n = data.length / 7;
    // sort by seed so any prefix is a uniform random subset (cheap distance thinning)
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => data[a * 7 + 6] - data[b * 7 + 6]);
    const groups: number[][] = [[], [], []];
    for (const i of order) {
      const k = data[i * 7 + 5];
      const arch = k === 2 ? 1 : k === 5 ? 2 : 0;
      groups[arch].push(i);
    }
    const meshes: THREE.Mesh[] = [];
    groups.forEach((ids, arch) => {
      if (!ids.length) return;
      const i0 = new Float32Array(ids.length * 4), i1 = new Float32Array(ids.length * 4);
      ids.forEach((i, j) => {
        i0[j * 4] = data[i * 7]; i0[j * 4 + 1] = data[i * 7 + 1]; i0[j * 4 + 2] = data[i * 7 + 2]; i0[j * 4 + 3] = data[i * 7 + 3];
        i1[j * 4] = data[i * 7 + 4]; i1[j * 4 + 1] = data[i * 7 + 5]; i1[j * 4 + 2] = data[i * 7 + 6]; i1[j * 4 + 3] = 0;
      });
      const a0 = new THREE.InstancedBufferAttribute(i0, 4);
      const a1 = new THREE.InstancedBufferAttribute(i1, 4);
      for (let lod = 0; lod < 2; lod++) {
        const base = this.geoms[arch][lod];
        const g = new THREE.InstancedBufferGeometry();
        for (const name of ['position', 'normal', 'aPart', 'aAO']) g.setAttribute(name, base.getAttribute(name));
        g.setIndex(base.getIndex());
        g.setAttribute('aInst0', a0);
        g.setAttribute('aInst1', a1);
        g.instanceCount = ids.length;
        const m = new THREE.Mesh(g, this.material);
        m.frustumCulled = false;
        m.position.set(ox, 0, -oy);
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        m.userData = { lod, total: ids.length, arch, tree: true };
        m.visible = false;
        this.group.add(m);
        meshes.push(m);
      }
    });
    this.tiles.set(key, { key, meshes, count: n, ox, oy, data });
  }

  removeTile(key: string) {
    const t = this.tiles.get(key);
    if (!t) return;
    for (const m of t.meshes) { m.removeFromParent(); (m.geometry as THREE.InstancedBufferGeometry).dispose(); }
    this.tiles.delete(key);
  }

  /** choose LOD and instance count per tile by distance from the camera */
  update(camera: THREE.Camera) {
    const cx = camera.position.x, cz = camera.position.z;
    const alt = camera.position.y;
    for (const t of this.tiles.values()) {
      const dx = Math.max(Math.abs(t.ox - cx) - 512, 0), dz = Math.max(Math.abs(-t.oy - cz) - 512, 0);
      const d = Math.hypot(dx, dz, Math.max(alt - 40, 0) * 0.8);
      for (const m of t.meshes) {
        const ud = m.userData;
        const g = m.geometry as THREE.InstancedBufferGeometry;
        if (d > this.range) { m.visible = false; continue; }
        const lod = d < 260 ? 0 : 1;
        m.visible = ud.lod === lod;
        // thin out distant crowns (the ground canopy shading takes over)
        const keep = d < 700 ? 1 : Math.max(0.2, 1 - (d - 700) / (this.range - 700) * 0.85);
        g.instanceCount = Math.max(1, Math.floor(ud.total * keep * this.density));
      }
    }
  }

  setDepthMode(on: boolean) {
    for (const t of this.tiles.values()) for (const m of t.meshes) m.material = on ? this.depthMaterial : this.material;
  }
}
