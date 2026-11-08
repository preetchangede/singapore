import * as THREE from 'three';
import { COMMON } from '../shaders/common';
import { ATMO_PARAMS, ATMO_RUNTIME } from '../shaders/atmosphere';
import { U } from '../core/uniforms';

const VS = /* glsl */ `
out vec2 vNdc;
void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const SKY_FUNCS = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform float uMoonPhase;
vec3 viewRay(vec2 ndc) {
  vec4 v = uInvProj * vec4(ndc, 1.0, 1.0);
  v /= v.w;
  return normalize((uInvView * vec4(v.xyz, 0.0)).xyz);
}

vec3 starField(vec3 d) {
  // stars on a jittered spherical grid
  vec3 col = vec3(0.0);
  float lon = atan(d.z, d.x);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  for (int s = 0; s < 2; s++) {
    float sc = s == 0 ? 180.0 : 420.0;
    vec2 g = vec2(lon * sc / PI, lat * sc / PI);
    vec2 id = floor(g);
    vec2 f = fract(g);
    vec3 h = hash32(id + float(s) * 37.0);
    vec2 c = 0.2 + 0.6 * h.xy;
    float r = length(f - c);
    float mag = pow(h.z, s == 0 ? 18.0 : 40.0);
    float tw = 0.75 + 0.25 * sin(uTime * (2.0 + 6.0 * h.x) + h.y * 40.0);
    vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.7), h.y);
    col += tint * mag * tw * smoothstep(0.08, 0.0, r) * 3.0;
  }
  return col;
}

vec3 skyColour(vec3 d, bool withDisks) {
  vec3 L = skyRadiance(d);
  if (!withDisks) return L;
  // sun disk with limb darkening
  float cs = dot(d, uSunDir);
  float sunR = 0.00470;
  if (cs > cos(sunR * 1.6)) {
    float x = acos(clamp(cs, -1.0, 1.0)) / sunR;
    if (x < 1.0) {
      float mu = sqrt(max(0.0, 1.0 - x * x));
      vec3 limb = pow(vec3(mu), vec3(0.397, 0.503, 0.652));
      vec3 T = texture(tTransmittance, transmittanceUV(RG + uCamAltKm, d.y)).rgb;
      float horizon = smoothstep(-0.01, 0.002, d.y);
      L += T * limb * uSunIntensity / (PI * sunR * sunR) * 0.5 * horizon;
    }
  }
  // moon
  float cm = dot(d, uMoonDir);
  float moonR = 0.0047;
  if (cm > cos(moonR * 1.2) && uMoonDir.y > -0.02) {
    // local disk coordinates
    vec3 up = abs(uMoonDir.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    vec3 tx = normalize(cross(up, uMoonDir));
    vec3 ty = cross(uMoonDir, tx);
    vec2 p = vec2(dot(d, tx), dot(d, ty)) / moonR;
    float rr = dot(p, p);
    if (rr < 1.0) {
      vec3 n = normalize(tx * p.x + ty * p.y - uMoonDir * sqrt(1.0 - rr));
      // n is the outward normal on the hemisphere facing us; the sun lights it from uSunDir
      float lit = saturate(dot(n, uSunDir));
      float maria = 0.75 + 0.25 * fbm(p * 3.0 + 4.0);
      vec3 T = texture(tTransmittance, transmittanceUV(RG + uCamAltKm, d.y)).rgb;
      vec3 moonL = T * vec3(1.0, 0.96, 0.9) * (0.02 + lit) * maria * 0.12 * uSunIntensity * 0.06;
      L += moonL * smoothstep(1.0, 0.94, rr) * smoothstep(-0.02, 0.01, d.y);
    }
  }
  // stars (washed out by twilight and by Singapore's light pollution)
  float dark = saturate(1.0 - lum(L) * 4000.0 / max(uSunIntensity, 1e-3));
  L += starField(d) * dark * smoothstep(0.02, 0.25, d.y) * uSunIntensity * 0.00012;
  // urban skyglow near the horizon at night
  L += vec3(0.020, 0.011, 0.006) * uNight * uSunIntensity * 0.0035 * exp(-max(d.y, 0.0) * 9.0);
  return L;
}
`;

const FS = /* glsl */ `
in vec2 vNdc;
out vec4 fragColor;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${SKY_FUNCS}
void main() {
  vec3 d = viewRay(vNdc);
  vec3 L = skyColour(d, true);
  // below the horizon (rarely visible: ocean & terrain cover it) fade to haze
  fragColor = vec4(L, 1.0);
}
`;

export class Sky {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS,
      uniforms: { ...U, uInvProj: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() }, uMoonPhase: U.uMoonPhase },
      depthTest: false, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }
  update(camera: THREE.PerspectiveCamera) {
    this.material.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.material.uniforms.uInvView.value.copy(camera.matrixWorld);
  }
}
