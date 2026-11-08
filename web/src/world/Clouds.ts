import * as THREE from 'three';
import { COMMON } from '../shaders/common';
import { ATMO_PARAMS, ATMO_RUNTIME } from '../shaders/atmosphere';
import { U } from '../core/uniforms';
import { CLOUD_COMMON } from '../shaders/clouds';

/** Tileable 3D noise (Perlin-Worley in R, Worley fbm in G) generated once on the CPU. */
function makeNoise(N = 64) {
  const data = new Uint8Array(N * N * N * 4);
  const cells = (c: number) => {
    // one jittered feature point per cell, tileable
    const pts = new Float32Array(c * c * c * 3);
    let s = 1337 + c;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
    for (let i = 0; i < c * c * c; i++) { pts[i * 3] = rnd(); pts[i * 3 + 1] = rnd(); pts[i * 3 + 2] = rnd(); }
    return pts;
  };
  const worley = (x: number, y: number, z: number, c: number, pts: Float32Array) => {
    const px = x * c, py = y * c, pz = z * c;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz;
      const wx = ((cx % c) + c) % c, wy = ((cy % c) + c) % c, wz = ((cz % c) + c) % c;
      const k = (wz * c * c + wy * c + wx) * 3;
      const fx = cx + pts[k] - px, fy = cy + pts[k + 1] - py, fz = cz + pts[k + 2] - pz;
      const d = fx * fx + fy * fy + fz * fz;
      if (d < best) best = d;
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  // tileable value noise for the Perlin part
  const vgrid = (c: number) => {
    const g = new Float32Array(c * c * c);
    let s = 99 + c;
    for (let i = 0; i < g.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; g[i] = s / 4294967296; }
    return g;
  };
  const vnoise = (x: number, y: number, z: number, c: number, g: Float32Array) => {
    const px = x * c, py = y * c, pz = z * c;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const fx = px - ix, fy = py - iy, fz = pz - iz;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
    const at = (a: number, b: number, d: number) => g[((((iz + d) % c) + c) % c) * c * c + ((((iy + b) % c) + c) % c) * c + ((((ix + a) % c) + c) % c)];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(l(l(at(0, 0, 0), at(1, 0, 0), ux), l(at(0, 1, 0), at(1, 1, 0), ux), uy), l(l(at(0, 0, 1), at(1, 0, 1), ux), l(at(0, 1, 1), at(1, 1, 1), ux), uy), uz);
  };
  const P = [cells(4), cells(8), cells(16)];
  const V = [vgrid(4), vgrid(8), vgrid(16)];
  const D = [cells(8), cells(16), cells(32)];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N, v = (y + 0.5) / N, w = (z + 0.5) / N;
    const per = vnoise(u, v, w, 4, V[0]) * 0.5 + vnoise(u, v, w, 8, V[1]) * 0.3 + vnoise(u, v, w, 16, V[2]) * 0.2;
    const wor = worley(u, v, w, 4, P[0]) * 0.625 + worley(u, v, w, 8, P[1]) * 0.25 + worley(u, v, w, 16, P[2]) * 0.125;
    // Perlin-Worley: billowy Perlin remapped by Worley
    const pw = Math.min(1, Math.max(0, per * 0.55 + wor * 0.65 - 0.15));
    const det = worley(u, v, w, 8, D[0]) * 0.625 + worley(u, v, w, 16, D[1]) * 0.25 + worley(u, v, w, 32, D[2]) * 0.125;
    const i = ((z * N + y) * N + x) * 4;
    data[i] = pw * 255; data[i + 1] = det * 255; data[i + 2] = 0; data[i + 3] = 255;
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}


const VS = /* glsl */ `
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const MARCH_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler3D tNoise;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform vec2 uDepthCD;
uniform float uReversed;
uniform float uFrame;
uniform int uSteps;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${CLOUD_COMMON}

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

float density(vec3 p, bool full) {
  float h = (p.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
  if (h < 0.0 || h > 1.0) return 0.0;
  float cov = cloudCoverage(p.xz);
  if (cov < 0.01) return 0.0;
  // cumulus profile: flat-ish base, rounded billowing top that rises with coverage
  float grad = smoothstep(0.0, 0.08, h) * smoothstep(0.35 + 0.65 * cov, 0.15, h);
  vec3 w = vec3(uCloudWind.x, 0.0, uCloudWind.y);
  vec4 n = texture(tNoise, (p + w) / vec3(2600.0, 1800.0, 2600.0));
  float base = remap(n.r * grad, 1.0 - cov, 1.0, 0.0, 1.0);
  if (base <= 0.0) return 0.0;
  if (full) {
    float det = texture(tNoise, (p + w * 1.6) / 520.0 + vec3(0.0, uTime * 0.004, 0.0)).g;
    base = remap(base, det * 0.38 * (1.0 - h * 0.6), 1.0, 0.0, 1.0);
  }
  return saturate(base) * 0.045;
}

float lightMarch(vec3 p) {
  float sum = 0.0;
  float step = 70.0;
  vec3 L = normalize(uSunDir.y < 0.0 && uMoonDir.y > 0.0 ? uMoonDir : uSunDir);
  for (int i = 0; i < 6; i++) {
    p += L * step;
    sum += density(p, i < 3) * step;
    step *= 1.6;
  }
  return sum;
}

void main() {
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  v /= v.w;
  vec3 rd = normalize((uInvView * vec4(v.xyz, 0.0)).xyz);
  vec3 ro = uCamPos;
  // slab intersection
  float t0, t1;
  if (abs(rd.y) < 1e-4) { if (ro.y < CLOUD_BASE || ro.y > CLOUD_TOP) { fragColor = vec4(0, 0, 0, 1); return; } t0 = 0.0; t1 = 40000.0; }
  else {
    float ta = (CLOUD_BASE - ro.y) / rd.y, tb = (CLOUD_TOP - ro.y) / rd.y;
    t0 = max(min(ta, tb), 0.0); t1 = max(ta, tb);
  }
  // clip by the scene depth (terrain / buildings in front of the clouds)
  float dpt = texture(tDepth, vUv).r;
  float viewZ = uReversed > 0.5 ? uDepthCD.y / max(dpt + uDepthCD.x, 1e-9) : uDepthCD.y / (dpt * 2.0 - 1.0 + uDepthCD.x);
  bool sky = uReversed > 0.5 ? dpt <= 0.0 : dpt >= 1.0;
  if (!sky) t1 = min(t1, abs(viewZ) / max(dot(rd, uCamFwd), 1e-3));
  t1 = min(t1, t0 + 60000.0);
  if (t1 <= t0) { fragColor = vec4(0, 0, 0, 1); return; }
  int N = uSteps;
  float len = t1 - t0;
  float dt = len / float(N);
  float jitter = ign(gl_FragCoord.xy + uFrame * 5.588);
  float t = t0 + dt * jitter;
  vec3 L = uSunDir;
  float mu = dot(rd, L);
  float phase = mix(hgPhase(0.6, mu), hgPhase(-0.25, mu), 0.3) + 0.05;
  vec3 sunCol = texture(tTransmittance, transmittanceUV(RG + 1.6, L.y)).rgb * uSunIntensity * smoothstep(-0.03, 0.04, L.y);
  vec3 moonCol = uMoonLight * 4.0;
  vec3 skyUp = texelFetch(tAtmoParams, ivec2(2, 0), 0).rgb / PI;
  vec3 skyDown = texelFetch(tAtmoParams, ivec2(3, 0), 0).rgb / PI;
  vec3 cityGlow = vec3(0.0135, 0.0118, 0.0106) * uNight * uSunIntensity * 0.02;
  vec3 Lacc = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < 96; i++) {
    if (i >= N || T < 0.02) break;
    vec3 p = ro + rd * t;
    float d = density(p, true);
    if (d > 1e-5) {
      float h = (p.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
      float od = lightMarch(p);
      float beer = exp(-od) ;
      float powder = 1.0 - exp(-d * 2.0 * 60.0);
      vec3 direct = (sunCol + moonCol) * beer * mix(1.0, powder * 2.0, 0.5) * phase;
      vec3 amb = mix(skyDown * 0.6 + cityGlow * 3.0, skyUp, h * 0.7 + 0.3);
      vec3 S = (direct + amb) * d;
      float st = exp(-d * dt);
      Lacc += T * (S - S * st) / d;
      T *= st;
    }
    t += dt;
  }
  // aerial perspective on the clouds: fade into the haze with distance
  float dist = t0 + len * 0.5;
  vec3 Tair = exp(-opticalDepth(uCamAltKm, 1.6, dist * 0.001));
  Lacc = Lacc * Tair + aerialInscatter(rd, dist * 0.001) * (1.0 - T);
  fragColor = vec4(Lacc, T);
}
`;

const COMPOSITE_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tClouds;
uniform vec2 uTexel;
void main() {
  // light blur while upsampling hides the low-resolution march
  vec4 c = texture(tClouds, vUv) * 0.4;
  c += texture(tClouds, vUv + vec2(uTexel.x, 0.0)) * 0.15;
  c += texture(tClouds, vUv - vec2(uTexel.x, 0.0)) * 0.15;
  c += texture(tClouds, vUv + vec2(0.0, uTexel.y)) * 0.15;
  c += texture(tClouds, vUv - vec2(0.0, uTexel.y)) * 0.15;
  fragColor = c;   // blended: dst * a + rgb
}
`;

export class Clouds {
  private noise: THREE.Data3DTexture;
  private rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private march: THREE.ShaderMaterial;
  private comp: THREE.ShaderMaterial;
  enabled = true;
  scale = 0.33;
  steps = 48;
  private frame = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.noise = makeNoise(64);
    this.rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.march = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: MARCH_FS, depthTest: false, depthWrite: false,
      uniforms: {
        ...U, tNoise: { value: this.noise }, tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() }, uCamFwd: { value: new THREE.Vector3() }, uDepthCD: { value: new THREE.Vector2() },
        uReversed: { value: 0 }, uFrame: { value: 0 }, uSteps: { value: 48 },
      },
    });
    this.comp = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: COMPOSITE_FS, depthTest: false, depthWrite: false,
      uniforms: { tClouds: { value: this.rt.texture }, uTexel: { value: new THREE.Vector2() } },
      transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.march);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setSize(w: number, h: number) {
    this.rt.setSize(Math.max(8, Math.round(w * this.scale)), Math.max(8, Math.round(h * this.scale)));
    this.comp.uniforms.uTexel.value.set(1 / this.rt.width, 1 / this.rt.height);
  }

  /** depth: resolved scene depth; target: the HDR scene target to composite into */
  render(camera: THREE.PerspectiveCamera, depth: THREE.Texture, target: THREE.WebGLRenderTarget, reversed: boolean) {
    if (!this.enabled || U.uCloudCover.value < 0.01) return;
    const u = this.march.uniforms;
    u.tDepth.value = depth;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uInvView.value.copy(camera.matrixWorld);
    u.uCamPos.value.copy(camera.position);
    camera.getWorldDirection(u.uCamFwd.value);
    const pm = camera.projectionMatrix.elements;
    // view z from depth: reversed (zero-to-one): z = d / (depth + c); standard: z = d / (ndc + c)
    u.uDepthCD.value.set(pm[10], pm[14]);
    u.uReversed.value = reversed ? 1 : 0;
    u.uFrame.value = this.frame++ % 64;
    u.uSteps.value = this.steps;
    const prev = this.renderer.getRenderTarget();
    this.quad.material = this.march;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.cam);
    this.quad.material = this.comp;
    this.renderer.setRenderTarget(target);
    const ac = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.scene, this.cam);
    this.renderer.autoClear = ac;
    this.renderer.setRenderTarget(prev);
  }
}
