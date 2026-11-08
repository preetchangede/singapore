import earcut from 'earcut';
import { AreaRec, LineRec, BuildingRec, Ring, rgb565 } from '../data/bundleFormat';
import { FlatBuilder, SolidBuilder } from './builder';
import { GROUND, ROAD_CLASSES } from '../data/schema.gen';
import { CL, HeightSampler } from './buildings';

function hexToRgb(h: string): number[] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const GROUND_RGB = GROUND.map((g) => hexToRgb(g.color));
const G = Object.fromEntries(GROUND.map((g, i) => [g.name, i])) as Record<string, number>;
const RC = Object.fromEntries(ROAD_CLASSES.map((n, i) => [n, i])) as Record<string, number>;

// detail codes (material alpha channel)
const D = { none: 0, asphalt: 1, veg: 2, paving: 3, paint: 4, sand: 5, earth: 6, water: 7, roof: 8, forest: 9 };

function detailFor(name: string) {
  switch (name) {
    case 'grass': case 'park': case 'golf': case 'pitch': case 'garden': case 'schoolfield': case 'scrub': case 'farmland': case 'cemetery': case 'military': case 'airport': return D.veg;
    case 'forest': case 'wetland': return D.forest;
    case 'sand': return D.sand;
    case 'bare': return D.earth;
    case 'parking': case 'runway': case 'taxiway': case 'apron': return D.asphalt;
    case 'plaza': case 'pier': case 'track': case 'court': case 'playground': return D.paving;
    case 'water': case 'pool': return D.water;
    default: return D.none;
  }
}
const LIGHT: Record<string, number> = { parking: 140, plaza: 120, apron: 160, runway: 60, taxiway: 90, pier: 90, court: 70, playground: 40, commercial: 30, industrial: 25, port: 80 };

function hash(n: number) {
  n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15);
  return (n >>> 0) / 4294967296;
}

function triangulate(rings: Ring[], out: FlatBuilder, col: number[], mat: number[]) {
  const coords: number[] = [];
  const holes: number[] = [];
  rings.forEach((r, k) => {
    if (k > 0) holes.push(coords.length / 2);
    for (let i = 0; i < r.xs.length; i++) coords.push(r.xs[i], r.ys[i]);
  });
  if (coords.length < 6) return;
  const t = earcut(coords, holes.length ? holes : undefined, 2);
  const base = out.count;
  for (let i = 0; i < coords.length / 2; i++) out.vertex(coords[i * 2], coords[i * 2 + 1], col, mat);
  for (let i = 0; i < t.length; i += 3) out.tri(base + t[i], base + t[i + 1], base + t[i + 2]);
}

export function meshAreas(areas: AreaRec[], out: FlatBuilder) {
  areas.forEach((a, i) => {
    const g = GROUND[a.kind];
    if (!g) return;
    const v = 0.92 + hash(i * 7 + a.kind) * 0.16;
    const c = GROUND_RGB[a.kind].map((x) => Math.min(255, x * v));
    const mat = [Math.round(g.rough * 255), LIGHT[g.name] ?? 0, g.name === 'pool' ? 200 : 0, detailFor(g.name)];
    triangulate(a.rings, out, c, mat);
  });
}

export function meshWaterFlat(water: AreaRec[], out: FlatBuilder) {
  const c = hexToRgb('#2b4a52');
  for (const w of water) triangulate(w.rings, out, c, [10, 0, 255, D.water]);
}

