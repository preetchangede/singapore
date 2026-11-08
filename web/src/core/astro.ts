// Low-precision solar and lunar ephemerides (±0.5° sun, ±1-2° moon) — plenty for lighting.
// World frame: x = east, y = up, z = south (three.js: -z is north).

const D2R = Math.PI / 180;
export const SG_LAT = 1.3521;
export const SG_LON = 103.8198;
export const SG_TZ = 8; // SGT, UTC+8, no DST

function julian(date: Date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function altAz(raDeg: number, decDeg: number, jd: number, lat: number, lon: number) {
  const n = jd - 2451545.0;
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lmst = (gmst + lon / 15 + 48) % 24;
  const ha = (lmst * 15 - raDeg) * D2R;
  const dec = decDeg * D2R;
  const la = lat * D2R;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { el, az }; // az from north, clockwise (radians)
}

/** az measured from north, clockwise. x = east, y = up, z = south (north is -z). */
function toVec(el: number, az: number): [number, number, number] {
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}

export interface Ephemeris {
  sun: [number, number, number];
  moon: [number, number, number];
  sunEl: number; // degrees
  moonEl: number;
  moonIllum: number; // 0..1 illuminated fraction
  sunLonEcl: number;
}

export function ephemeris(date: Date, lat = SG_LAT, lon = SG_LON): Ephemeris {
  const jd = julian(date);
  const n = jd - 2451545.0;
  // --- Sun
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / D2R;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)) / D2R;
  const s = altAz(ra, dec, jd, lat, lon);
  // --- Moon (Schlyter's method with main perturbations)
  const d = jd - 2451543.5;
  const N = (125.1228 - 0.0529538083 * d) * D2R;
  const inc = 5.1454 * D2R;
  const w = (318.0634 + 0.1643573223 * d) * D2R;
  const a = 60.2666;
  const e = 0.0549;
  const M = ((115.3654 + 13.0649929509 * d) % 360) * D2R;
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let i = 0; i < 4; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  const r = Math.hypot(xv, yv);
  const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(inc));
  const yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(inc));
  const zh = r * (Math.sin(v + w) * Math.sin(inc));
  let lonM = Math.atan2(yh, xh);
  let latM = Math.atan2(zh, Math.hypot(xh, yh));
  // perturbations (degrees)
  const Ms = g;
  const Lm = N + w + M;
  const Dm = Lm - lam;
  const F = Lm - N;
  lonM += D2R * (-1.274 * Math.sin(M - 2 * Dm) + 0.658 * Math.sin(2 * Dm) - 0.186 * Math.sin(Ms)
    - 0.059 * Math.sin(2 * M - 2 * Dm) - 0.057 * Math.sin(M - 2 * Dm + Ms) + 0.053 * Math.sin(M + 2 * Dm)
    + 0.046 * Math.sin(2 * Dm - Ms) + 0.041 * Math.sin(M - Ms) - 0.035 * Math.sin(Dm) - 0.031 * Math.sin(M + Ms));
  latM += D2R * (-0.173 * Math.sin(F - 2 * Dm) - 0.055 * Math.sin(M - F - 2 * Dm) - 0.046 * Math.sin(M + F - 2 * Dm));
  const xe = Math.cos(lonM) * Math.cos(latM);
  const ye = Math.sin(lonM) * Math.cos(latM) * Math.cos(eps) - Math.sin(latM) * Math.sin(eps);
  const ze = Math.sin(lonM) * Math.cos(latM) * Math.sin(eps) + Math.sin(latM) * Math.cos(eps);
  const raM = Math.atan2(ye, xe) / D2R;
  const decM = Math.atan2(ze, Math.hypot(xe, ye)) / D2R;
  const m = altAz(raM, decM, jd, lat, lon);
  const elong = Math.acos(Math.cos(lonM - lam) * Math.cos(latM));
  const illum = (1 - Math.cos(elong)) / 2;
  return {
    sun: toVec(s.el, s.az),
    moon: toVec(m.el, m.az),
    sunEl: s.el / D2R,
    moonEl: m.el / D2R,
    moonIllum: illum,
    sunLonEcl: lam / D2R,
  };
}

/** Build a Date for a given Singapore local date and decimal hour. */
export function sgDate(year: number, month: number, day: number, hour: number) {
  const h = Math.floor(hour);
  const mi = Math.floor((hour - h) * 60);
  const s = Math.floor(((hour - h) * 60 - mi) * 60);
  return new Date(Date.UTC(year, month - 1, day, h - SG_TZ, mi, s));
}

/** Current Singapore wall-clock time as {y, m, d, hour}. */
export function sgNow() {
  const now = new Date(Date.now() + SG_TZ * 3600 * 1000);
  return {
    y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate(),
    hour: now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600,
  };
}
