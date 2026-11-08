import earcut from 'earcut';
import { BuildingRec, Ring, rgb565 } from '../data/bundleFormat';
import { SolidBuilder } from './builder';

// facade classes (mirror of pipeline heights.CLASSES)
export const CL = {
  generic: 0, house: 1, terrace: 2, hdb: 3, condo: 4, office: 5, retail: 6, industrial: 7, civic: 8,
  religious: 9, hospital: 10, hotel: 11, parking: 12, shophouse: 13, roof: 14, transport: 15, tank: 16,
  construction: 17, greenhouse: 18, sports: 19, school: 20, warehouse: 21, structure: 250,
} as const;

export interface HeightSampler { (x: number, y: number): number }

function signedArea(xs: Float64Array, ys: Float64Array) {
  let a = 0;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (xs[j] - xs[i]) * (ys[j] + ys[i]);
  return a / 2;
}
function reverseRing(r: Ring): Ring {
  return { xs: r.xs.slice().reverse(), ys: r.ys.slice().reverse() };
}
/** remove duplicate & nearly collinear vertices */
function cleanRing(r: Ring, tol = 0.15): Ring {
  const n = r.xs.length;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = r.xs[(i + n - 1) % n], py = r.ys[(i + n - 1) % n];
    const cx = r.xs[i], cy = r.ys[i];
    const nx = r.xs[(i + 1) % n], ny = r.ys[(i + 1) % n];
    const dx1 = cx - px, dy1 = cy - py, dx2 = nx - cx, dy2 = ny - cy;
    const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
    if (l1 < 0.05) continue;
    const cross = Math.abs(dx1 * dy2 - dy1 * dx2) / Math.max(l2, 1e-6);
    if (cross < tol && dx1 * dx2 + dy1 * dy2 > 0 && l2 > 0.05) continue;
    xs.push(cx); ys.push(cy);
  }
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
}

function hash(n: number) {
  n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15);
  return (n >>> 0) / 4294967296;
}

export interface BuildingInfo {
  name: string | null; addr: string | null; cls: number; h: number; minh: number; levels: number;
  flags: number; cx: number; cy: number; base: number;
}

/**
 * Extrude one building into the builder. Coordinates: tile-relative pipeline frame
 * (x east, y north); output three.js frame relative to tile centre: (x, elev, -y).
 */
export function meshBuilding(
  b: BuildingRec, id: number, out: SolidBuilder, heightAt: HeightSampler, ox: number, oy: number,
  lod: 0 | 1, info?: BuildingInfo[],
) {
  const mk = out.mark();
  try {
    meshBuildingInner(b, id, out, heightAt, ox, oy, lod, info);
  } catch {
    out.rollback(mk);
    return;
  }
  if (!out.validSince(mk)) out.rollback(mk);
}

