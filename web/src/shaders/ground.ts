// Ground material: composes the far-field colour, the whole-island overview albedo,
// the live ground clipmap (vector data rendered around the camera), canopy relief and
// procedural micro-detail.
export const GROUND_FS = /* glsl */ `
uniform sampler2D tOverview;
uniform sampler2D tCanopy;
uniform sampler2D tNightLights;
uniform sampler2D tClip0;
uniform sampler2D tClip1;
uniform sampler2D tClip2;
uniform sampler2D tClipM0;
uniform sampler2D tClipM1;
uniform sampler2D tClipM2;
uniform vec4 uClipRect[3];        // centre x, centre z, half size, active
uniform float uTreeRange;         // distance up to which 3D trees are drawn

struct GroundSample {
  vec3 albedo;
  vec3 normal;
  float rough;
  float ao;
  float canopyShadow;
  vec3 emissive;
  float water;
};

vec3 farFieldColour(vec2 xz, float h) {
  // beyond the mapped domain: Johor / Riau / Sumatra hinterland
  float n = fbm(xz * 0.0004);
  float n2 = vnoise(xz * 0.004);
  vec3 forest = srgbToLinear(vec3(0.21, 0.30, 0.17));
  vec3 plantation = srgbToLinear(vec3(0.33, 0.39, 0.22));
  vec3 urban = srgbToLinear(vec3(0.52, 0.50, 0.46));
  vec3 c = mix(forest, plantation, smoothstep(0.35, 0.65, n));
  c = mix(c, urban, smoothstep(0.72, 0.9, n2) * smoothstep(40.0, 5.0, h) * 0.6);
  return c;
}

// canopy height (m) from the 16 m canopy raster
float canopyAt(vec2 xz) { return texture(tCanopy, nearUV(xz)).r * 63.75; }

vec4 clipSample(int i, vec2 xz, out vec4 mat, out float w) {
  vec4 r = uClipRect[i];
  vec2 uv = (xz - r.xy) / (2.0 * r.z) + 0.5;
  vec2 e = abs(uv - 0.5) * 2.0;
  float m = max(e.x, e.y);
  w = r.w * (1.0 - smoothstep(0.82, 0.97, m));
  uv.y = uv.y;
  if (i == 0) { mat = texture(tClipM0, uv); return texture(tClip0, uv); }
  if (i == 1) { mat = texture(tClipM1, uv); return texture(tClip1, uv); }
  mat = texture(tClipM2, uv); return texture(tClip2, uv);
}

GroundSample sampleGround(vec3 wp, float dist, vec3 N) {
  GroundSample g;
  vec2 xz = wp.xz;
  float edge = max(abs(xz.x), abs(xz.y)) / uDomainHalf;
  vec3 ov = texture(tOverview, nearUV(xz)).rgb;
  vec3 alb = mix(ov, farFieldColour(xz, wp.y), smoothstep(0.985, 1.0, edge));
  float rough = 0.95;
  float streetLight = 0.0;
  float water = 0.0;
  // live clipmap: finest level wins
  vec4 m0, m1, m2; float w0, w1, w2;
  vec4 c2 = clipSample(2, xz, m2, w2);
  vec4 c1 = clipSample(1, xz, m1, w1);
  vec4 c0 = clipSample(0, xz, m0, w0);
  vec4 cm = vec4(0.0); float cw = 0.0;
  if (w2 > 0.0) { cm = mix(cm, c2, w2); cw = max(cw, w2); }
  vec4 mm = mix(vec4(0.9, 0.0, 0.0, 0.0), m2, w2);
  if (w1 > 0.0) { cm = mix(cm, c1, w1); mm = mix(mm, m1, w1); cw = max(cw, w1); }
  if (w0 > 0.0) { cm = mix(cm, c0, w0); mm = mix(mm, m0, w0); cw = max(cw, w0); }
  // clipmap alpha holds coverage (0 where no vector data was drawn)
  float cov = cw * cm.a;
  alb = mix(alb, cm.rgb, cov);
  rough = mix(rough, mm.r, cov);
  streetLight = mm.g * cov;
  water = mm.b * cov;

  // canopy relief for distant forests (where 3D trees are not drawn)
  float farTrees = smoothstep(uTreeRange * 0.75, uTreeRange, dist);
  float can = canopyAt(xz);
  float canopyShadow = 1.0;
  vec3 n = N;
  if (can > 2.5 && edge < 1.0) {
    float k = 16.0;
    float cx = canopyAt(xz + vec2(k, 0.0)) - canopyAt(xz - vec2(k, 0.0));
    float cz = canopyAt(xz + vec2(0.0, k)) - canopyAt(xz - vec2(0.0, k));
    float crowns = vnoise(xz * 0.16) * 0.6 + vnoise(xz * 0.41) * 0.4;
    vec3 cn = normalize(vec3(-cx * 0.35 - (crowns - 0.5) * 0.9, 2.0 * k * 0.25, -cz * 0.35));
    float wgt = farTrees * smoothstep(2.5, 8.0, can);
    n = normalize(mix(n, cn, wgt * 0.85));
    canopyShadow = mix(1.0, 0.72 + 0.28 * crowns, wgt);
    vec3 leaf = srgbToLinear(vec3(0.20, 0.30, 0.15)) * (0.75 + 0.5 * crowns);
    alb = mix(alb, leaf, wgt * 0.55 * (1.0 - cov * 0.4));
  }

  // micro detail: soft large-scale variation + fine grain that fades with distance
  float lf = fbm(xz * 0.0035) - 0.5;
  alb *= 1.0 + lf * 0.18;
  float fine = (vnoise(xz * 1.7) - 0.5) * smoothstep(400.0, 30.0, dist);
  alb *= 1.0 + fine * 0.12 * (1.0 - water);
  g.albedo = max(alb, 0.0);
  g.normal = n;
  g.rough = rough;
  g.ao = mix(1.0, 0.8, smoothstep(2.0, 20.0, can) * farTrees);
  g.canopyShadow = canopyShadow;
  g.water = water;
  // night: street lighting pools (clipmap) + city glow (precomputed light map, far)
  float lights = texture(tNightLights, nearUV(xz)).r;
  float pools = streetLight * (0.65 + 0.35 * vnoise(xz * 0.12));
  float farGlow = lights * (1.0 - cov) * (edge < 1.0 ? 1.0 : 0.0);
  vec3 sodium = blackbody(3200.0);
  vec3 led = blackbody(4300.0);
  vec3 lc = mix(sodium, led, 0.55 + 0.25 * vnoise(xz * 0.002));
  g.emissive = lc * (pools * 0.045 + farGlow * 0.06) * uNight * uSunIntensity * 0.06;
  return g;
}
`;
