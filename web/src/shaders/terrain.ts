// Shared terrain sampling + ground material.
export const TERRAIN_SAMPLE = /* glsl */ `
uniform sampler2D tHeightNear;
uniform sampler2D tHeightFar;
uniform sampler2D tCoast;
uniform float uDomainHalf;
uniform float uFarHalf;
uniform float uCoastMaxD;

vec2 nearUV(vec2 xz) { return (xz + uDomainHalf) / (2.0 * uDomainHalf); }
vec2 farUV(vec2 xz) { return (xz + uFarHalf) / (2.0 * uFarHalf); }

float terrainHeight(vec2 xz) {
  float edge = max(abs(xz.x), abs(xz.y)) / uDomainHalf;
  float hF = texture(tHeightFar, farUV(xz)).r;
  if (edge >= 1.0) return hF;
  float hN = texture(tHeightNear, nearUV(xz)).r;
  return mix(hN, hF, smoothstep(0.97, 1.0, edge));
}

// signed distance to coast in metres (+ land, - sea); far field falls back to height
float coastDist(vec2 xz) {
  float edge = max(abs(xz.x), abs(xz.y)) / uDomainHalf;
  if (edge >= 0.999) {
    float h = texture(tHeightFar, farUV(xz)).r;
    return h > 0.3 ? 200.0 : -200.0;
  }
  float v = texture(tCoast, nearUV(xz)).r * 255.0;
  float s = (v - 128.0) / 127.0;
  return sign(s) * s * s * uCoastMaxD;
}
`;
