// Physically based atmosphere after Hillaire 2020 ("A Scalable and Production Ready
// Sky and Atmosphere Rendering Technique"). Distances in kilometres inside the
// atmosphere functions. Tuned for Singapore: humid, Mie-heavy tropical haze.

export const ATMO_PARAMS = /* glsl */ `
#define RG 6360.0
#define RT 6460.0
uniform vec3 uRayleighScat;     // km^-1
uniform float uRayleighH;       // km
uniform vec3 uMieScat;
uniform vec3 uMieExt;
uniform float uMieH;
uniform float uMieG;
uniform vec3 uOzoneAbs;
uniform vec3 uGroundAlbedo;

struct Medium { vec3 scat; vec3 scatR; vec3 scatM; vec3 ext; };

Medium sampleMedium(float hKm) {
  hKm = max(hKm, 0.0);
  float dR = exp(-hKm / uRayleighH);
  float dM = exp(-hKm / uMieH);
  float dO = max(0.0, 1.0 - abs(hKm - 25.0) / 15.0);
  Medium m;
  m.scatR = uRayleighScat * dR;
  m.scatM = uMieScat * dM;
  m.scat = m.scatR + m.scatM;
  m.ext = m.scatR + uMieExt * dM + uOzoneAbs * dO;
  return m;
}

// nearest positive intersection of ray with sphere centred at origin, -1 if none
float raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d, t1 = -b + d;
  if (t0 > 0.0) return t0;
  if (t1 > 0.0) return t1;
  return -1.0;
}

float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float hgPhase(float g, float c) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
// Cornette-Shanks (better for haze)
float csPhase(float g, float c) {
  float k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5);
}

vec2 transmittanceUV(float viewHeight, float cosZ) {
  float H = sqrt(max(0.0, RT * RT - RG * RG));
  float rho = sqrt(max(0.0, viewHeight * viewHeight - RG * RG));
  float disc = viewHeight * viewHeight * (cosZ * cosZ - 1.0) + RT * RT;
  float d = max(0.0, -viewHeight * cosZ + sqrt(max(disc, 0.0)));
  float dmin = RT - viewHeight, dmax = rho + H;
  return vec2((d - dmin) / (dmax - dmin), rho / H);
}
void transmittanceParams(vec2 uv, out float viewHeight, out float cosZ) {
  float H = sqrt(RT * RT - RG * RG);
  float rho = H * uv.y;
  viewHeight = sqrt(rho * rho + RG * RG);
  float dmin = RT - viewHeight, dmax = rho + H;
  float d = dmin + uv.x * (dmax - dmin);
  cosZ = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * viewHeight * d);
  cosZ = clamp(cosZ, -1.0, 1.0);
}

float fromUnitToSubUv(float u, float res) { return (u + 0.5 / res) * (res / (res + 1.0)); }
float fromSubUvToUnit(float u, float res) { return (u - 0.5 / res) * (res / (res - 1.0)); }
`;

export const TRANSMITTANCE_FS = /* glsl */ `
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(256.0, 64.0);
  float h, cz;
  transmittanceParams(uv, h, cz);
  vec3 ro = vec3(0.0, h, 0.0);
  vec3 rd = vec3(sqrt(max(0.0, 1.0 - cz * cz)), cz, 0.0);
  float tMax = raySphere(ro, rd, RT);
  vec3 od = vec3(0.0);
  const int N = 48;
  float dt = tMax / float(N);
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5) * dt;
    float hh = length(ro + rd * t) - RG;
    od += sampleMedium(hh).ext * dt;
  }
  fragColor = vec4(exp(-od), 1.0);
}
`;

