import * as THREE from 'three';
import { COMMON, CURVATURE } from '../shaders/common';
import { ATMO_PARAMS, ATMO_RUNTIME } from '../shaders/atmosphere';
import { SHADOWS, LIGHTING } from '../shaders/lighting';
import { U } from '../core/uniforms';
import { DATA_BASE } from '../data/assets';

// material codes (aMat.x): 0 painted steel/concrete, 1 glass, 2 planting (vertical garden), 3 LED strip
const VS = /* glsl */ `
in vec3 aCol;
in vec4 aMat;          // kind, roughness, emissive group, seed
out vec3 vWorld;
out vec3 vNormal;
out vec3 vCol;
out vec4 vMat;
${CURVATURE}
void main() {
#ifdef USE_INSTANCING
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
#else
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormal = normalize(mat3(modelMatrix) * normal);
#endif
  vWorld = wp.xyz;
  vCol = aCol;
  vMat = aMat;
  gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(wp.xyz), 1.0);
}
`;

const FS = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
in vec3 vCol;
in vec4 vMat;
out vec4 fragColor;
uniform float uShow;     // Supertree light show intensity
uniform float uHour;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${SHADOWS}
${LIGHTING}
vec3 ledColour(float g, float t, float seed) {
  // slowly cycling purples, magentas, blues and greens
  float h = fract(g * 0.13 + seed * 0.31 + t * 0.02);
  vec3 a = vec3(0.55, 0.20, 0.95), b = vec3(0.95, 0.25, 0.65), c = vec3(0.20, 0.45, 1.0), d = vec3(0.30, 0.95, 0.65);
  vec3 col = h < 0.25 ? mix(a, b, h * 4.0) : h < 0.5 ? mix(b, c, h * 4.0 - 1.0) : h < 0.75 ? mix(c, d, h * 4.0 - 2.0) : mix(d, a, h * 4.0 - 3.0);
  return col;
}
void main() {
  vec3 wp = vWorld;
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  int kind = int(vMat.x + 0.5);
  vec3 albedo = srgbToLinear(vCol);
  float rough = vMat.y;
  float f0 = 0.04;
  vec3 emis = vec3(0.0);
  if (kind == 2) {
    // vertical garden: clumps of foliage in greens & purples behind a steel lattice
    float n = fbm(vec2(atan(wp.z, wp.x) * 6.0, wp.y * 0.8) + vMat.w * 10.0);
    vec3 green = srgbToLinear(vec3(0.20, 0.33, 0.14)), purple = srgbToLinear(vec3(0.36, 0.20, 0.36));
    albedo = mix(green, purple, smoothstep(0.55, 0.7, n)) * (0.7 + 0.6 * vnoise(wp.xz * 3.0 + wp.y));
    rough = 0.95;
  }
  if (kind == 1) f0 = 0.06;
  float sh = sunShadow(wp, N, dist);
  vec3 col = shadeSurface(albedo, N, V, rough, f0, sh, 1.0, wp);
  if (kind == 1) {
    vec3 R = reflect(-V, N);
    vec3 env = skyRadiance(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
    float F = f0 + (1.0 - f0) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col += env * F;
    emis += blackbody(3800.0) * 0.6;   // capsule interiors
  }
  if (kind == 3) {
    float g = vMat.z;
    vec3 led = ledColour(g, uTime * (1.0 + uShow * 6.0), vMat.w);
    // light show: pulses racing up the trees
    float pulse = 0.55 + 0.45 * sin(uTime * (1.5 + uShow * 5.0) - wp.y * 0.25 + vMat.w * 6.0);
    emis += led * mix(0.8, 1.6 * pulse, uShow) * 3.0;
    albedo *= 0.3;
  }
  col += emis * uNight * uSunIntensity * 0.0065;
  col = applyAerial(col, wp);
  fragColor = vec4(col, 1.0);
}
`;

class Mesh {
  p: number[] = []; n: number[] = []; c: number[] = []; m: number[] = []; idx: number[] = [];
  v(p: THREE.Vector3, n: THREE.Vector3, col: number[], mat: number[]) {
    this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.c.push(...col); this.m.push(...mat);
    return this.p.length / 3 - 1;
  }
  /** tube between two points */
  tube(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, sides: number, col: number[], mat: number[]) {
    const ax = b.clone().sub(a);
    const L = ax.length();
    if (L < 1e-4) return;
    ax.divideScalar(L);
    const t = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ax, t).normalize();
    const w = new THREE.Vector3().crossVectors(ax, u);
    const base = this.p.length / 3;
    for (let s = 0; s <= sides; s++) {
      const ang = (s / sides) * Math.PI * 2;
      const nn = u.clone().multiplyScalar(Math.cos(ang)).addScaledVector(w, Math.sin(ang));
      this.v(a.clone().addScaledVector(nn, ra), nn, col, mat);
      this.v(b.clone().addScaledVector(nn, rb), nn, col, mat);
    }
    for (let s = 0; s < sides; s++) {
      const i = base + s * 2;
      this.idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
  }
  /** surface of revolution around +Y: profile [radius, y][] */
  lathe(cx: number, cy: number, cz: number, prof: [number, number][], sides: number, col: number[], mat: number[]) {
    const base = this.p.length / 3;
    for (let i = 0; i < prof.length; i++) {
      const [r, y] = prof[i];
      const j = Math.min(prof.length - 1, i + 1), k = Math.max(0, i - 1);
      const dr = prof[j][0] - prof[k][0], dy = prof[j][1] - prof[k][1];
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nrm = new THREE.Vector3(ca * dy, -dr, sa * dy).normalize();
        this.v(new THREE.Vector3(cx + ca * r, cy + y, cz + sa * r), nrm, col, mat);
      }
    }
    for (let i = 0; i < prof.length - 1; i++) for (let s = 0; s < sides; s++) {
      const a = base + i * (sides + 1) + s, b = a + sides + 1;
      this.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.m, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const WHITE = [0.86, 0.87, 0.86];
const STEEL = [0.55, 0.56, 0.57];
const DARK = [0.22, 0.23, 0.24];

interface LandmarkData {
  flyer?: { x: number; y: number; dir: [number, number]; radius: number; top: number };
  supertrees?: { x: number; y: number; h: number; r: number }[];
  helix?: { x: number; y: number; dir: [number, number]; length: number };
}

export class Landmarks {
  group = new THREE.Group();
  material: THREE.ShaderMaterial;
  instMaterial: THREE.ShaderMaterial;
  depth: THREE.ShaderMaterial;
  depthInst: THREE.ShaderMaterial;
  private wheel: THREE.Group | null = null;
  private capsules: THREE.InstancedMesh | null = null;
  private flyer: LandmarkData['flyer'] | null = null;
  uniforms = { uShow: { value: 0 }, uHour: { value: 12 } };

  constructor(private heightAt: (x: number, z: number) => number) {
    this.material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: { ...U, ...this.uniforms }, side: THREE.DoubleSide });
    this.instMaterial = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: { ...U, ...this.uniforms }, side: THREE.DoubleSide });
    const dvs = /* glsl */ `void main() {
#ifdef USE_INSTANCING
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
#else
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
#endif
    }`;
    this.depth = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: dvs, fragmentShader: 'out vec4 c; void main(){ c = vec4(1.0); }', colorWrite: false, side: THREE.DoubleSide });
    this.depthInst = this.depth.clone();
  }

  async load() {
    const res = await fetch(DATA_BASE + 'landmarks.json');
    if (!res.ok) return;
    const d: LandmarkData = await res.json();
    if (d.flyer) this.buildFlyer(d.flyer);
    if (d.supertrees) this.buildSupertrees(d.supertrees);
    if (d.helix) this.buildHelix(d.helix);
  }

  private buildFlyer(f: NonNullable<LandmarkData['flyer']>) {
    this.flyer = f;
    const wx = f.x, wz = -f.y;
    const g0 = this.heightAt(wx, wz);
    const R = Math.min(f.radius, 75);
    const hub = g0 + f.top - R - 2;
    // wheel plane basis: d (horizontal, in plane), up; axle a perpendicular
    const d = new THREE.Vector3(f.dir[0], 0, -f.dir[1]).normalize();
    const a = new THREE.Vector3(-d.z, 0, d.x);
    const wheel = new Mesh();
    const segs = 96;
    const ring = (r: number, off: number, rad: number) => {
      for (let i = 0; i < segs; i++) {
        const t0 = (i / segs) * Math.PI * 2, t1 = ((i + 1) / segs) * Math.PI * 2;
        const p0 = d.clone().multiplyScalar(Math.cos(t0) * r).add(new THREE.Vector3(0, Math.sin(t0) * r, 0)).addScaledVector(a, off);
        const p1 = d.clone().multiplyScalar(Math.cos(t1) * r).add(new THREE.Vector3(0, Math.sin(t1) * r, 0)).addScaledVector(a, off);
        wheel.tube(p0, p1, rad, rad, 6, WHITE, [0, 0.4, 0, 0]);
      }
    };
    ring(R, 0, 0.9);
    ring(R - 5, 1.6, 0.5);
    ring(R - 5, -1.6, 0.5);
    // LED ring
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * Math.PI * 2, t1 = ((i + 1) / segs) * Math.PI * 2;
      const p0 = d.clone().multiplyScalar(Math.cos(t0) * (R + 0.9)).add(new THREE.Vector3(0, Math.sin(t0) * (R + 0.9), 0));
      const p1 = d.clone().multiplyScalar(Math.cos(t1) * (R + 0.9)).add(new THREE.Vector3(0, Math.sin(t1) * (R + 0.9), 0));
      wheel.tube(p0, p1, 0.6, 0.6, 4, [0.9, 0.9, 1.0], [3, 0.5, 2, i / segs]);
    }
    // truss struts & spokes
    for (let i = 0; i < 28 * 3; i++) {
      const t = (i / (28 * 3)) * Math.PI * 2;
      const o = d.clone().multiplyScalar(Math.cos(t)).add(new THREE.Vector3(0, Math.sin(t), 0));
      wheel.tube(o.clone().multiplyScalar(R), o.clone().multiplyScalar(R - 5).addScaledVector(a, 1.6), 0.25, 0.25, 4, WHITE, [0, 0.4, 0, 0]);
      wheel.tube(o.clone().multiplyScalar(R), o.clone().multiplyScalar(R - 5).addScaledVector(a, -1.6), 0.25, 0.25, 4, WHITE, [0, 0.4, 0, 0]);
    }
    for (let i = 0; i < 28; i++) {
      const t = (i / 28) * Math.PI * 2;
      const o = d.clone().multiplyScalar(Math.cos(t)).add(new THREE.Vector3(0, Math.sin(t), 0));
      for (const side of [-1, 1]) wheel.tube(a.clone().multiplyScalar(side * 6), o.clone().multiplyScalar(R - 5).addScaledVector(a, side * 1.6), 0.12, 0.12, 3, STEEL, [0, 0.4, 0, 0]);
    }
    // hub
    wheel.tube(a.clone().multiplyScalar(-8), a.clone().multiplyScalar(8), 2.4, 2.4, 12, STEEL, [0, 0.35, 0, 0]);
    const wheelMesh = new THREE.Mesh(wheel.geometry(), this.material);
    const pivot = new THREE.Group();
    pivot.position.set(wx, hub, wz);
    pivot.add(wheelMesh);
    this.wheel = pivot;
    this.group.add(pivot);
    // capsules (kept level while the wheel turns)
    const cap = new Mesh();
    cap.lathe(0, 0, 0, [[0.01, -2.2], [1.4, -1.9], [2.0, -1.0], [2.1, 0.4], [1.8, 1.6], [0.9, 2.2], [0.01, 2.3]], 14, [0.75, 0.82, 0.85], [1, 0.08, 0, 0]);
    const capGeo = cap.geometry();
    capGeo.rotateZ(Math.PI / 2);   // long axis horizontal
    capGeo.scale(1.8, 1, 1);
    const capsules = new THREE.InstancedMesh(capGeo, this.instMaterial, 28);
    capsules.frustumCulled = false;
    this.capsules = capsules;
    this.group.add(capsules);
    // supports: A-frames on both sides of the wheel
    const sup = new Mesh();
    for (const side of [-1, 1]) for (const along of [-1, 1]) {
      const foot = new THREE.Vector3(wx, g0, wz).addScaledVector(a, side * 22).addScaledVector(d, along * 18);
      const top = new THREE.Vector3(wx, hub, wz).addScaledVector(a, side * 7);
      sup.tube(foot, top, 1.4, 1.0, 10, WHITE, [0, 0.4, 0, 0]);
    }
    this.group.add(new THREE.Mesh(sup.geometry(), this.material));
    this.updateFlyer(0);
  }

  private updateFlyer(t: number) {
    if (!this.wheel || !this.capsules || !this.flyer) return;
    const f = this.flyer;
    const R = Math.min(f.radius, 75) + 3.2;
    const d = new THREE.Vector3(f.dir[0], 0, -f.dir[1]).normalize();
    const a = new THREE.Vector3(-d.z, 0, d.x);
    // one revolution every 30 minutes
    const ang = (t / 1800) * Math.PI * 2;
    this.wheel.quaternion.setFromAxisAngle(a, ang);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), a);
    for (let i = 0; i < 28; i++) {
      const th = (i / 28) * Math.PI * 2 + ang;
      const p = d.clone().multiplyScalar(Math.cos(th) * R).add(new THREE.Vector3(0, Math.sin(th) * R, 0)).add(this.wheel.position);
      m.compose(p, q, new THREE.Vector3(1, 1, 1));
      this.capsules.setMatrixAt(i, m);
    }
    this.capsules.instanceMatrix.needsUpdate = true;
  }

  private buildSupertrees(list: NonNullable<LandmarkData['supertrees']>) {
    const mesh = new Mesh();
    list.forEach((t, k) => {
      const x = t.x, z = -t.y;
      const g = this.heightAt(x, z);
      const H = t.h;
      const cr = Math.max(6, Math.min(t.r, H * 0.28));
      const trunkTop = H * 0.72;
      // planted trunk: flared base, slender waist, widening into the canopy
      const prof: [number, number][] = [];
      for (let i = 0; i <= 12; i++) {
        const s = i / 12;
        const y = s * trunkTop;
        const r = 2.6 - 1.6 * Math.sin(Math.min(s * 1.4, 1) * Math.PI * 0.5) + s * s * 1.8;
        prof.push([Math.max(r, 0.9) * (H / 45), y]);
      }
      mesh.lathe(x, g, z, prof, 16, [0.3, 0.4, 0.2], [2, 0.95, 0, k / list.length]);
      // canopy: radial ribs from the trunk top to the rim + concentric rings (open lattice)
      const ribs = 24;
      const rim = (i: number, rr: number, yy: number) => {
        const ang = (i / ribs) * Math.PI * 2;
        return new THREE.Vector3(x + Math.cos(ang) * rr, g + yy, z + Math.sin(ang) * rr);
      };
      for (let i = 0; i < ribs; i++) {
        const p0 = rim(i, 1.6 * (H / 45), trunkTop);
        const p1 = rim(i, cr * 0.55, trunkTop + (H - trunkTop) * 0.55);
        const p2 = rim(i, cr, H);
        mesh.tube(p0, p1, 0.32, 0.26, 4, DARK, [0, 0.5, 0, 0]);
        mesh.tube(p1, p2, 0.26, 0.2, 4, DARK, [0, 0.5, 0, 0]);
        // LED fixtures along the ribs
        mesh.tube(p1, p2, 0.3, 0.3, 3, [0.8, 0.8, 0.9], [3, 0.5, k + i * 0.01, k * 0.37]);
      }
      for (const f of [0.35, 0.65, 1.0]) {
        const yy = trunkTop + (H - trunkTop) * f;
        const rr = 1.6 * (H / 45) + (cr - 1.6 * (H / 45)) * f;
        for (let i = 0; i < ribs; i++) mesh.tube(rim(i, rr, yy), rim(i + 1, rr, yy), 0.22, 0.22, 4, DARK, [0, 0.5, 0, 0]);
      }
      // canopy planting mat near the top
      mesh.lathe(x, g, z, [[cr * 0.92, H - 0.4], [cr * 0.5, H - 1.2], [cr * 0.15, H - 0.9]], ribs, [0.25, 0.32, 0.18], [2, 0.95, 0, k * 0.11]);
    });
    this.group.add(new THREE.Mesh(mesh.geometry(), this.material));
  }

  private buildHelix(h: NonNullable<LandmarkData['helix']>) {
    const mesh = new Mesh();
    const c = new THREE.Vector3(h.x, 0, -h.y);
    const dir = new THREE.Vector3(h.dir[0], 0, -h.dir[1]).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const L = h.length;
    const axisY = this.heightAt(c.x, c.z) + 6.5;
    const radius = 5.2, pitch = 18;
    const steps = Math.ceil(L / 1.2);
    for (const phase of [0, Math.PI]) {
      for (const rr of [radius, radius - 1.2]) {
        let prev: THREE.Vector3 | null = null;
        for (let i = 0; i <= steps; i++) {
          const s = -L / 2 + (i / steps) * L;
          const ang = (s / pitch) * Math.PI * 2 + phase;
          const p = c.clone().addScaledVector(dir, s).addScaledVector(side, Math.cos(ang) * rr);
          p.y = axisY + Math.sin(ang) * rr;
          if (prev) mesh.tube(prev, p, rr === radius ? 0.28 : 0.18, rr === radius ? 0.28 : 0.18, 5, [0.82, 0.83, 0.84], rr === radius ? [3, 0.3, 7, phase] : [0, 0.3, 0, 0]);
          prev = p;
        }
      }
    }
    // connecting struts
    for (let i = 0; i <= steps; i += 3) {
      const s = -L / 2 + (i / steps) * L;
      const ang = (s / pitch) * Math.PI * 2;
      const p0 = c.clone().addScaledVector(dir, s).addScaledVector(side, Math.cos(ang) * radius);
      p0.y = axisY + Math.sin(ang) * radius;
      const p1 = c.clone().addScaledVector(dir, s).addScaledVector(side, Math.cos(ang + Math.PI) * radius);
      p1.y = axisY + Math.sin(ang + Math.PI) * radius;
      mesh.tube(p0, p1, 0.08, 0.08, 3, STEEL, [0, 0.4, 0, 0]);
    }
    this.group.add(new THREE.Mesh(mesh.geometry(), this.material));
  }

  update(time: number, hour: number) {
    this.updateFlyer(time);
    // Garden Rhapsody: 19:45 and 20:45, ~13 minutes
    const show = (h: number) => (hour >= h && hour < h + 13 / 60 ? 1 : 0);
    this.uniforms.uShow.value = Math.max(show(19.75), show(20.75));
    this.uniforms.uHour.value = hour;
  }

  setDepthMode(on: boolean) {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (on) { m.userData.mat = m.material; m.material = (m as THREE.InstancedMesh).isInstancedMesh ? this.depthInst : this.depth; }
      else if (m.userData.mat) m.material = m.userData.mat;
    });
  }
}