/** water surfaces at their own level (3D), positions in three.js frame */
export function meshWaterSurface(water: AreaRec[]) {
  const pos: number[] = [];
  const idx: number[] = [];
  const lvl: number[] = [];
  for (const w of water) {
    const coords: number[] = [];
    const holes: number[] = [];
    w.rings.forEach((r, k) => {
      if (k > 0) holes.push(coords.length / 2);
      for (let i = 0; i < r.xs.length; i++) coords.push(r.xs[i], r.ys[i]);
    });
    if (coords.length < 6) continue;
    const t = earcut(coords, holes.length ? holes : undefined, 2);
    const base = pos.length / 3;
    const y = Math.max(0.05, w.level) + 0.05;
    for (let i = 0; i < coords.length / 2; i++) { pos.push(coords[i * 2], y, -coords[i * 2 + 1]); lvl.push(w.kind); }
    for (let i = 0; i < t.length; i += 3) {
      // CCW in (x,north) -> keep for +Y
      const a = t[i], b = t[i + 1], c = t[i + 2];
      const cr = (coords[b * 2] - coords[a * 2]) * (coords[c * 2 + 1] - coords[a * 2 + 1]) - (coords[b * 2 + 1] - coords[a * 2 + 1]) * (coords[c * 2] - coords[a * 2]);
      if (cr > 0) idx.push(base + a, base + b, base + c); else idx.push(base + a, base + c, base + b);
    }
  }
  return { position: new Float32Array(pos), kind: new Uint8Array(lvl), index: new Uint32Array(idx) };
}

/** Building footprints as roof-coloured ground (seen where 3D buildings are not drawn). */
export function meshFootprints(bs: BuildingRec[], out: FlatBuilder) {
  for (const b of bs) {
    if (b.flags & 1) continue; // parts: the outline is enough
    const c = rgb565(b.roofCol).map((x) => x * 0.9);
    triangulate(b.rings, out, c, [200, 0, 0, D.roof]);
  }
}

const ROAD_RGB: Record<string, number[]> = {
  motorway: hexToRgb('#4a4a49'), trunk: hexToRgb('#4c4c4b'), primary: hexToRgb('#4e4d4c'), secondary: hexToRgb('#504f4e'),
  tertiary: hexToRgb('#535250'), minor: hexToRgb('#575654'), service: hexToRgb('#5d5c59'), motorway_link: hexToRgb('#4c4c4b'),
  link: hexToRgb('#4f4e4d'), pedestrian: hexToRgb('#b4ab9e'), footway: hexToRgb('#b7ad9c'), track: hexToRgb('#9b8a71'),
  busway: hexToRgb('#7a4c42'), cycleway: hexToRgb('#8d6556'), steps: hexToRgb('#b0aa9f'), raceway: hexToRgb('#454545'),
};
const ROAD_LIGHT: Record<string, number> = {
  motorway: 255, trunk: 255, primary: 240, secondary: 225, tertiary: 205, minor: 180, service: 120, motorway_link: 230,
  link: 220, pedestrian: 170, footway: 90, track: 0, busway: 200, cycleway: 70, steps: 60, raceway: 120,
};

/** Offset polyline into a triangle strip with mitred joins. */
function strip(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number, w: number, out: FlatBuilder, col: number[], mat: number[], off = 0) {
  if (n < 2) return;
  const L: number[] = [], R: number[] = [];
  for (let i = 0; i < n; i++) {
    let tx: number, ty: number;
    let mx: number, my: number, scale = 1;
    if (i === 0 || i === n - 1) {
      const a = i === 0 ? 0 : n - 2;
      tx = xs[a + 1] - xs[a]; ty = ys[a + 1] - ys[a];
      const l = Math.hypot(tx, ty) || 1;
      mx = -ty / l; my = tx / l;
    } else {
      let ax = xs[i] - xs[i - 1], ay = ys[i] - ys[i - 1];
      let bx = xs[i + 1] - xs[i], by = ys[i + 1] - ys[i];
      const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
      ax /= la; ay /= la; bx /= lb; by /= lb;
      const n1x = -ay, n1y = ax, n2x = -by, n2y = bx;
      mx = n1x + n2x; my = n1y + n2y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-4) { mx = n1x; my = n1y; } else { mx /= ml; my /= ml; scale = 1 / Math.max(mx * n1x + my * n1y, 0.5); }
    }
    const h = (w / 2) * scale;
    L.push(xs[i] + mx * (h + off), ys[i] + my * (h + off));
    R.push(xs[i] - mx * (h - off), ys[i] - my * (h - off));
  }
  const base = out.count;
  for (let i = 0; i < n; i++) {
    out.vertex(L[i * 2], L[i * 2 + 1], col, mat);
    out.vertex(R[i * 2], R[i * 2 + 1], col, mat);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
    out.tri(a, b, c); out.tri(b, d, c);
  }
}