export const MULTISCAT_FS = /* glsl */ `
uniform sampler2D tTransmittance;
out vec4 fragColor;
vec3 integrateMS(vec3 ro, vec3 rd, vec3 sunDir, out vec3 fms) {
  fms = vec3(0.0);
  float tBottom = raySphere(ro, rd, RG);
  float tTop = raySphere(ro, rd, RT);
  float tMax = tBottom > 0.0 ? tBottom : tTop;
  if (tMax <= 0.0) return vec3(0.0);
  const int N = 20;
  float dt = tMax / float(N);
  vec3 L = vec3(0.0), thr = vec3(1.0);
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.3) * dt;
    vec3 P = ro + rd * t;
    float ph = length(P);
    vec3 up = P / ph;
    Medium m = sampleMedium(ph - RG);
    vec3 sT = exp(-m.ext * dt);
    float cz = dot(sunDir, up);
    vec3 Tsun = texture(tTransmittance, transmittanceUV(ph, cz)).rgb;
    float earth = raySphere(P, sunDir, RG) >= 0.0 ? 0.0 : 1.0;
    vec3 S = earth * Tsun * m.scat * (1.0 / (4.0 * PI));
    vec3 ext = max(m.ext, 1e-6);
    L += thr * (S - S * sT) / ext;
    fms += thr * (m.scat - m.scat * sT) / ext;
    thr *= sT;
  }
  if (tBottom > 0.0) {
    vec3 P = ro + rd * tBottom;
    vec3 up = normalize(P);
    float cz = dot(sunDir, up);
    vec3 Tsun = texture(tTransmittance, transmittanceUV(length(P), cz)).rgb;
    L += Tsun * thr * saturate(cz) * uGroundAlbedo / PI;
  }
  return L;
}
void main() {
  vec2 uv = gl_FragCoord.xy / 32.0;
  uv = vec2(fromSubUvToUnit(uv.x, 32.0), fromSubUvToUnit(uv.y, 32.0));
  float cz = uv.x * 2.0 - 1.0;
  vec3 sunDir = vec3(sqrt(saturate(1.0 - cz * cz)), cz, 0.0);
  float h = RG + saturate(uv.y + 0.01) * (RT - RG - 0.01);
  vec3 ro = vec3(0.0, h, 0.0);
  vec3 Lsum = vec3(0.0), Fsum = vec3(0.0);
  const int S = 8;
  for (int i = 0; i < S; i++) for (int j = 0; j < S; j++) {
    float a = (float(i) + 0.5) / float(S), b = (float(j) + 0.5) / float(S);
    float th = TAU * a, ph = acos(1.0 - 2.0 * b);
    vec3 rd = vec3(cos(th) * sin(ph), cos(ph), sin(th) * sin(ph));
    vec3 f;
    Lsum += integrateMS(ro, rd, sunDir, f);
    Fsum += f;
  }
  float inv = 1.0 / float(S * S);
  vec3 L2 = Lsum * inv;          // already includes isotropic phase
  vec3 fms = Fsum * inv;         // average over sphere * 4pi * (1/4pi)
  vec3 psi = L2 / max(1.0 - fms, 1e-3);
  fragColor = vec4(psi, 1.0);
}
`;

