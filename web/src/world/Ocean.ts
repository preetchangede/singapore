import * as THREE from 'three';
import { COMMON, CURVATURE } from '../shaders/common';
import { ATMO_PARAMS, ATMO_RUNTIME } from '../shaders/atmosphere';
import { TERRAIN_SAMPLE } from '../shaders/terrain';
import { SHADOWS, LIGHTING } from '../shaders/lighting';
import { U } from '../core/uniforms';

const VS = /* glsl */ `
out vec3 vWorld;
${CURVATURE}
void main() {
  // geometry is camera-relative in xz; follow the camera
  vec3 wp = vec3(position.x + cameraPosition.x, 0.0, position.z + cameraPosition.z);
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(wp), 1.0);
}
`;

export const WATER_WAVES = /* glsl */ `
// Sum of directional waves -> slope (dh/dx, dh/dz); amplitude-weighted & distance-filtered.
vec2 waveSlope(vec2 p, float t, float filt) {
  vec2 s = vec2(0.0);
  float amp = 0.10, freq = 0.06;
  vec2 dir = normalize(vec2(0.8, 0.6));
  for (int i = 0; i < 9; i++) {
    float w = freq * TAU;
    float ph = dot(dir, p) * w + t * sqrt(9.81 * w) + float(i) * 1.7;
    float att = exp(-freq * filt);              // remove waves smaller than the pixel footprint
    s += dir * (amp * w * cos(ph)) * att;
    // rotate direction, shrink & speed up
    dir = mat2(0.737, 0.676, -0.676, 0.737) * dir;
    amp *= 0.64;
    freq *= 1.72;
  }
  return s;
}
`;

const FS = /* glsl */ `
in vec3 vWorld;
out vec4 fragColor;
uniform sampler2D tReflection;
uniform float uReflectionOn;
uniform vec2 uResolution;
uniform mat4 uReflMatrix;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${TERRAIN_SAMPLE}
${SHADOWS}
${LIGHTING}
${WATER_WAVES}
void main() {
  vec3 wp = vWorld;
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float cd = coastDist(wp.xz);
  if (cd > 1.5) discard;                         // land
  float t = uTime;
  // footprint of a pixel on the water (m): grows with distance and grazing angle
  float foot = dist * 0.0012 / max(V.y, 0.08);
  vec2 sl = waveSlope(wp.xz * 1.0, t, foot * 1.5);
  // calmer water in sheltered places (near the shore)
  float shelter = smoothstep(0.0, 250.0, -cd);
  sl *= mix(0.45, 1.0, shelter);
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
  // roughness grows with distance to preserve the glitter energy (LEAN-like)
  float rough = clamp(0.07 + foot * 0.012, 0.07, 0.55);

  float NoV = max(dot(N, V), 1e-3);
  float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.002;
  vec3 refl = skyRadiance(normalize(R));
  if (uReflectionOn > 0.5) {
    vec4 rc = uReflMatrix * vec4(wp, 1.0);
    vec2 off = N.xz * 0.06 * clamp(60.0 / max(dist, 1.0), 0.15, 1.0);
    vec4 pr = texture(tReflection, rc.xy / rc.w + off);
    refl = mix(refl, pr.rgb, pr.a);
  }
  // sun glint (GGX)
  vec3 L = uSunDir;
  vec3 H = normalize(L + V);
  float NoL = saturate(dot(N, L));
  float a = rough * rough;
  float spec = D_GGX(saturate(dot(N, H)), a) * V_SmithJointApprox(NoV, NoL, a) * NoL;
  vec3 sun = sunLight();
  float sh = sunShadow(wp, vec3(0.0, 1.0, 0.0), dist);
  // body colour: turbid tropical strait (green-grey), lighter + browner near the coast
  float depth = clamp(-terrainHeight(wp.xz), 0.5, 30.0);
  vec3 deep = srgbToLinear(vec3(0.13, 0.27, 0.29));
  vec3 shallow = srgbToLinear(vec3(0.28, 0.37, 0.30));
  vec3 body = mix(shallow, deep, smoothstep(1.0, 14.0, depth));
  vec3 Eamb = ambientCube(vec3(0.0, 1.0, 0.0));
  vec3 scatter = body * (sun * saturate(L.y) * sh * 0.75 + Eamb * 0.85) / PI;
  vec3 col = mix(scatter, refl, F) + sun * spec * 0.6 * F_Schlick(vec3(0.02), saturate(dot(V, H))) / 0.02 * 0.02 * sh;
  // shoreline foam: thin lapping band
  float foam = smoothstep(4.0, 0.0, -cd) * (0.5 + 0.5 * sin(t * 1.3 + wp.x * 0.05 + wp.z * 0.04));
  foam *= smoothstep(0.35, 0.7, vnoise(wp.xz * 0.35 + t * 0.2));
  col = mix(col, (sun * saturate(L.y) * sh + Eamb) * 0.55 / PI, foam * 0.6 * smoothstep(800.0, 50.0, dist));
  // city lights glimmer on the water at night
  col += vec3(0.010, 0.006, 0.003) * uNight * uSunIntensity * 0.02 * F;
  col = applyAerial(col, wp);
  fragColor = vec4(col, 1.0);
}
`;

export class Ocean {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor() {
    // radial grid: dense near the camera, geometric spacing outwards (to 400 km)
    const rings = 160, segs = 192;
    const pos: number[] = [0, 0, 0];
    const radii: number[] = [];
    let r = 2.0;
    for (let i = 0; i < rings; i++) { radii.push(r); r *= 1.075; }
    for (const rr of radii) for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
    }
    const idx: number[] = [];
    for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
    for (let i = 0; i < rings - 1; i++) for (let s = 0; s < segs; s++) {
      const a = 1 + i * segs + s, b = 1 + i * segs + ((s + 1) % segs);
      const c = a + segs, d = b + segs;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: U,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
  }
}