/** Dashed/solid line at lateral offset along a polyline. */
function paintLine(xs: Float64Array, ys: Float64Array, off: number, w: number, dash: number, gap: number, out: FlatBuilder, col: number[]) {
  const n = xs.length;
  if (n < 2) return;
  // offset polyline
  const ox: number[] = [], oy: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = xs[b] - xs[a], ty = ys[b] - ys[a];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    ox.push(xs[i] - ty * off); oy.push(ys[i] + tx * off);
  }
  const mat = [90, 0, 0, D.paint];
  if (dash <= 0) { strip(ox, oy, n, w, out, col, mat); return; }
  // walk along and emit dashes
  let s = 0, on = true, rem = dash;
  let px = ox[0], py = oy[0];
  let seg: number[] = [px, py];
  for (let i = 1; i < n; i++) {
    let qx = ox[i], qy = oy[i];
    let d = Math.hypot(qx - px, qy - py);
    while (d > 0) {
      if (d >= rem) {
        const t = rem / d;
        const ix = px + (qx - px) * t, iy = py + (qy - py) * t;
        if (on) { seg.push(ix, iy); emit(seg); }
        on = !on;
        seg = [ix, iy];
        d -= rem; s += rem;
        rem = on ? dash : gap;
        px = ix; py = iy;
      } else {
        rem -= d; s += d;
        if (on) seg.push(qx, qy);
        px = qx; py = qy;
        d = 0;
      }
    }
  }
  if (on && seg.length >= 4) emit(seg);
  function emit(sg: number[]) {
    const m = sg.length / 2;
    if (m < 2) return;
    const sx = new Float64Array(m), sy = new Float64Array(m);
    for (let k = 0; k < m; k++) { sx[k] = sg[k * 2]; sy[k] = sg[k * 2 + 1]; }
    strip(sx, sy, m, w, out, col, mat);
  }
  void s;
}

const WHITE = hexToRgb('#e9e8e1');
const YELLOW = hexToRgb('#e0b23c');

export function meshRoads(roads: LineRec[], out: FlatBuilder, marks: FlatBuilder, detail: boolean) {
  // draw low classes first so major roads paint over junctions
  const order = roads.map((r, i) => i).sort((a, b) => roads[b].cls - roads[a].cls);
  for (const i of order) {
    const r = roads[i];
    if (r.flags & 2) continue; // bridges are 3D
    const name = ROAD_CLASSES[r.cls];
    const col = ROAD_RGB[name] ?? ROAD_RGB.minor;
    const v = 0.95 + hash(i * 13 + r.cls) * 0.1;
    const c = col.map((x) => x * v);
    const isPath = name === 'footway' || name === 'steps' || name === 'cycleway' || name === 'track' || name === 'pedestrian';
    const mat = [isPath ? 215 : 175, ROAD_LIGHT[name] ?? 120, 0, isPath ? D.paving : D.asphalt];
    // kerb / verge: a slightly wider pale band under carriageways
    if (!isPath && r.width >= 5 && detail) strip(r.xs, r.ys, r.xs.length, r.width + 1.4, out, hexToRgb('#a7a296'), [210, ROAD_LIGHT[name] ?? 120, 0, D.paving]);
    strip(r.xs, r.ys, r.xs.length, Math.max(r.width, 1.2), out, c, mat);
    if (!detail || isPath) continue;
    const w = r.width;
    const oneway = (r.flags & 1) !== 0;
    const major = r.cls <= RC.tertiary || r.cls === RC.motorway_link || r.cls === RC.link;
    if (name === 'service' || w < 5) continue;
    if (oneway) {
      // lane dividers (dashed) + solid edge lines
      const lanes = Math.max(1, r.lanes || Math.round(w / 3.4));
      const lw = w / lanes;
      for (let k = 1; k < lanes; k++) paintLine(r.xs, r.ys, -w / 2 + k * lw, 0.14, 3.0, 6.0, marks, WHITE);
      if (major) {
        paintLine(r.xs, r.ys, -w / 2 + 0.35, 0.15, 0, 0, marks, WHITE);
        paintLine(r.xs, r.ys, w / 2 - 0.35, 0.15, 0, 0, marks, WHITE);
      }
    } else {
      // two-way single carriageway: white centre line, double yellow kerb lines on minor roads
      paintLine(r.xs, r.ys, 0, 0.14, major ? 0 : 3.0, major ? 0 : 5.0, marks, WHITE);
      if (!major) {
        for (const s of [-1, 1]) {
          paintLine(r.xs, r.ys, s * (w / 2 - 0.35), 0.1, 0, 0, marks, YELLOW);
          paintLine(r.xs, r.ys, s * (w / 2 - 0.58), 0.1, 0, 0, marks, YELLOW);
        }
      } else if (r.lanes >= 4) {
        const lw = w / r.lanes;
        for (let k = 1; k < r.lanes / 2; k++) {
          paintLine(r.xs, r.ys, k * lw, 0.14, 3.0, 6.0, marks, WHITE);
          paintLine(r.xs, r.ys, -k * lw, 0.14, 3.0, 6.0, marks, WHITE);
        }
      }
    }
  }
}

