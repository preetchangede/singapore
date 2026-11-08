import { COMMON, CURVATURE } from './common';
import { ATMO_PARAMS, ATMO_RUNTIME } from './atmosphere';
import { SHADOWS, LIGHTING } from './lighting';

export const BUILDING_VS = /* glsl */ `
in vec4 aNormal;
in vec2 aFacade;
in vec4 aColor;
in vec4 aInfo;
#ifdef OVERVIEW
in float aTile;
uniform int uHideMask;
#endif
out vec3 vWorld;
out vec3 vNormal;
out vec2 vFacade;
out vec4 vColor;
flat out vec4 vInfo;
${CURVATURE}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
#ifdef OVERVIEW
  int t = int(aTile + 0.5);
  if (((uHideMask >> t) & 1) == 1) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  vWorld = wp.xyz;
  vNormal = normalize(aNormal.xyz);
  vFacade = aFacade;
  vColor = aColor;
  vInfo = aInfo;
  gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(wp.xyz), 1.0);
}
`;

export const BUILDING_FS = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
in vec2 vFacade;
in vec4 vColor;
flat in vec4 vInfo;
out vec4 fragColor;
uniform float uHour;
uniform float uHighlight;
uniform float uHighlightId;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${SHADOWS}
${LIGHTING}

float aaBox(float x, float a, float b, float w) {
  return clamp((x - a) / w + 0.5, 0.0, 1.0) - clamp((x - b) / w + 0.5, 0.0, 1.0);
}
float aaStep(float e, float x, float w) { return clamp((x - e) / w + 0.5, 0.0, 1.0); }

vec3 accentColour(float s) {
  int i = int(s * 7.0);
  vec3 c = i == 0 ? vec3(0.62, 0.30, 0.24) : i == 1 ? vec3(0.22, 0.47, 0.46) : i == 2 ? vec3(0.45, 0.55, 0.38)
         : i == 3 ? vec3(0.36, 0.52, 0.66) : i == 4 ? vec3(0.78, 0.62, 0.30) : i == 5 ? vec3(0.70, 0.45, 0.48) : vec3(0.48, 0.24, 0.26);
  return srgbToLinear(c);
}

// window light colour: warm / neutral / cool, as seen in HDB estates at night
vec3 roomLight(float h) {
  return h < 0.38 ? blackbody(2900.0) : (h < 0.62 ? blackbody(4000.0) : blackbody(6000.0));
}

struct Facade { vec3 albedo; float rough; float f0; vec3 emissive; float ao; float glassMask; };