// Sky-view LUT (192 x 108) at the camera altitude.
export const SKYVIEW_FS = /* glsl */ `
uniform sampler2D tTransmittance;
uniform sampler2D tMultiScat;
uniform float uViewHeight;   // km from planet centre
uniform float uSunCosZ;      // cos of sun zenith angle at camera
uniform float uMoonCosZ;
uniform float uMoonLightViewCos; // unused placeholder (moon handled separately)
out vec4 fragColor;

vec3 msLookup(float h, float cz) {
  vec2 uv = vec2(cz * 0.5 + 0.5, (h - RG) / (RT - RG));
  uv = vec2(fromUnitToSubUv(uv.x, 32.0), fromUnitToSubUv(uv.y, 32.0));
  return texture(tMultiScat, uv).rgb;
}

void main() {
  vec2 uv = gl_FragCoord.xy / vec2(192.0, 108.0);
  uv = vec2(fromSubUvToUnit(uv.x, 192.0), fromSubUvToUnit(uv.y, 108.0));
  float vh = uViewHeight;
  float Vhor = sqrt(max(vh * vh - RG * RG, 0.0));
  float cosBeta = Vhor / vh;
  float beta = acos(cosBeta);
  float zha = PI - beta;
  float vza;
  if (uv.y < 0.5) {
    float c = 2.0 * uv.y; c = 1.0 - c; c *= c; c = 1.0 - c;
    vza = zha * c;
  } else {
    float c = uv.y * 2.0 - 1.0; c *= c;
    vza = zha + beta * c;
  }
  float cvz = cos(vza);
  float c = uv.x; c *= c;
  float lvc = -(c * 2.0 - 1.0);
  float svz = sqrt(max(0.0, 1.0 - cvz * cvz));
  // frame: y up, sun in the x-y plane
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - uSunCosZ * uSunCosZ)), uSunCosZ, 0.0);
  vec3 rd = vec3(svz * lvc, cvz, svz * sqrt(max(0.0, 1.0 - lvc * lvc)));
  vec3 ro = vec3(0.0, vh, 0.0);

  float tBottom = raySphere(ro, rd, RG);
  float tTop = raySphere(ro, rd, RT);
  float tMax = tBottom > 0.0 ? (tTop > 0.0 ? min(tTop, tBottom) : tBottom) : tTop;
  if (tMax <= 0.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  tMax = min(tMax, 9000.0);

  float spp = mix(14.0, 34.0, saturate(tMax * 0.01));
  float sppF = floor(spp);
  float tMaxF = tMax * sppF / spp;
  float cosT = dot(sunDir, rd);
  float phM = csPhase(uMieG, cosT);
  float phR = rayleighPhase(cosT);
  vec3 L = vec3(0.0), thr = vec3(1.0);
  for (float s = 0.0; s < 34.0; s += 1.0) {
    if (s >= spp) break;
    float t0 = s / sppF, t1 = (s + 1.0) / sppF;
    t0 = t0 * t0; t1 = t1 * t1;
    t0 = tMaxF * t0;
    t1 = t1 > 1.0 ? tMax : tMaxF * t1;
    float t = t0 + (t1 - t0) * 0.3;
    float dt = t1 - t0;
    vec3 P = ro + rd * t;
    float ph = length(P);
    vec3 up = P / ph;
    Medium m = sampleMedium(ph - RG);
    vec3 sT = exp(-m.ext * dt);
    float cz = dot(sunDir, up);
    vec3 Tsun = texture(tTransmittance, transmittanceUV(ph, cz)).rgb;
    float earth = raySphere(P, sunDir, RG) >= 0.0 ? 0.0 : 1.0;
    vec3 ms = msLookup(ph, cz);
    vec3 S = earth * Tsun * (m.scatM * phM + m.scatR * phR) + ms * m.scat;
    vec3 ext = max(m.ext, 1e-6);
    L += thr * (S - S * sT) / ext;
    thr *= sT;
  }
  fragColor = vec4(L, 1.0);
}
`;

