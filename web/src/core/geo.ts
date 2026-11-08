// SVY21 (EPSG:3414) Transverse Mercator on WGS84 + the local world frame used by the pipeline.
//   pipeline:  x = easting - E0,  y = northing - N0
//   three.js:  x = x,  z = -y
const a = 6378137.0;
const f = 1 / 298.257223563;
const k0 = 1.0;
const lat0 = 1.366666666666667 * Math.PI / 180;
const lon0 = 103.8333333333333 * Math.PI / 180;
const FE = 28001.642;
const FN = 38744.572;
const e2 = 2 * f - f * f;
const ep2 = e2 / (1 - e2);
const n = f / (2 - f);

export const E0 = 28000.0;
export const N0 = 35000.0;

function meridianArc(phi: number) {
  const A0 = 1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256;
  const A2 = (3 / 8) * (e2 + (e2 * e2) / 4 + (15 * e2 ** 3) / 128);
  const A4 = (15 / 256) * (e2 * e2 + (3 * e2 ** 3) / 4);
  const A6 = (35 * e2 ** 3) / 3072;
  return a * (A0 * phi - A2 * Math.sin(2 * phi) + A4 * Math.sin(4 * phi) - A6 * Math.sin(6 * phi));
}
const M0 = meridianArc(lat0);

export function llToSvy21(lon: number, lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const nu = a / Math.sqrt(1 - e2 * sin * sin);
  const T = tan * tan, Cc = ep2 * cos * cos, A = (lam - lon0) * cos;
  const M = meridianArc(phi);
  const x = k0 * nu * (A + ((1 - T + Cc) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * Cc - 58 * ep2) * A ** 5) / 120);
  const y = k0 * (M - M0 + nu * tan * ((A * A) / 2 + ((5 - T + 9 * Cc + 4 * Cc * Cc) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * Cc - 330 * ep2) * A ** 6) / 720));
  return [FE + x, FN + y];
}

export function svy21ToLl(E: number, N: number): [number, number] {
  const M = M0 + (N - FN) / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const phi1 = mu + ((3 * n) / 2 - (27 * n ** 3) / 32) * Math.sin(2 * mu) + ((21 * n * n) / 16 - (55 * n ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * n ** 3) / 96) * Math.sin(6 * mu) + ((1097 * n ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1), cos = Math.cos(phi1), tan = Math.tan(phi1);
  const nu1 = a / Math.sqrt(1 - e2 * sin * sin);
  const rho1 = (a * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const T1 = tan * tan, C1 = ep2 * cos * cos;
  const D = (E - FE) / (nu1 * k0);
  const lat = phi1 - ((nu1 * tan) / rho1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / cos;
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** lon/lat -> three.js world (x, z) */
export function llToWorld(lon: number, lat: number): [number, number] {
  const [E, N] = llToSvy21(lon, lat);
  return [E - E0, -(N - N0)];
}

/** three.js world (x, z) -> lon/lat */
export function worldToLl(x: number, z: number): [number, number] {
  return svy21ToLl(x + E0, -z + N0);
}

export function formatLatLon(lon: number, lat: number) {
  const fmt = (v: number, pos: string, neg: string) => {
    const s = v >= 0 ? pos : neg;
    v = Math.abs(v);
    const d = Math.floor(v);
    const m = (v - d) * 60;
    const mi = Math.floor(m);
    const sec = Math.round((m - mi) * 60);
    return `${d}°${String(mi).padStart(2, '0')}′${String(sec).padStart(2, '0')}″${s}`;
  };
  return `${fmt(lat, 'N', 'S')}  ${fmt(lon, 'E', 'W')}`;
}