Facade facade(int cls, vec3 wall, bool glassy, float u, float v, float storey, float seed, vec3 N, vec3 wp, float px) {
  Facade f;
  f.albedo = wall; f.rough = 0.85; f.f0 = 0.04; f.emissive = vec3(0.0); f.ao = 1.0; f.glassMask = 0.0;
  if (v >= 97.5) return f;              // rooftop plant & gable walls: plain
  float fl = floor(v / storey);
  float fv = fract(v / storey);
  float wv = fwidth(v / storey) * 1.2 + 1e-4;
  float night = uNight;
  // side-dependent hash (which face of the building)
  float side = floor((atan(N.z, N.x) / PI + 1.0) * 2.0 + 0.5);
  float cellW = 3.2, winW = 0.42, winB = 0.30, winT = 0.75, litP = 0.5;
  vec3 glassCol = srgbToLinear(vec3(0.16, 0.20, 0.23));
  bool ground = v < storey * 1.05;
  if (cls == 3) { cellW = 3.3; winW = 0.38; winB = 0.32; winT = 0.78; litP = 0.62; }
  else if (cls == 4 || cls == 11) { cellW = 3.8; winW = 0.62; winB = 0.12; winT = 0.86; litP = 0.5; }
  else if (cls == 5) { cellW = glassy ? 1.5 : 3.0; winW = glassy ? 0.94 : 0.55; winB = glassy ? 0.0 : 0.25; winT = glassy ? 0.84 : 0.8; litP = 0.62; }
  else if (cls == 1 || cls == 2) { cellW = 3.6; winW = 0.36; winB = 0.3; winT = 0.78; litP = 0.45; }
  else if (cls == 13) { cellW = 2.3; winW = 0.46; winB = 0.12; winT = 0.86; litP = 0.5; }
  else if (cls == 8 || cls == 10 || cls == 20) { cellW = 3.6; winW = 0.58; winB = 0.32; winT = 0.78; litP = cls == 20 ? 0.12 : 0.35; }
  else if (cls == 6) { cellW = 6.0; winW = 0.2; winB = 0.4; winT = 0.6; litP = 0.4; }
  else if (cls == 7 || cls == 21) { cellW = 6.0; winW = 0.5; winB = 0.72; winT = 0.9; litP = 0.12; }
  else if (cls == 15 || cls == 18) { cellW = 2.0; winW = 0.9; winB = 0.05; winT = 0.95; litP = 0.7; }
  else if (cls == 0) { cellW = 3.2; winW = 0.5; winB = 0.28; winT = 0.78; litP = 0.4; }
  float cu = u / cellW;
  float cellX = floor(cu);
  float fu = fract(cu);
  float wu = fwidth(cu) * 1.2 + 1e-4;
  // detail filter: fade window patterns when a cell spans few pixels
  float detail = smoothstep(cellW * 0.33, cellW * 0.12, px);
  float rnd = hash13(vec3(cellX, fl, seed * 977.0 + side * 13.0));
  float rnd2 = hash13(vec3(fl, seed * 311.0, side));

  float win = 0.0;
  float glassArea = winW * (winT - winB);
  // --- class-specific structure
  if (cls == 14) {
    // open canopy / covered walkway: columns + edge beam; discard the rest
    float col = aaBox(fract(u / 5.0), 0.0, 0.08, fwidth(u / 5.0));
    float beam = aaStep(storey * 0.75, v, fwidth(v));
    if (col + beam < 0.5) discard;
    f.albedo = wall * 0.9;
    return f;
  }
  if (cls == 12) {
    // multi-storey car park: parapet + open slot per floor
    float slot = aaBox(fv, 0.42, 0.92, wv);
    f.albedo = mix(wall, srgbToLinear(vec3(0.05)), slot * 0.9 * detail + slot * 0.6 * (1.0 - detail));
    f.emissive = blackbody(5600.0) * slot * 0.5 * (0.8 + 0.2 * rnd2);
    f.ao = 1.0 - slot * 0.3;
    return f;
  }
  if (cls == 17) {
    // construction: concrete frame wrapped in green safety netting
    float net = step(0.45, fract(seed * 7.13));
    float slab = aaBox(fv, 0.0, 0.12, wv);
    vec3 netC = srgbToLinear(vec3(0.20, 0.36, 0.26));
    vec3 open = srgbToLinear(vec3(0.07, 0.07, 0.07));
    f.albedo = net > 0.5 ? mix(netC, netC * 1.2, vnoise(vec2(u, v) * 0.7)) : mix(open, srgbToLinear(vec3(0.62, 0.6, 0.56)), slab);
    return f;
  }
  if (cls == 16) {
    float weld = aaBox(fract(v / 2.5), 0.0, 0.03, fwidth(v / 2.5));
    f.albedo = wall * (1.0 - weld * 0.15 * detail);
    f.rough = 0.4; f.f0 = 0.05;
    return f;
  }
  if (cls == 7 || cls == 21) {
    // corrugated cladding + clerestory band + roller shutters
    float rib = 0.5 + 0.5 * sin(u * TAU / 0.25);
    float ribF = smoothstep(0.6, 0.05, fwidth(u / 0.25));
    f.albedo = wall * (1.0 - 0.06 * rib * ribF);
    vec2 dc = vec2(fract(u / 9.0), v);
    float door = aaBox(dc.x, 0.25, 0.75, fwidth(u / 9.0)) * aaStep(v, 4.6, fwidth(v)) * step(0.45, hash12(vec2(floor(u / 9.0), seed * 50.0)));
    f.albedo = mix(f.albedo, srgbToLinear(vec3(0.42, 0.44, 0.45)), door * 0.8);
    float hiwin = aaBox(fv, winB, winT, wv) * aaBox(fu, 0.5 - winW / 2.0, 0.5 + winW / 2.0, wu) * step(storey * 0.5, v);
    win = hiwin;
    f.ao = mix(0.75, 1.0, smoothstep(0.0, 2.5, v));
  } else {
    float wx = aaBox(fu, 0.5 - winW / 2.0, 0.5 + winW / 2.0, wu);
    float wy = aaBox(fv, winB, winT, wv);
    win = wx * wy;
    // irregularity: some cells blank on houses/civic
    if (cls == 1 || cls == 2 || cls == 9) win *= step(0.25, rnd);
    if (cls == 9) win *= 0.6;
    // ground floor treatments
    if (ground) {
      if (cls == 3) {
        // HDB void deck: open ground floor with columns
        float colm = aaBox(fract(u / 6.5), 0.0, 0.1, fwidth(u / 6.5));
        vec3 deck = srgbToLinear(vec3(0.10, 0.10, 0.095));
        f.albedo = mix(deck, wall, colm);
        f.emissive = blackbody(5200.0) * (1.0 - colm) * 0.35;
        win = 0.0;
        glassArea = 0.0;
      } else if (cls == 13) {
        // shophouse five-foot way: arcade openings between pilasters
        float pil = aaBox(fract(u / 5.2), 0.0, 0.12, fwidth(u / 5.2));
        float arch = aaStep(v, storey * 0.82, wv * storey);
        vec3 shade = srgbToLinear(vec3(0.09, 0.08, 0.07));
        f.albedo = mix(wall, shade, (1.0 - pil) * arch);
        f.emissive = blackbody(3000.0) * (1.0 - pil) * arch * 0.9 * step(0.35, rnd2);
        win = 0.0;
      } else if (cls == 6 || cls == 5 || cls == 11 || cls == 4 || cls == 0 || cls == 15) {
        // shopfronts / lobbies
        float front = aaBox(fv, 0.05, 0.85, wv) * step(0.25, hash12(vec2(floor(u / 8.0), seed * 9.0)));
        win = max(win, front);
        glassArea = max(glassArea, 0.6);
      }
    }
    // HDB: corridor face with parapets and corridor lighting; accent colours
    if (cls == 3 && !ground) {
      float corrSide = step(0.5, fract(seed * 3.7 + side * 0.25));
      float parapet = aaBox(fv, 0.0, 0.42, wv);
      float recess = aaBox(fv, 0.42, 0.97, wv);
      if (corrSide > 0.5) {
        vec3 dark = srgbToLinear(vec3(0.12, 0.12, 0.12));
        f.albedo = mix(wall, dark, recess * 0.85);
        win = 0.0;
        // fluorescent corridor tubes along the ceiling
        float tube = aaBox(fv, 0.86, 0.93, wv);
        f.emissive = blackbody(6200.0) * (tube * 2.2 + recess * 0.25);
      }
      // estate accent: top two floors or vertical stair-core strips
      float accentMode = fract(seed * 5.31);
      vec3 acc = accentColour(fract(seed * 13.7));
      float strip = aaBox(fract(u / 26.0), 0.0, 0.11, fwidth(u / 26.0));
      if (accentMode < 0.5) f.albedo = mix(f.albedo, acc * 0.95, strip * (1.0 - win));
      else {
        // coloured window surrounds
        float surround = aaBox(fu, 0.5 - winW / 2.0 - 0.06, 0.5 + winW / 2.0 + 0.06, wu) * aaBox(fv, winB - 0.08, winT + 0.06, wv);
        f.albedo = mix(f.albedo, acc, surround * 0.55);
      }
      // floor slab ledges / air-con ledges
      float ledge = aaBox(fv, 0.0, 0.06, wv);
      f.albedo *= 1.0 - ledge * 0.25 * detail;
    }
    if (cls == 4 || cls == 11) {
      // balconies with glass railings
      float slab = aaBox(fv, 0.0, 0.08, wv);
      float rail = aaBox(fv, 0.08, 0.38, wv) * step(0.35, fract(seed * 4.3 + side * 0.31));
      f.albedo = mix(f.albedo, f.albedo * 0.82, slab);
      f.albedo = mix(f.albedo, srgbToLinear(vec3(0.32, 0.38, 0.40)), rail * 0.55);
    }
    if (cls == 13 && !ground) {
      // shophouse: tall shuttered windows + cornice
      float cornice = aaBox(fv, 0.9, 1.0, wv);
      f.albedo = mix(f.albedo, vec3(0.92, 0.9, 0.86) * 0.8, cornice * 0.8);
      vec3 shutter = srgbToLinear(fract(seed * 7.7) < 0.33 ? vec3(0.22, 0.42, 0.33) : (fract(seed * 7.7) < 0.66 ? vec3(0.30, 0.38, 0.52) : vec3(0.45, 0.30, 0.20)));
      float sh = win * (step(0.5, rnd) * 0.8);
      f.albedo = mix(f.albedo, shutter, sh);
      win *= 1.0 - step(0.5, rnd) * 0.8;
    }
    if (cls == 5 && glassy) {
      // curtain wall: mullions + spandrels; everything else is glass
      float mull = 1.0 - aaBox(fu, 0.02, 0.98, wu);
      float spand = 1.0 - aaBox(fv, 0.16, 0.98, wv);
      win = (1.0 - mull) * (1.0 - spand);
      vec3 frame = srgbToLinear(vec3(0.55, 0.57, 0.58));
      f.albedo = mix(wall * 0.55, frame, mull * 0.7);
      f.albedo = mix(f.albedo, wall * 0.9, spand);
    }
  }
  // --- glass / windows
  float w = win * detail;
  vec3 gl = mix(glassCol, wall * 0.25, 0.25);
  if (glassy && cls != 3) gl = mix(wall * 0.45, glassCol, 0.4);
  f.albedo = mix(f.albedo, gl, w);
  f.albedo = mix(f.albedo, mix(f.albedo, gl, glassArea * 0.9), (1.0 - detail) * (glassy ? 0.9 : 0.55));
  f.rough = mix(f.rough, 0.06, w + (1.0 - detail) * glassArea * (glassy ? 0.9 : 0.3));
  f.f0 = mix(f.f0, glassy ? 0.07 : 0.05, w + (1.0 - detail) * glassArea * 0.5);
  f.glassMask = max(w, (1.0 - detail) * glassArea * (glassy ? 1.0 : 0.4));
  // --- night: lit rooms
  if (night > 0.001 && cls != 14) {
    // fewer lights late at night
    float pl = litP * mix(1.0, 0.45, smoothstep(23.0, 26.0, uHour < 12.0 ? uHour + 24.0 : uHour));
    float lit = step(rnd, pl);
    vec3 lc = roomLight(fract(rnd * 17.3 + seed));
    float inten = 0.55 + 0.45 * fract(rnd * 31.7);
    // interior gradient: brighter near the ceiling
    float grad = 0.65 + 0.35 * smoothstep(winB, winT, fv);
    vec3 e = lc * lit * inten * grad;
    float avgLit = pl * 0.8;
    vec3 eFar = roomLight(fract(seed * 3.1)) * avgLit * glassArea;
    f.emissive += mix(eFar, e * win, detail);
  }
  return f;
}