// Runtime helpers for materials: sky radiance lookup, aerial perspective, sun light.
export const ATMO_RUNTIME = /* glsl */ `
uniform sampler2D tTransmittance;
uniform sampler2D tSkyView;
uniform sampler2D tAtmoParams;   // 8 x 1: ambient cube (0..5), sun illuminance at camera (6), sun at ground (7)
uniform vec3 uSunDir;            // world, y up
uniform vec3 uMoonDir;
uniform float uCamAltKm;
uniform float uSunIntensity;
uniform float uNight;            // 0 day .. 1 night
uniform float uHaze;             // extra low-altitude haze density multiplier
uniform vec3 uMoonLight;         // moon illuminance (linear)
uniform float uTime;
uniform vec2 uWind;
uniform float uDebug;

vec2 skyViewUV(vec3 dir) {
  float vh = RG + max(uCamAltKm, 0.001);
  float Vhor = sqrt(max(vh * vh - RG * RG, 0.0));
  float cosBeta = Vhor / vh;
  float beta = acos(cosBeta);
  float zha = PI - beta;
  float vza = acos(clamp(dir.y, -1.0, 1.0));
  vec2 uv;
  if (vza < zha) {
    float c = vza / zha; c = 1.0 - c; c = sqrt(max(c, 0.0)); c = 1.0 - c;
    uv.y = c * 0.5;
  } else {
    float c = (vza - zha) / beta; c = sqrt(max(c, 0.0));
    uv.y = c * 0.5 + 0.5;
  }
  vec2 dh = dir.xz;
  float l = length(dh);
  vec2 sh = uSunDir.xz;
  float ls = length(sh);
  float lvc = (l > 1e-5 && ls > 1e-5) ? dot(dh / l, sh / ls) : 1.0;
  uv.x = sqrt(max(-lvc * 0.5 + 0.5, 0.0));
  return vec2(fromUnitToSubUv(uv.x, 192.0), fromUnitToSubUv(uv.y, 108.0));
}

vec3 skyRadiance(vec3 dir) {
  return texture(tSkyView, skyViewUV(dir)).rgb * uSunIntensity;
}

vec3 ambientCube(vec3 n) {
  vec3 n2 = n * n;
  vec3 cx = n.x > 0.0 ? texelFetch(tAtmoParams, ivec2(0, 0), 0).rgb : texelFetch(tAtmoParams, ivec2(1, 0), 0).rgb;
  vec3 cy = n.y > 0.0 ? texelFetch(tAtmoParams, ivec2(2, 0), 0).rgb : texelFetch(tAtmoParams, ivec2(3, 0), 0).rgb;
  vec3 cz = n.z > 0.0 ? texelFetch(tAtmoParams, ivec2(4, 0), 0).rgb : texelFetch(tAtmoParams, ivec2(5, 0), 0).rgb;
  return n2.x * cx + n2.y * cy + n2.z * cz;
}

vec3 sunLight() { return texelFetch(tAtmoParams, ivec2(7, 0), 0).rgb; }   // at ground level
vec3 sunLightAt(float altM) {
  float h = RG + max(altM, 0.0) * 0.001;
  return texture(tTransmittance, transmittanceUV(h, uSunDir.y)).rgb * uSunIntensity
         * smoothstep(-0.02, 0.01, uSunDir.y);
}

// exponential-atmosphere optical depth along a straight segment from altitude h0 to h1 (km), length d (km)
float expDepth(float h0, float h1, float d, float H) {
  float dh = h1 - h0;
  float e0 = exp(-max(h0, 0.0) / H);
  if (abs(dh) < 1e-4) return d * e0;
  float e1 = exp(-max(h1, 0.0) / H);
  return d * H * (e0 - e1) / dh;
}

vec3 opticalDepth(float h0, float h1, float d) {
  return uRayleighScat * expDepth(h0, h1, d, uRayleighH)
       + uMieExt * expDepth(h0, h1, d, uMieH)
       + uMieExt * uHaze * expDepth(h0, h1, d, 0.35);     // humid boundary-layer haze
}

// Aerial perspective: transmittance + in-scattered light between camera and a world point.
vec3 applyAerial(vec3 color, vec3 wp) {
  if (uDebug > 0.5 && uDebug < 1.5) return color;
  vec3 v = wp - cameraPosition;
  float dm = length(v);
  if (dm < 1.0) return color;
  vec3 dir = v / dm;
  float d = dm * 0.001;
  float h0 = uCamAltKm;
  float h1 = max(wp.y, 0.0) * 0.001;
  vec3 T = exp(-opticalDepth(h0, h1, d));
  // transmittance to the end of the LUT ray (ground or space)
  float dEnd = dir.y < -0.001 ? min(h0 / -dir.y, 600.0) : 600.0;
  float hEnd = dir.y < -0.001 ? 0.0 : h0 + dir.y * dEnd;
  vec3 Tend = exp(-opticalDepth(h0, max(hEnd, 0.0), dEnd));
  vec3 Ldir = skyRadiance(dir);
  vec3 inscat = Ldir * (1.0 - T) / max(1.0 - Tend, vec3(1e-3));
  // night: urban sky glow lifts the haze with sodium/LED orange
  vec3 cityGlow = vec3(0.014, 0.011, 0.008) * uNight * (1.0 - exp(-d * 0.18));
  return color * T + inscat + cityGlow * uSunIntensity * 0.02;
}
`;

