import * as THREE from 'three';
import { COMMON, CURVATURE } from '../shaders/common';
import { ATMO_PARAMS, ATMO_RUNTIME } from '../shaders/atmosphere';
import { TERRAIN_SAMPLE } from '../shaders/terrain';
import { SHADOWS, LIGHTING } from '../shaders/lighting';
import { WATER_WAVES } from './Ocean';
import { U } from '../core/uniforms';

const VS = /* glsl */ `
in float aKind;
out vec3 vWorld;
flat out float vKind;
${CURVATURE}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vKind = aKind;
  gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(wp.xyz), 1.0);
}
`;

const FS = /* glsl */ `
in vec3 vWorld;
flat in float vKind;
out vec4 fragColor;
uniform sampler2D tReflection;
uniform float uReflectionOn;
uniform vec2 uResolution;
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
  float foot = dist * 0.0012 / max(V.y, 0.08);
  // reservoirs & bays: gentle wind ripples; canals: nearly still
  float calm = vKind > 2.5 ? 0.35 : 0.6;
  vec2 sl = waveSlope(wp.xz * 1.6, uTime * 0.8, foot * 2.0) * calm;
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
  float rough = clamp(0.05 + foot * 0.01, 0.05, 0.4);
  float NoV = max(dot(N, V), 1e-3);
  float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.002;
  vec3 refl = skyRadiance(normalize(R));
  if (uReflectionOn > 0.5) {
    vec2 suv = gl_FragCoord.xy / uResolution;
    vec4 pr = texture(tReflection, suv + N.xz * 0.04 * clamp(80.0 / max(dist, 1.0), 0.15, 1.0));
    refl = mix(refl, pr.rgb, pr.a);
  }
  vec3 L = uSunDir;
  vec3 H = normalize(L + V);
  float NoL = saturate(dot(N, L));
  float a = rough * rough;
  float spec = D_GGX(saturate(dot(N, H)), a) * V_SmithJointApprox(NoV, NoL, a) * NoL * 0.02;
  vec3 sun = sunLight();
  float sh = sunShadow(wp, vec3(0.0, 1.0, 0.0), dist);
  // canals: murky green-brown; reservoirs: deep green-teal
  vec3 body = vKind > 2.5 ? srgbToLinear(vec3(0.17, 0.22, 0.16)) : srgbToLinear(vec3(0.07, 0.17, 0.17));
  vec3 Eamb = ambientCube(vec3(0.0, 1.0, 0.0));
  vec3 scatter = body * (sun * saturate(L.y) * sh * 0.5 + Eamb * 0.5) / PI;
  vec3 col = mix(scatter, refl, F) + sun * spec * sh;
  col = applyAerial(col, wp);
  fragColor = vec4(col, 1.0);
}
`;

export class Water {
  material: THREE.ShaderMaterial;
  group = new THREE.Group();
  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: U,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    });
  }
  create(geom: { position: Float32Array; kind: Uint8Array; index: Uint32Array }, ox: number, oy: number) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geom.position, 3));
    g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(geom.kind), 1));
    g.setIndex(new THREE.BufferAttribute(geom.index, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.material);
    m.position.set(ox, 0, -oy);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.renderOrder = -4;
    this.group.add(m);
    return m;
  }
}
