import * as THREE from 'three';
import { COMMON, CURVATURE } from '../shaders/common';
import { ATMO_PARAMS, ATMO_RUNTIME } from '../shaders/atmosphere';
import { SHADOWS, LIGHTING } from '../shaders/lighting';
import { U } from '../core/uniforms';

// Road classes from the schema: motorway 0, trunk 1, primary 2, secondary 3, tertiary 4, minor 5, service 6, motorway_link 7, link 8, busway 12
const SPACING = [34, 38, 46, 55, 70, 130, 260, 60, 70, 0, 0, 0, 120];
const SPEED = [22, 18, 14, 13, 11, 8, 5, 14, 11, 0, 0, 0, 10];

interface Lane { pts: Float32Array; n: number; len: number; cls: number }
interface Car { lane: number; s: number; v: number; kind: number; color: THREE.Color }
interface TileTraffic { key: string; ox: number; oy: number; lanes: Lane[]; cars: Car[] }

const VS = /* glsl */ `
in vec4 aPart;      // x: 0 body / 1 glass / 2 headlight / 3 taillight
out vec3 vWorld;
out vec3 vNormal;
out vec3 vCol;
flat out float vPart;
${CURVATURE}
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
#ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
#else
  vCol = vec3(0.8);
#endif
  vPart = aPart.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(wp.xyz), 1.0);
}
`;