function meshBuildingInner(
  b: BuildingRec, id: number, out: SolidBuilder, heightAt: HeightSampler, ox: number, oy: number,
  lod: 0 | 1, info?: BuildingInfo[],
) {
  if (b.flags & 4 || b.flags & 8) return;
  if (b.rings.length === 0) return;
  let rings = b.rings.map((r) => cleanRing(r)).filter((r) => r.xs.length >= 3);
  if (rings.length === 0) return;
  // orientation: exterior CCW (positive area), holes CW
  rings = rings.map((r, i) => {
    const a = signedArea(r.xs, r.ys);
    return (i === 0) === (a < 0) ? reverseRing(r) : r;
  });
  const ext = rings[0];
  // ground elevation: minimum terrain under the footprint
  let base = Infinity;
  let cx = 0, cy = 0;
  for (let i = 0; i < ext.xs.length; i++) {
    const h = heightAt(ox + ext.xs[i], oy + ext.ys[i]);
    if (h < base) base = h;
    cx += ext.xs[i]; cy += ext.ys[i];
  }
  cx /= ext.xs.length; cy /= ext.xs.length;
  base = Math.max(base, 0.2);
  const [wr, wg, wb] = rgb565(b.wall);
  const [rr, rg, rb] = rgb565(b.roofCol);
  const glass = b.flags & 32 ? 1 : 0;
  const green = b.flags & 64 ? 2 : 0;
  const mat = glass | green;
  const levels = Math.max(1, b.levels || 1);
  const span = Math.max(0.5, b.h - b.minh);
  const storey = Math.min(12.7, Math.max(2.4, span / levels));
  const sh = Math.round(storey * 20);
  const seed = b.seed & 255;
  const flags = (b.flags & 0x83) | ((b.seed >> 8) & 0x7c);
  const y0 = base + b.minh;
  let roofShape = b.roof;
  let roofH = Math.min(b.roofH, span * 0.6);
  if (lod === 1 && (roofShape === 1 || roofShape === 2 || roofShape === 3 || roofShape === 6)) roofShape = 0;
  if (roofShape !== 0 && roofH <= 0.2) roofShape = 0;
  const yTop = base + b.h;
  const yW = roofShape === 0 ? yTop : yTop - roofH;
  info?.push({ name: b.name, addr: b.addr, cls: b.cls, h: b.h, minh: b.minh, levels: b.levels, flags: b.flags, cx: ox + cx, cy: oy + cy, base });

  const vtx = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, roof: boolean) =>
    out.vertex(x, y, -z, nx, ny, -nz, u, v, roof ? rr : wr, roof ? rg : wg, roof ? rb : wb, mat | (roof ? 4 : 0), b.cls, sh, seed, flags, id);
  const ctx: Ctx = { vtx, out };

  // ---- walls
  for (const r of rings) {
    const n = r.xs.length;
    let u = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r.xs[i], ay = r.ys[i], bx = r.xs[j], by = r.ys[j];
      const dx = bx - ax, dy = by - ay;
      const L = Math.hypot(dx, dy);
      if (L < 0.05) continue;
      const nx = dy / L, ny = -dx / L;
      const a = vtx(ax, y0, ay, nx, 0, ny, u, b.minh, false);
      const bb = vtx(bx, y0, by, nx, 0, ny, u + L, b.minh, false);
      const c = vtx(bx, yW, by, nx, 0, ny, u + L, yW - base, false);
      const d = vtx(ax, yW, ay, nx, 0, ny, u, yW - base, false);
      out.tri(a, bb, c); out.tri(a, c, d);
      u += L;
    }
  }

  // ---- roof
  let done = false;
  const ne = ext.xs.length;
  if ((roofShape === 1 || roofShape === 2) && rings.length === 1 && ne === 4) {
    done = gableHip(ext, roofShape === 2, yW, roofH, ctx);
  }
  if (!done && (roofShape === 1 || roofShape === 2 || roofShape === 3 || roofShape === 6) && rings.length === 1) {
    if (roofShape === 3 || ne <= 6) done = pyramid(ext, yW, roofH, cx, cy, ctx, ne <= 6 && roofShape !== 3);
    if (!done) done = insetRoof(ext, yW, roofH, ctx);
  }
  if (!done && (roofShape === 4 || roofShape === 5 || roofShape === 7 || roofShape === 8) && rings.length === 1) {
    done = dome(ext, yW, roofH, cx, cy, ctx, roofShape === 8);
  }
  if (!done) flatRoof(rings, yW, ctx);

  // ---- rooftop plant: HDB lift motor rooms & water tanks, mechanical boxes on towers
  if (lod === 0 && roofShape === 0 && span > 9 && rings.length >= 1) {
    rooftop(b, ext, yW, cx, cy, ctx);
  }
}

type VtxFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, roof: boolean) => number;
interface Ctx { vtx: VtxFn; out: SolidBuilder }

function faceNormal(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
  // inputs in (x, elev, north); returns normal in same frame
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  return [nx, ny, nz];
}