void main() {
  int cls = int(vInfo.x + 0.5);
  float storey = max(vInfo.y / 20.0, 2.0);
  float seed = vInfo.z / 255.0;
  vec3 N = normalize(vNormal);
  vec3 wp = vWorld;
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  int matf = int(vColor.a * 255.0 + 0.5);
  bool glassy = (matf & 1) != 0;
  bool greenRoof = (matf & 2) != 0;
  bool isRoof = (matf & 4) != 0;
  vec3 base = srgbToLinear(vColor.rgb);
  float px = max(fwidth(vFacade.x), fwidth(vFacade.y));
  vec3 albedo = base;
  float rough = 0.85, f0 = 0.04, ao = 1.0, glassMask = 0.0;
  vec3 emissive = vec3(0.0);
  if (cls == 250) {
    // bridges / viaducts: weathered concrete, asphalt deck
    float stain = fbm(wp.xz * 0.15 + wp.y * 0.3);
    albedo = base * (0.88 + 0.2 * stain);
    rough = 0.9;
  } else if (isRoof && N.y > 0.2) {
    if (N.y < 0.97) {
      // pitched clay-tile roof: courses along the contour
      vec2 d = normalize(N.xz + 1e-5);
      float s = dot(wp.xz, d) / 0.34;
      float course = 0.5 + 0.5 * sin(s * TAU);
      float f = smoothstep(0.5, 0.08, fwidth(s));
      albedo = base * (0.86 + 0.14 * course * f) * (0.92 + 0.16 * vnoise(wp.xz * 0.7));
      rough = 0.7;
    } else if (greenRoof) {
      float g = fbm(wp.xz * 0.6);
      albedo = mix(srgbToLinear(vec3(0.22, 0.32, 0.16)), srgbToLinear(vec3(0.42, 0.48, 0.30)), g);
      rough = 0.95;
    } else {
      float n = fbm(wp.xz * 0.25);
      albedo = base * (0.84 + 0.26 * n);
      rough = 0.8;
    }
  } else {
    Facade f = facade(cls, base, glassy, vFacade.x, vFacade.y, storey, seed, N, wp, px);
    albedo = f.albedo; rough = f.rough; f0 = f.f0; emissive = f.emissive; ao = f.ao; glassMask = f.glassMask;
    // ground contact darkening
    ao *= mix(0.62, 1.0, smoothstep(0.0, 3.5, vFacade.y));
  }
  float sh = sunShadow(wp, N, dist);
  vec3 col = shadeSurface(albedo, N, V, rough, f0, sh, ao, wp);
  // glass: reflect the sky (and darker "city" below the horizon)
  if (glassMask > 0.01) {
    vec3 R = reflect(-V, N);
    vec3 env = skyRadiance(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
    float below = smoothstep(0.05, -0.15, R.y);
    env = mix(env, ambientCube(vec3(0.0, 1.0, 0.0)) * 0.05, below * 0.8);
    float NoV = max(dot(N, V), 1e-3);
    float F = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0);
    col += env * F * glassMask * 1.6;
  }
  col += emissive * uNight * uSunIntensity * 0.0011;
  if (uHighlight > 0.5) col += vec3(0.02, 0.05, 0.08) * uSunIntensity * 0.02;
  col = applyAerial(col, wp);
  fragColor = vec4(col, 1.0);
}
`;

export const BUILDING_PREFIX = { COMMON, ATMO_PARAMS, ATMO_RUNTIME, SHADOWS, LIGHTING };
