// Cascaded sun shadows (3 cascades in one depth atlas) + shared lighting helpers.
import { CLOUD_COMMON } from './clouds';

export const SHADOWS = /* glsl */ `
${CLOUD_COMMON}
uniform sampler2D tShadow;
uniform mat4 uShadowMatrix[3];
uniform vec4 uShadowSplits;     // cascade far distances
uniform vec3 uShadowTexel;      // 1/atlasWidth, 1/atlasHeight, unused
uniform float uShadowOn;
uniform float uShadowReversed;

float shadowTap(vec2 uv, float d) {
  float s = texture(tShadow, uv).r;
  return uShadowReversed > 0.5 ? step(s, d) : step(d, s);
}

float shadowPCF(int i, vec3 wp, float bias) {
  vec4 p = uShadowMatrix[i] * vec4(wp, 1.0);
  vec3 c = p.xyz / p.w;
  float d = uShadowReversed > 0.5 ? c.z : c.z * 0.5 + 0.5;
  d += uShadowReversed > 0.5 ? bias : -bias;
  vec2 uv = c.xy * 0.5 + 0.5;            // 0..1 within the cascade
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return -1.0;
  uv.x = (uv.x + float(i)) / 3.0;        // atlas column
  vec2 ts = uShadowTexel.xy;
  // 3x3 bilinear-weighted PCF (Castaño)
  vec2 f = fract(uv / ts - 0.5);
  vec2 base = (floor(uv / ts - 0.5) + 0.5) * ts;
  float sum = 0.0;
  for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) {
    float wx = x == -1 ? 1.0 - f.x : (x == 2 ? f.x : 1.0);
    float wy = y == -1 ? 1.0 - f.y : (y == 2 ? f.y : 1.0);
    sum += wx * wy * shadowTap(base + vec2(x, y) * ts, d);
  }
  return sum / 9.0;
}

float sunShadow(vec3 wp, vec3 N, float viewDist) {
  float cs = cloudShadow(wp);
  if (uShadowOn < 0.5) return cs;
  int i = viewDist < uShadowSplits.x ? 0 : (viewDist < uShadowSplits.y ? 1 : (viewDist < uShadowSplits.z ? 2 : 3));
  if (i > 2) return cs;
  float slope = 1.0 - saturate(dot(N, uSunDir));
  float bias = (0.00012 + 0.0006 * slope) * (i == 0 ? 1.0 : (i == 1 ? 2.2 : 5.0));
  vec3 off = N * (0.15 + 0.6 * float(i));
  float s = shadowPCF(i, wp + off, bias);
  if (s < 0.0) return cs;
  // fade the last cascade out
  float fade = i == 2 ? smoothstep(uShadowSplits.z * 0.85, uShadowSplits.z, viewDist) : 0.0;
  return mix(s, 1.0, fade) * cs;
}
`;

export const LIGHTING = /* glsl */ `
// GGX specular, Schlick fresnel
float D_GGX(float NoH, float a) { float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float V_SmithJointApprox(float NoV, float NoL, float a) {
  float gv = NoL * (NoV * (1.0 - a) + a);
  float gl = NoV * (NoL * (1.0 - a) + a);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 F_Schlick(vec3 f0, float VoH) { return f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0); }

// Energy-conserving-ish dielectric shading under sun + sky
vec3 shadeSurface(vec3 albedo, vec3 N, vec3 V, float rough, float f0s, float shadow, float ao, vec3 wp) {
  vec3 L = uSunDir;
  float NoL = saturate(dot(N, L));
  vec3 sun = sunLight();
  vec3 diffuse = albedo / PI * (sun * NoL * shadow) + albedo * ambientCube(N) / PI * ao;
  vec3 H = normalize(L + V);
  float NoV = max(dot(N, V), 1e-3);
  float NoH = saturate(dot(N, H));
  float a = max(rough * rough, 0.02);
  vec3 F = F_Schlick(vec3(f0s), saturate(dot(V, H)));
  vec3 spec = D_GGX(NoH, a) * V_SmithJointApprox(NoV, NoL, a) * F * sun * NoL * shadow;
  // moonlight (tiny, cool)
  vec3 moon = uMoonLight * saturate(dot(N, uMoonDir)) * albedo / PI;
  return diffuse * (1.0 - F * 0.0) + spec + moon;
}
`;