/** add a planar polygon (x, elev, north) with upward-facing triangles fan-ordered */
function poly(pts: number[][], ctx: Ctx, roof: boolean) {
  if (pts.length < 3) return;
  let [nx, ny, nz] = faceNormal(pts[0][0], pts[0][1], pts[0][2], pts[1][0], pts[1][1], pts[1][2], pts[2][0], pts[2][1], pts[2][2]);
  // in (x, elev, north) a CCW-from-above polygon yields normal with -elev using right hand rule
  // when north is the third axis; flip so roofs face up / walls face out.
  let flip = false;
  if (roof && ny < 0) flip = true;
  if (flip) { nx = -nx; ny = -ny; nz = -nz; }
  const ids = pts.map((p) => ctx.vtx(p[0], p[1], p[2], nx, ny, nz, 0, 0, roof));
  const sb = ctx.out;
  for (let i = 1; i < ids.length - 1; i++) {
    if (flip) sb.tri(ids[0], ids[i], ids[i + 1]); else sb.tri(ids[0], ids[i + 1], ids[i]);
  }
}

function gableHip(r: Ring, hip: boolean, yW: number, rh: number, ctx: Ctx) {
  const xs = r.xs, ys = r.ys;
  const len = (i: number) => Math.hypot(xs[(i + 1) % 4] - xs[i], ys[(i + 1) % 4] - ys[i]);
  const l0 = len(0) + len(2), l1 = len(1) + len(3);
  // ridge parallel to the longer pair of edges
  const s = l0 >= l1 ? 0 : 1;
  const v = (k: number) => [xs[(s + k) % 4], ys[(s + k) % 4]];
  const [p0, p1, p2, p3] = [v(0), v(1), v(2), v(3)];
  // ridge endpoints at the mid points of the short edges p1-p2 and p3-p0
  let ra = [(p3[0] + p0[0]) / 2, (p3[1] + p0[1]) / 2];
  let rb = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const rl = Math.hypot(rb[0] - ra[0], rb[1] - ra[1]);
  if (rl < 0.5) return false;
  const yR = yW + rh;
  if (hip) {
    const short = (Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p0[0] - p3[0], p0[1] - p3[1])) / 4;
    const d = Math.min(short, rl * 0.45);
    const dx = (rb[0] - ra[0]) / rl, dy = (rb[1] - ra[1]) / rl;
    ra = [ra[0] + dx * d, ra[1] + dy * d];
    rb = [rb[0] - dx * d, rb[1] - dy * d];
  }
  poly([[p0[0], yW, p0[1]], [p1[0], yW, p1[1]], [rb[0], yR, rb[1]], [ra[0], yR, ra[1]]], ctx, true);
  poly([[p2[0], yW, p2[1]], [p3[0], yW, p3[1]], [ra[0], yR, ra[1]], [rb[0], yR, rb[1]]], ctx, true);
  if (hip) {
    poly([[p1[0], yW, p1[1]], [p2[0], yW, p2[1]], [rb[0], yR, rb[1]]], ctx, true);
    poly([[p3[0], yW, p3[1]], [p0[0], yW, p0[1]], [ra[0], yR, ra[1]]], ctx, true);
  } else {
    // vertical gable ends in wall colour
    gableWall(p1, p2, rb, yW, yR, ctx);
    gableWall(p3, p0, ra, yW, yR, ctx);
  }
  return true;
}

function gableWall(a: number[], b: number[], apex: number[], yW: number, yR: number, ctx: Ctx) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = dy / L, ny = -dx / L;
  const sb = ctx.out;
  const i0 = ctx.vtx(a[0], yW, a[1], nx, 0, ny, 0, 99, false);
  const i1 = ctx.vtx(b[0], yW, b[1], nx, 0, ny, L, 99, false);
  const i2 = ctx.vtx(apex[0], yR, apex[1], nx, 0, ny, L / 2, 99, false);
  sb.tri(i0, i1, i2);
}

function pyramid(r: Ring, yW: number, rh: number, cx: number, cy: number, ctx: Ctx, onlyConvex: boolean) {
  const n = r.xs.length;
  if (onlyConvex) {
    // require convexity for a clean hipped look
    let sgn = 0;
    for (let i = 0; i < n; i++) {
      const a = i, b = (i + 1) % n, c = (i + 2) % n;
      const cr = (r.xs[b] - r.xs[a]) * (r.ys[c] - r.ys[b]) - (r.ys[b] - r.ys[a]) * (r.xs[c] - r.xs[b]);
      const s = Math.sign(cr);
      if (s !== 0) { if (sgn === 0) sgn = s; else if (s !== sgn) return false; }
    }
  }
  const yA = yW + rh;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    poly([[r.xs[i], yW, r.ys[i]], [r.xs[j], yW, r.ys[j]], [cx, yA, cy]], ctx, true);
  }
  return true;
}