const FS = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
in vec3 vCol;
flat in float vPart;
out vec4 fragColor;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${SHADOWS}
${LIGHTING}
void main() {
  vec3 wp = vWorld;
  vec3 V = normalize(cameraPosition - wp);
  float dist = length(cameraPosition - wp);
  vec3 N = normalize(vNormal);
  vec3 albedo = vCol;   // instance colours are already linear
  float rough = 0.35, f0 = 0.06;
  vec3 emis = vec3(0.0);
  if (vPart > 0.5 && vPart < 1.5) { albedo = vec3(0.03); rough = 0.08; }
  if (vPart > 1.5 && vPart < 2.5) { albedo = vec3(0.9); emis = vec3(1.0, 0.95, 0.85) * 14.0; }
  if (vPart > 2.5) { albedo = vec3(0.4, 0.02, 0.02); emis = vec3(1.0, 0.05, 0.03) * 7.0; }
  float sh = sunShadow(wp, N, dist);
  vec3 col = shadeSurface(albedo, N, V, rough, f0, sh, 0.8, wp);
  vec3 R = reflect(-V, N);
  col += skyRadiance(normalize(vec3(R.x, max(R.y, 0.02), R.z))) * (f0 + (1.0 - f0) * pow(1.0 - max(dot(N, V), 0.0), 5.0)) * 0.6;
  col += emis * uNight * uSunIntensity * 0.0075;
  col = applyAerial(col, wp);
  fragColor = vec4(col, 1.0);
}
`;

function carGeometry(length: number, width: number, height: number, bus: boolean) {
  const g = new THREE.BufferGeometry();
  const pos: number[] = [], nrm: number[] = [], part: number[] = [], idx: number[] = [];
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, p: number, pFront = p, pBack = p) => {
    // x along the car (front = +x), y up, z across
    const faces: [number[], number[], number][] = [
      [[1, 0, 0], [x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0], pFront],
      [[-1, 0, 0], [x0, y0, z1, x0, y0, z0, x0, y1, z0, x0, y1, z1], pBack],
      [[0, 1, 0], [x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1], p],
      [[0, 0, 1], [x1, y0, z1, x0, y0, z1, x0, y1, z1, x1, y1, z1], p],
      [[0, 0, -1], [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0], p],
    ];
    for (const [n, v, pp] of faces) {
      const b = pos.length / 3;
      for (let i = 0; i < 4; i++) { pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); nrm.push(n[0], n[1], n[2]); part.push(pp, 0, 0, 0); }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  };
  const L = length / 2, W = width / 2;
  if (bus) {
    box(-L, L, 0.35, height * 0.42, -W, W, 0, 2, 3);
    box(-L, L, height * 0.42, height * 0.86, -W, W, 1, 1, 1);
    box(-L, L, height * 0.86, height, -W, W, 0);
  } else {
    box(-L, L, 0.25, height * 0.55, -W, W, 0, 2, 3);
    box(-L * 0.55, L * 0.35, height * 0.55, height, -W * 0.92, W * 0.92, 1);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 4));
  g.setIndex(idx);
  return g;
}

const CAR_COLOURS = ['#f2f2f0', '#e9e9e7', '#1c1d1f', '#2b2d31', '#9ea2a6', '#c3c6c9', '#7a1e22', '#1f3a66', '#d9d6cf', '#5c5f63'];
const TAXI_COLOURS = ['#1e5bb8', '#f2c230', '#1c1d1f', '#3e8f3a', '#c4c6c8'];
const BUS_COLOURS = ['#2f7d3a', '#9b1c24', '#6b2c86', '#d8d8d6'];

export class Traffic {
  group = new THREE.Group();
  private cars: THREE.InstancedMesh;
  private buses: THREE.InstancedMesh;
  private tiles = new Map<string, TileTraffic>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private rng = 1;
  material: THREE.ShaderMaterial;
  depth: THREE.ShaderMaterial;
  range = 1300;
  maxCars = 5000;
  density = 1;

  constructor() {
    this.material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: U });
    this.depth = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'void main(){ gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }',
      fragmentShader: 'out vec4 c; void main(){ c = vec4(1.0); }', colorWrite: false,
    });
    this.cars = new THREE.InstancedMesh(carGeometry(4.5, 1.8, 1.45, false), this.material, this.maxCars);
    this.buses = new THREE.InstancedMesh(carGeometry(12, 2.5, 3.2, true), this.material, 600);
    for (const im of [this.cars, this.buses]) {
      im.frustumCulled = false;
      im.count = 0;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, new THREE.Color(1, 1, 1));
      this.group.add(im);
    }
  }

  private rand() { this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0; return this.rng / 4294967296; }

  addTile(key: string, data: Float32Array | null, ox: number, oy: number) {
    if (!data || !data.length) return;
    const lanes: Lane[] = [];
    let o = 0;
    while (o < data.length) {
      const cls = data[o], n = data[o + 1];
      const pts = data.subarray(o + 2, o + 2 + n * 4);
      lanes.push({ pts, n, len: pts[(n - 1) * 4 + 3], cls });
      o += 2 + n * 4;
    }
    this.rng = (ox * 73856093) ^ (oy * 19349663);
    const cars: Car[] = [];
    lanes.forEach((ln, li) => {
      const sp = SPACING[ln.cls] || 0;
      if (!sp) return;
      const count = Math.floor(ln.len / sp);
      for (let i = 0; i < count; i++) {
        const busy = ln.cls === 12 || (ln.cls >= 2 && ln.cls <= 4 && this.rand() < 0.06);
        const taxi = !busy && this.rand() < 0.18;
        const pal = busy ? BUS_COLOURS : taxi ? TAXI_COLOURS : CAR_COLOURS;
        cars.push({
          lane: li, s: (i + this.rand() * 0.6) * sp, v: (SPEED[ln.cls] || 8) * (0.85 + this.rand() * 0.25),
          kind: busy ? 1 : 0, color: new THREE.Color(pal[Math.floor(this.rand() * pal.length)]),   // linear working space
        });
      }
    });
    this.tiles.set(key, { key, ox, oy, lanes, cars });
  }

  removeTile(key: string) { this.tiles.delete(key); }

  /** fraction of cars on the road by hour: rush hours busy, late night sparse */
  private flow(hour: number) {
    const g = (c: number, w: number) => Math.exp(-(((hour - c) / w) ** 2));
    return Math.min(1, 0.22 + 0.75 * g(8.3, 1.6) + 0.6 * g(18.5, 2.0) + 0.45 * g(13, 3.5) - 0.18 * g(3.5, 2.2));
  }

  update(t: number, camera: THREE.Camera, hour: number) {
    const cx = camera.position.x, cz = camera.position.z;
    const alt = camera.position.y;
    let nc = 0, nb = 0;
    if (alt < 2500) {
      const keep = this.flow(hour) * this.density;
      const tiles = [...this.tiles.values()].sort((a, b) => Math.hypot(a.ox - cx, -a.oy - cz) - Math.hypot(b.ox - cx, -b.oy - cz));
      for (const tt of tiles) {
        const dTile = Math.max(0, Math.hypot(tt.ox - cx, -tt.oy - cz) - 724);
        if (dTile > this.range) continue;
        for (let i = 0; i < tt.cars.length; i++) {
          const car = tt.cars[i];
          // deterministic thinning keeps the same cars as the flow changes
          if (((i * 2654435761) >>> 0) / 4294967296 > keep) continue;
          const ln = tt.lanes[car.lane];
          const s = (car.s + t * car.v) % ln.len;
          // binary search segment
          const P = ln.pts;
          let lo = 0, hi = ln.n - 1;
          while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid * 4 + 3] <= s) lo = mid; else hi = mid; }
          const s0 = P[lo * 4 + 3], s1 = P[hi * 4 + 3];
          const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
          const x0 = P[lo * 4], y0 = P[lo * 4 + 1], z0 = P[lo * 4 + 2];
          const x1 = P[hi * 4], y1 = P[hi * 4 + 1], z1 = P[hi * 4 + 2];
          const wx = tt.ox + x0 + (x1 - x0) * f;
          const wz = -(tt.oy + y0 + (y1 - y0) * f);
          const dx = wx - cx, dz = wz - cz;
          if (dx * dx + dz * dz > this.range * this.range) continue;
          const wy = z0 + (z1 - z0) * f;
          const yaw = Math.atan2(-(y1 - y0), x1 - x0);
          const pitch = Math.atan2(z1 - z0, Math.max(s1 - s0, 0.01));
          this.e.set(0, yaw, pitch, 'YZX');
          this.q.setFromEuler(this.e);
          this.p.set(wx, wy, wz);
          this.m.compose(this.p, this.q, this.s);
          if (car.kind === 1) {
            if (nb >= 600) continue;
            this.buses.setMatrixAt(nb, this.m);
            this.buses.setColorAt(nb, car.color);
            nb++;
          } else {
            if (nc >= this.maxCars) break;
            this.cars.setMatrixAt(nc, this.m);
            this.cars.setColorAt(nc, car.color);
            nc++;
          }
        }
        if (nc >= this.maxCars) break;
      }
    }
    this.cars.count = nc;
    this.buses.count = nb;
    for (const im of [this.cars, this.buses]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  setDepthMode(on: boolean) {
    for (const im of [this.cars, this.buses]) im.material = on ? this.depth : this.material;
  }
}
