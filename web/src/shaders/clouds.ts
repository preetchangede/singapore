// Cloud weather map shared by the cloud raymarcher and every material that receives cloud shadows.
export const CLOUD_COMMON = /* glsl */ `
uniform float uCloudCover;
uniform vec2 uCloudWind;
#define CLOUD_BASE 900.0
#define CLOUD_TOP 2600.0
// weather map: where cumulus can form (procedural, drifting with the wind)
float cloudCoverage(vec2 xz) {
  vec2 p = (xz + uCloudWind) / 7000.0;
  float n = fbm(p) * 0.7 + fbm(p * 3.1 + 7.0) * 0.3;
  return saturate((n - (1.0 - uCloudCover) * 0.75) * 2.6);
}
// shadow of the cloud deck on a world point
float cloudShadow(vec3 wp) {
  if (uCloudCover < 0.01) return 1.0;
  vec3 L = uSunDir;
  float t = (1500.0 - wp.y) / max(L.y, 0.08);
  vec2 q = wp.xz + L.xz * t;
  float c = cloudCoverage(q);
  return 1.0 - smoothstep(0.15, 0.75, c) * 0.62 * smoothstep(0.0, 0.08, L.y);
}
`;