function insetRoof(r: Ring, yW: number, rh: number, ctx: Ctx) {
  const n = r.xs.length;
  const d = Math.max(0.8, rh * 1.4);
  const ix = new Float64Array(n), iy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    let e1x = r.xs[i] - r.xs[p], e1y = r.ys[i] - r.ys[p];
    let e2x = r.xs[q] - r.xs[i], e2y = r.ys[q] - r.ys[i];
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    // inward normals of a CCW ring: (-ey, ex)
    const n1x = -e1y, n1y = e1x, n2x = -e2y, n2y = e2x;
    let mx = n1x + n2x, my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-3) { mx = n1x; my = n1y; } else { mx /= ml; my /= ml; }
    const cosh = mx * n1x + my * n1y;
    const k = Math.min(d / Math.max(cosh, 0.35), d * 2.5);
    ix[i] = r.xs[i] + mx * k;
    iy[i] = r.ys[i] + my * k;
  }
  const a0 = signedArea(r.xs, r.ys), a1 = signedArea(ix, iy);
  if (a1 <= a0 * 0.15) return false;
  const yI = yW + rh;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    poly([[r.xs[i], yW, r.ys[i]], [r.xs[j], yW, r.ys[j]], [ix[j], yI, iy[j]], [ix[i], yI, iy[i]]], ctx, true);
  }
  flatRoof([{ xs: ix, ys: iy }], yI, ctx);
  return true;
}

function dome(r: Ring, yW: number, rh: number, cx: number, cy: number, ctx: Ctx, cone: boolean) {
  const n = r.xs.length;
  if (n < 5) return false;
  const K = cone ? 1 : 6;
  const sb = ctx.out;
  // rings of vertices from the eave to near the apex
  let prev: number[][] = [];
  for (let i = 0; i < n; i++) prev.push([r.xs[i], yW, r.ys[i]]);
  for (let k = 1; k <= K; k++) {
    const th = (k / K) * (Math.PI / 2) * (cone ? 1 : 0.94);
    const s = cone ? 0 : Math.cos(th);
    const y = cone ? yW + rh : yW + rh * Math.sin(th);
    const cur: number[][] = [];
    for (let i = 0; i < n; i++) cur.push([cx + (r.xs[i] - cx) * s, y, cy + (r.ys[i] - cy) * s]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      poly([prev[i], prev[j], cur[j], cur[i]], ctx, true);
    }
    prev = cur;
  }
  if (!cone) {
    const apex = [cx, yW + rh, cy];
    for (let i = 0; i < n; i++) poly([prev[i], prev[(i + 1) % n], apex], ctx, true);
  }
  return true;
}

function flatRoof(rings: Ring[], y: number, ctx: Ctx) {
  const coords: number[] = [];
  const holes: number[] = [];
  for (let k = 0; k < rings.length; k++) {
    if (k > 0) holes.push(coords.length / 2);
    const r = rings[k];
    for (let i = 0; i < r.xs.length; i++) coords.push(r.xs[i], r.ys[i]);
  }
  const tris = earcut(coords, holes.length ? holes : undefined, 2);
  const ids: number[] = [];
  for (let i = 0; i < coords.length / 2; i++) ids.push(ctx.vtx(coords[i * 2], y, coords[i * 2 + 1], 0, 1, 0, coords[i * 2], coords[i * 2 + 1], true));
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ax = coords[a * 2], ay = coords[a * 2 + 1], bx = coords[b * 2], by = coords[b * 2 + 1], cx = coords[c * 2], cy = coords[c * 2 + 1];
    const cr = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // CCW in (x, north) maps to an upward-facing (+Y) front face in three.js
    if (cr > 0) ctx.out.tri(ids[a], ids[b], ids[c]); else ctx.out.tri(ids[a], ids[c], ids[b]);
  }
}

