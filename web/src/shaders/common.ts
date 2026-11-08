// Shared GLSL chunks. Everything is GLSL ES 3.00 (three.js GLSL3 ShaderMaterials).

export const COMMON = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718
#define EARTH_R 6360000.0

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
float sq(float x) { return x * x; }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// ---- hashes (Dave Hoskins, hash without sine) ----
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

// ---- value noise / fbm ----
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1, 0)), c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// gradient noise with analytic derivatives (Inigo Quilez)
vec3 gnoised(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = hash22(i + vec2(0, 0)) * 2.0 - 1.0;
  vec2 gb = hash22(i + vec2(1, 0)) * 2.0 - 1.0;
  vec2 gc = hash22(i + vec2(0, 1)) * 2.0 - 1.0;
  vec2 gd = hash22(i + vec2(1, 1)) * 2.0 - 1.0;
  float va = dot(ga, f - vec2(0, 0)), vb = dot(gb, f - vec2(1, 0));
  float vc = dot(gc, f - vec2(0, 1)), vd = dot(gd, f - vec2(1, 1));
  return vec3(va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd),
              ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) +
              du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va));
}

// Interleaved gradient noise for dithering
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec3 blackbody(float t) {
  // approximate sRGB->linear colour of a black body at temperature t (K)
  t = clamp(t, 1000.0, 15000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : saturate(1.292936 * pow(t - 60.0, -0.1332047));
  c.g = t <= 66.0 ? saturate(0.3900816 * log(t) - 0.6318414) : saturate(1.1298909 * pow(t - 60.0, -0.0755148));
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : saturate(0.5432068 * log(t - 10.0) - 1.1962541));
  return srgbToLinear(c);
}
`;

// Earth curvature: drop vertices with squared horizontal distance from the camera.
export const CURVATURE = /* glsl */ `
vec3 applyCurvature(vec3 wp) {
  vec2 d = wp.xz - cameraPosition.xz;
  wp.y -= dot(d, d) / (2.0 * 6371000.0);
  return wp;
}
`;