// Ambient cube + sun illuminance: 8x1 texture computed from the LUTs each frame.
export const ATMO_PARAMS_FS = /* glsl */ `
uniform sampler2D tTransmittance;
uniform sampler2D tSkyView;
uniform vec3 uSunDir;
uniform float uCamAltKm;
uniform float uSunIntensity;
uniform float uHaze;
uniform float uNight;
uniform vec3 uMoonDir;
uniform vec3 uMoonLight;
out vec4 fragColor;
${'' /* skyViewUV reused */}
vec2 skyViewUV2(vec3 dir) {
  float vh = RG + max(uCamAltKm, 0.001);
  float Vhor = sqrt(max(vh * vh - RG * RG, 0.0));
  float beta = acos(Vhor / vh);
  float zha = PI - beta;
  float vza = acos(clamp(dir.y, -1.0, 1.0));
  vec2 uv;
  if (vza < zha) { float c = vza / zha; c = 1.0 - c; c = sqrt(max(c, 0.0)); c = 1.0 - c; uv.y = c * 0.5; }
  else { float c = (vza - zha) / beta; c = sqrt(max(c, 0.0)); uv.y = c * 0.5 + 0.5; }
  vec2 dh = dir.xz; float l = length(dh);
  vec2 sh = uSunDir.xz; float ls = length(sh);
  float lvc = (l > 1e-5 && ls > 1e-5) ? dot(dh / l, sh / ls) : 1.0;
  uv.x = sqrt(max(-lvc * 0.5 + 0.5, 0.0));
  return vec2(fromUnitToSubUv(uv.x, 192.0), fromUnitToSubUv(uv.y, 108.0));
}
void main() {
  int i = int(gl_FragCoord.x);
  if (i >= 6) {
    float alt = i == 6 ? uCamAltKm : 0.0;
    vec3 T = texture(tTransmittance, transmittanceUV(RG + alt, uSunDir.y)).rgb;
    float vis = smoothstep(-0.015, 0.012, uSunDir.y);
    fragColor = vec4(T * uSunIntensity * vis + uMoonLight * smoothstep(-0.05, 0.1, uMoonDir.y), 1.0);
    return;
  }
  vec3 n = i == 0 ? vec3(1, 0, 0) : i == 1 ? vec3(-1, 0, 0) : i == 2 ? vec3(0, 1, 0) : i == 3 ? vec3(0, -1, 0) : i == 4 ? vec3(0, 0, 1) : vec3(0, 0, -1);
  vec3 E = vec3(0.0);
  const int A = 24, B = 12;
  float wsum = 0.0;
  for (int a = 0; a < A; a++) for (int b = 0; b < B; b++) {
    float phi = (float(a) + 0.5) / float(A) * TAU;
    float cth = 1.0 - (float(b) + 0.5) / float(B);   // hemisphere around +y, then rotate
    float sth = sqrt(1.0 - cth * cth);
    vec3 d = vec3(cos(phi) * sth, cth, sin(phi) * sth);
    // build hemisphere around n
    vec3 t = abs(n.y) < 0.99 ? normalize(cross(n, vec3(0, 1, 0))) : vec3(1, 0, 0);
    vec3 bt = cross(n, t);
    vec3 w = normalize(t * d.x + n * d.y + bt * d.z);
    vec3 L;
    if (w.y > -0.02) {
      L = texture(tSkyView, skyViewUV2(w)).rgb * uSunIntensity;
    } else {
      // ground bounce: lit ground seen from above + inscatter below the horizon
      vec3 Tg = texture(tTransmittance, transmittanceUV(RG, uSunDir.y)).rgb;
      vec3 Eg = Tg * uSunIntensity * saturate(uSunDir.y) + texture(tSkyView, skyViewUV2(vec3(0.0, 1.0, 0.0))).rgb * uSunIntensity * PI * 0.5;
      L = Eg * vec3(0.16, 0.17, 0.15) / PI + texture(tSkyView, skyViewUV2(w)).rgb * uSunIntensity;
    }
    E += L * cth;
    wsum += cth;
  }
  E *= PI / wsum;            // cosine-weighted hemisphere integral
  // moonlit sky + city skyglow ambient at night
  E += uMoonLight * 0.12 * (n.y * 0.5 + 0.5);
  E += vec3(0.00045, 0.00038, 0.00032) * uNight * uSunIntensity * (0.6 + 0.4 * (-n.y * 0.5 + 0.5));
  fragColor = vec4(E, 1.0);
}
`;