function pointInRing(x: number, y: number, r: Ring) {
  let inside = false;
  const n = r.xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r.xs[i], yi = r.ys[i], xj = r.xs[j], yj = r.ys[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** axis-aligned (to the footprint's main axis) box */
function box(cx: number, cy: number, ax: number, ay: number, hw: number, hd: number, y0: number, y1: number, ctx: Ctx) {
  const bx = -ay, by = ax;
  const c = [
    [cx - ax * hw - bx * hd, cy - ay * hw - by * hd],
    [cx + ax * hw - bx * hd, cy + ay * hw - by * hd],
    [cx + ax * hw + bx * hd, cy + ay * hw + by * hd],
    [cx - ax * hw + bx * hd, cy - ay * hw + by * hd],
  ];
  const sb = ctx.out;
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const nx = dy / L, ny = -dx / L;
    const i0 = ctx.vtx(a[0], y0, a[1], nx, 0, ny, 0, 98, false);
    const i1 = ctx.vtx(b[0], y0, b[1], nx, 0, ny, L, 98, false);
    const i2 = ctx.vtx(b[0], y1, b[1], nx, 0, ny, L, 98, false);
    const i3 = ctx.vtx(a[0], y1, a[1], nx, 0, ny, 0, 98, false);
    sb.tri(i0, i1, i2); sb.tri(i0, i2, i3);
  }
  const t = c.map((p) => ctx.vtx(p[0], y1, p[1], 0, 1, 0, 0, 0, true));
  sb.tri(t[0], t[1], t[2]); sb.tri(t[0], t[2], t[3]);
}

function rooftop(b: BuildingRec, ext: Ring, yW: number, cx: number, cy: number, ctx: Ctx) {
  // main axis from the longest edge
  let best = 0, ax = 1, ay = 0;
  const n = ext.xs.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ext.xs[j] - ext.xs[i], dy = ext.ys[j] - ext.ys[i];
    const L = Math.hypot(dx, dy);
    if (L > best) { best = L; ax = dx / L; ay = dy / L; }
  }
  if (!pointInRing(cx, cy, ext)) return;
  const r = (k: number) => hash(b.seed * 31 + k);
  if (b.flags & 2 || b.cls === CL.hdb) {
    // HDB slab blocks: lift motor rooms spaced along the block + a water tank
    const nL = best > 50 ? 3 : best > 25 ? 2 : 1;
    for (let k = 0; k < nL; k++) {
      const t = nL === 1 ? 0 : (k / (nL - 1) - 0.5) * best * 0.62;
      const px = cx + ax * t, py = cy + ay * t;
      if (!pointInRing(px, py, ext)) continue;
      box(px, py, ax, ay, 2.2, 2.6, yW, yW + 3.4 + r(k) * 0.6, ctx);
    }
    const tx = cx + ax * best * 0.12, ty = cy + ay * best * 0.12;
    if (pointInRing(tx, ty, ext)) box(tx, ty, ax, ay, 3.2, 2.4, yW + 3.0, yW + 5.6, ctx);
  } else if (b.h > 25 && (b.cls === CL.office || b.cls === CL.condo || b.cls === CL.hotel || b.cls === CL.generic)) {
    const s = Math.min(best * 0.2, 9);
    box(cx, cy, ax, ay, s, s * (0.6 + r(1) * 0.4), yW, yW + 3 + r(2) * 3, ctx);
    if (best > 30) {
      const ox = cx + ax * best * 0.25, oy = cy + ay * best * 0.25;
      if (pointInRing(ox, oy, ext)) box(ox, oy, ax, ay, 2.5, 2.5, yW, yW + 2.2, ctx);
    }
  } else if (b.cls === CL.industrial || b.cls === CL.warehouse || b.cls === CL.retail) {
    if (r(3) < 0.5 && best > 20) box(cx, cy, ax, ay, 2.0, 1.4, yW, yW + 1.6, ctx);
  }
}

