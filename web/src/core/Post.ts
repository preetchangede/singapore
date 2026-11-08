import * as THREE from 'three';
import { COMMON } from '../shaders/common';
import { U } from './uniforms';

const VS = /* glsl */ `
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DOWN_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
${COMMON}
vec3 tap(vec2 o) { return texture(tSrc, vUv + o * uTexel).rgb; }
float kw(vec3 c) { return 1.0 / (1.0 + lum(c)); }
void main() {
  vec3 a = tap(vec2(-2, 2)), b = tap(vec2(0, 2)), c = tap(vec2(2, 2));
  vec3 d = tap(vec2(-2, 0)), e = tap(vec2(0, 0)), f = tap(vec2(2, 0));
  vec3 g = tap(vec2(-2, -2)), h = tap(vec2(0, -2)), i = tap(vec2(2, -2));
  vec3 j = tap(vec2(-1, 1)), k = tap(vec2(1, 1)), l = tap(vec2(-1, -1)), m = tap(vec2(1, -1));
  vec3 res;
  if (uFirst > 0.5) {
    // Karis average on the first downsample kills fireflies
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = kw(g0), w1 = kw(g1), w2 = kw(g2), w3 = kw(g3), w4 = kw(g4);
    res = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) /
          (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
  } else {
    res = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  fragColor = vec4(max(res, 0.0), 1.0);
}
`;

const UP_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 uTexel;    // of tLow
uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture(tLow, vUv + vec2(-t.x, t.y)).rgb + texture(tLow, vUv + vec2(t.x, t.y)).rgb
         + texture(tLow, vUv + vec2(-t.x, -t.y)).rgb + texture(tLow, vUv + vec2(t.x, -t.y)).rgb;
  s += 2.0 * (texture(tLow, vUv + vec2(0.0, t.y)).rgb + texture(tLow, vUv + vec2(0.0, -t.y)).rgb
            + texture(tLow, vUv + vec2(t.x, 0.0)).rgb + texture(tLow, vUv + vec2(-t.x, 0.0)).rgb);
  s += 4.0 * texture(tLow, vUv).rgb;
  fragColor = vec4(texture(tHigh, vUv).rgb + s / 16.0, 1.0);
}
`;

const FINAL_FS = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloom;
uniform float uVignette;
uniform float uGrain;
uniform float uFade;
uniform float uTime;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uTint;
uniform vec2 uResolution;
uniform float uFxaa;
uniform sampler2D tAtmoParams;
uniform vec3 uSunDir;
uniform float uSunIntensity;
uniform float uNightFloor;
${COMMON}

// --- AgX (Sobotka), minimal fit by Benjamin Wrensch
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 v) {
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float mn = -12.47393, mx = 4.026069;
  v = m * v;
  v = clamp(log2(max(v, 1e-10)), mn, mx);
  v = (v - mn) / (mx - mn);
  return agxContrast(v);
}
vec3 agxEotf(vec3 v) {
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  return pow(max(mi * v, 0.0), vec3(2.2));
}
vec3 agxLook(vec3 v) {
  float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
  v = pow(max(v, 0.0), vec3(uContrast));
  return l + uSaturation * (v - l);
}

vec3 sceneAt(vec2 uv) { return texture(tScene, uv).rgb; }

vec3 fxaa(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 rgbNW = sceneAt(uv + vec2(-1.0, -1.0) * px), rgbNE = sceneAt(uv + vec2(1.0, -1.0) * px);
  vec3 rgbSW = sceneAt(uv + vec2(-1.0, 1.0) * px), rgbSE = sceneAt(uv + vec2(1.0, 1.0) * px);
  vec3 rgbM = sceneAt(uv);
  vec3 lw = vec3(0.299, 0.587, 0.114);
  float lNW = dot(log2(1.0 + rgbNW), lw), lNE = dot(log2(1.0 + rgbNE), lw), lSW = dot(log2(1.0 + rgbSW), lw), lSE = dot(log2(1.0 + rgbSE), lw), lM = dot(log2(1.0 + rgbM), lw);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, -8.0, 8.0) * px;
  vec3 a = 0.5 * (sceneAt(uv + dir * (1.0 / 3.0 - 0.5)) + sceneAt(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 b = a * 0.5 + 0.25 * (sceneAt(uv + dir * -0.5) + sceneAt(uv + dir * 0.5));
  float lb = dot(log2(1.0 + b), lw);
  return (lb < lMin || lb > lMax) ? a : b;
}

void main() {
  vec3 c = uFxaa > 0.5 ? fxaa(vUv) : sceneAt(vUv);
  vec3 bl = texture(tBloom, vUv).rgb / 6.0;   // sum of 6 normalised levels
  c = mix(c, bl, uBloom);
  // auto exposure from the atmosphere's illuminance (no GPU readback): mid-grey for a
  // 20% albedo surface, with a floor so night stays night.
  vec3 amb = texelFetch(tAtmoParams, ivec2(2, 0), 0).rgb;
  vec3 sun = texelFetch(tAtmoParams, ivec2(7, 0), 0).rgb;
  float E = lum(amb) + lum(sun) * max(uSunDir.y, 0.0);
  float exposure = 0.18 * PI / (0.2 * max(E, uNightFloor * uSunIntensity));
  c *= exposure * uExposure;
  c *= uTint;
  // vignette (subtle, natural lens falloff)
  vec2 q = vUv - 0.5;
  q.x *= uResolution.x / uResolution.y;
  c *= mix(1.0, smoothstep(1.15, 0.25, length(q)), uVignette);
  c = agxEotf(agxLook(agx(c)));
  c = linearToSrgb(c);
  // film grain + dither (breaks gradient banding in the sky)
  float n = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) - 0.5;
  c += n * uGrain + (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  c *= uFade;
  fragColor = vec4(c, 1.0);
}
`;