export function meshRailsFlat(rails: LineRec[], out: FlatBuilder) {
  const ballast = hexToRgb('#7d746a');
  const steel = hexToRgb('#3d3b39');
  for (const r of rails) {
    if (r.flags & 2) continue;
    if (r.cls === 5) continue; // disused
    strip(r.xs, r.ys, r.xs.length, 3.6, out, ballast, [230, 40, 0, D.earth]);
    paintLine(r.xs, r.ys, -0.72, 0.12, 0, 0, out, steel);
    paintLine(r.xs, r.ys, 0.72, 0.12, 0, 0, out, steel);
  }
}

// ---------------------------------------------------------------------------- 3D structures
const DECK = hexToRgb('#4d4d4b');
const CONCRETE = hexToRgb('#aaa79e');

/** Elevated roads and rail viaducts: deck, side beams, parapets, piers. */
export function meshBridges(lines: LineRec[], rail: boolean, out: SolidBuilder, heightAt: HeightSampler, ox: number, oy: number, idBase: number) {
  lines.forEach((r, k) => {
    if (!(r.flags & 2) || !r.elev) return;
    const n = r.xs.length;
    if (n < 2) return;
    const w = rail ? (r.cls === 1 || r.cls === 3 ? 5.5 : 9.5) : Math.max(r.width, 2.5);
    const thick = rail ? 1.8 : Math.min(1.6, 0.6 + w * 0.06);
    const id = idBase + k;
    // per-vertex deck elevation (absolute)
    const ys: number[] = [];
    for (let i = 0; i < n; i++) ys.push(heightAt(ox + r.xs[i], oy + r.ys[i]) + r.elev[i] + 0.25);
    const L: number[][] = [], R: number[][] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = r.xs[b] - r.xs[a], ty = r.ys[b] - r.ys[a];
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      L.push([r.xs[i] - ty * w / 2, r.ys[i] + tx * w / 2]);
      R.push([r.xs[i] + ty * w / 2, r.ys[i] - tx * w / 2]);
    }
    const V = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: number[], roof: boolean) =>
      out.vertex(x, y, -z, nx, ny, -nz, u, v, c[0], c[1], c[2], roof ? 4 : 0, CL.structure, 60, k & 255, rail ? 1 : 0, id);
    let u = 0;
    for (let i = 0; i < n - 1; i++) {
      const sl = Math.hypot(r.xs[i + 1] - r.xs[i], r.ys[i + 1] - r.ys[i]);
      // deck top
      const a = V(L[i][0], ys[i], L[i][1], 0, 1, 0, u, 0, DECK, true);
      const b = V(R[i][0], ys[i], R[i][1], 0, 1, 0, u, w, DECK, true);
      const c = V(L[i + 1][0], ys[i + 1], L[i + 1][1], 0, 1, 0, u + sl, 0, DECK, true);
      const d = V(R[i + 1][0], ys[i + 1], R[i + 1][1], 0, 1, 0, u + sl, w, DECK, true);
      out.tri(a, b, c); out.tri(b, d, c);
      // sides (beam + parapet)
      for (const side of [-1, 1]) {
        const P = side < 0 ? L : R;
        const dx = r.xs[i + 1] - r.xs[i], dy = r.ys[i + 1] - r.ys[i];
        const ll = Math.hypot(dx, dy) || 1;
        // outward normal for this side
        const nx = side * (dy / ll), ny = side * (-dx / ll);
        const top0 = ys[i] + (rail ? 1.1 : 0.9), top1 = ys[i + 1] + (rail ? 1.1 : 0.9);
        const bot0 = ys[i] - thick, bot1 = ys[i + 1] - thick;
        const q0 = V(P[i][0], bot0, P[i][1], nx, 0, ny, u, 0, CONCRETE, false);
        const q1 = V(P[i + 1][0], bot1, P[i + 1][1], nx, 0, ny, u + sl, 0, CONCRETE, false);
        const q2 = V(P[i + 1][0], top1, P[i + 1][1], nx, 0, ny, u + sl, 1, CONCRETE, false);
        const q3 = V(P[i][0], top0, P[i][1], nx, 0, ny, u, 1, CONCRETE, false);
        if (side > 0) { out.tri(q0, q1, q2); out.tri(q0, q2, q3); } else { out.tri(q0, q2, q1); out.tri(q0, q3, q2); }
        // underside
      }
      const ua = V(L[i][0], ys[i] - thick, L[i][1], 0, -1, 0, 0, 0, CONCRETE, false);
      const ub = V(R[i][0], ys[i] - thick, R[i][1], 0, -1, 0, 0, 0, CONCRETE, false);
      const uc = V(L[i + 1][0], ys[i + 1] - thick, L[i + 1][1], 0, -1, 0, 0, 0, CONCRETE, false);
      const ud = V(R[i + 1][0], ys[i + 1] - thick, R[i + 1][1], 0, -1, 0, 0, 0, CONCRETE, false);
      out.tri(ua, uc, ub); out.tri(ub, uc, ud);
      u += sl;
    }
    // piers every ~32 m where the deck is high enough
    let acc = 16;
    for (let i = 0; i < n - 1; i++) {
      const sl = Math.hypot(r.xs[i + 1] - r.xs[i], r.ys[i + 1] - r.ys[i]);
      while (acc < sl) {
        const t = acc / sl;
        const px = r.xs[i] + (r.xs[i + 1] - r.xs[i]) * t, py = r.ys[i] + (r.ys[i + 1] - r.ys[i]) * t;
        const top = ys[i] + (ys[i + 1] - ys[i]) * t - thick;
        const g = heightAt(ox + px, oy + py);
        if (top - g > 3.0) {
          const s = rail ? 1.1 : Math.min(1.2, 0.5 + w * 0.05);
          const dx = (r.xs[i + 1] - r.xs[i]) / sl, dy = (r.ys[i + 1] - r.ys[i]) / sl;
          pier(px, py, dx, dy, s, rail ? s * 1.6 : s * 2.2, g, top, out, V);
        }
        acc += rail ? 30 : 34;
      }
      acc -= sl;
    }
  });
}

type VFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: number[], roof: boolean) => number;
function pier(cx: number, cy: number, ax: number, ay: number, hw: number, hd: number, y0: number, y1: number, out: SolidBuilder, V: VFn) {
  // box aligned with the deck direction (a) and its normal (b)
  const bx = -ay, by = ax;
  const c = [
    [cx - ax * hw - bx * hd, cy - ay * hw - by * hd], [cx + ax * hw - bx * hd, cy + ay * hw - by * hd],
    [cx + ax * hw + bx * hd, cy + ay * hw + by * hd], [cx - ax * hw + bx * hd, cy - ay * hw + by * hd],
  ];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const nx = dy / L, ny = -dx / L;
    const i0 = V(a[0], y0, a[1], nx, 0, ny, 0, 0, CONCRETE, false);
    const i1 = V(b[0], y0, b[1], nx, 0, ny, L, 0, CONCRETE, false);
    const i2 = V(b[0], y1, b[1], nx, 0, ny, L, 1, CONCRETE, false);
    const i3 = V(a[0], y1, a[1], nx, 0, ny, 0, 1, CONCRETE, false);
    out.tri(i0, i1, i2); out.tri(i0, i2, i3);
  }
}