export class Post {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private down: THREE.ShaderMaterial;
  private up: THREE.ShaderMaterial;
  final: THREE.ShaderMaterial;
  private downs: THREE.WebGLRenderTarget[] = [];
  private ups: THREE.WebGLRenderTarget[] = [];
  private levels = 6;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const mk = (fs: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false,
    });
    this.down = mk(DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
    this.up = mk(UP_FS, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 } });
    this.final = mk(FINAL_FS, {
      tScene: { value: null }, tBloom: { value: null }, uExposure: U.uExposure, uBloom: { value: 0.06 },
      uVignette: { value: 0.35 }, uGrain: { value: 0.012 }, uFade: { value: 1 }, uTime: U.uTime,
      uSaturation: { value: 1.1 }, uContrast: { value: 1.1 }, uTint: { value: new THREE.Vector3(1, 1, 1) },
      uResolution: { value: new THREE.Vector2(1, 1) }, uFxaa: { value: 0 },
      tAtmoParams: U.tAtmoParams, uSunDir: U.uSunDir, uSunIntensity: U.uSunIntensity, uNightFloor: { value: 0.011 },
    });
  }

  setSize(w: number, h: number) {
    for (const t of [...this.downs, ...this.ups]) t.dispose();
    this.downs = []; this.ups = [];
    let cw = Math.max(1, w >> 1), ch = Math.max(1, h >> 1);
    for (let i = 0; i < this.levels; i++) {
      const o = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
      this.downs.push(new THREE.WebGLRenderTarget(cw, ch, o));
      this.ups.push(new THREE.WebGLRenderTarget(cw, ch, o));
      cw = Math.max(1, cw >> 1); ch = Math.max(1, ch >> 1);
    }
    (this.final.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  render(scene: THREE.Texture) {
    // bloom down chain
    let src: THREE.Texture = scene;
    let sw = this.downs[0].width * 2, sh = this.downs[0].height * 2;
    for (let i = 0; i < this.levels; i++) {
      this.down.uniforms.tSrc.value = src;
      this.down.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      this.down.uniforms.uFirst.value = i === 0 ? 1 : 0;
      this.pass(this.down, this.downs[i]);
      src = this.downs[i].texture;
      sw = this.downs[i].width; sh = this.downs[i].height;
    }
    // up chain
    let low = this.downs[this.levels - 1].texture;
    for (let i = this.levels - 2; i >= 0; i--) {
      const lt = i + 1 === this.levels - 1 ? this.downs[i + 1] : this.ups[i + 1];
      this.up.uniforms.tLow.value = low;
      this.up.uniforms.tHigh.value = this.downs[i].texture;
      this.up.uniforms.uTexel.value.set(1 / lt.width, 1 / lt.height);
      this.pass(this.up, this.ups[i]);
      low = this.ups[i].texture;
    }
    this.final.uniforms.tScene.value = scene;
    this.final.uniforms.tBloom.value = low;
    this.pass(this.final, null);
  }
}
