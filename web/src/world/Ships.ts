import * as THREE from 'three';
import { COMMON, CURVATURE } from '../shaders/common';
import { ATMO_PARAMS, ATMO_RUNTIME } from '../shaders/atmosphere';
import { SHADOWS, LIGHTING } from '../shaders/lighting';
import { U } from '../core/uniforms';
import { DATA_BASE } from '../data/assets';

/* Ships of the Singapore Strait.
 *
 * Anchored ships come from the pipeline, placed inside the real MPA anchorage polygons;
 * they lie to the tidal stream and swing round together when it turns. Transiting ships
 * follow the traffic separation scheme lanes and ferries shuttle along their OSM routes.
 * Hulls are generated here from a few parametric designs and drawn as one InstancedMesh
 * per design variant; the surface detail (windows, containers, rust) is procedural. */

// ship types: index shared with pipeline/sgpipe/maritime.py
const CONTAINER = 0, TANKER = 1, BULK = 2, CARGO = 3, TUG = 4, BUNKER = 5, FERRY = 6, BUMBOAT = 7, NAVAL = 8, CARCARRIER = 9;

// surface parts
const P_HULL = 0, P_DECK = 1, P_HOUSE = 2, P_FUNNEL = 3, P_BOXES = 4, P_METAL = 5, P_HATCH = 7, P_GLASS = 8;

// light kinds
const L_WHITE = 0, L_RED = 1, L_GREEN = 2, L_FLOOD = 3;

type V3 = [number, number, number];
interface LightDef { p: V3; kind: number }

class Geo {
  pos: number[] = [];
  part: number[] = [];
  col: number[] = [];
  lights: LightDef[] = [];
  constructor(public L: number, public B: number, public draft: number) {}

  tri(a: V3, b: V3, c: V3, part: number, col: V3, hint: V3) {
    // three.js face normal = (c - b) x (a - b); flip to agree with the outward hint
    const cb = [c[0] - b[0], c[1] - b[1], c[2] - b[2]], ab = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const n = [cb[1] * ab[2] - cb[2] * ab[1], cb[2] * ab[0] - cb[0] * ab[2], cb[0] * ab[1] - cb[1] * ab[0]];
    if (n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0) [b, c] = [c, b];
    for (const v of [a, b, c]) { this.pos.push(v[0], v[1], v[2]); this.part.push(part); this.col.push(col[0], col[1], col[2]); }
  }
  quad(a: V3, b: V3, c: V3, d: V3, part: number, col: V3, hint: V3) {
    this.tri(a, b, c, part, col, hint);
    this.tri(a, c, d, part, col, hint);
  }
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part: number, col: V3) {
    this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], part, col, [1, 0, 0]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], part, col, [-1, 0, 0]);
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], part, col, [0, 1, 0]);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], part, col, [0, 0, 1]);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], part, col, [0, 0, -1]);
  }
  /** Hull from stations [x, half-breadth, deck height], stern to bow; sides run down to yb. */
  hull(st: V3[], yb: number, hullCol: V3, deckCol: V3) {
    const n = st.length;
    for (let i = 0; i < n - 1; i++) {
      const [x0, b0, d0] = st[i], [x1, b1, d1] = st[i + 1];
      const dx = x1 - x0, db = b1 - b0;
      this.quad([x0, yb, b0], [x1, yb, b1], [x1, d1, b1], [x0, d0, b0], P_HULL, hullCol, [-db, 0, dx]);
      this.quad([x0, yb, -b0], [x1, yb, -b1], [x1, d1, -b1], [x0, d0, -b0], P_HULL, hullCol, [-db, 0, -dx]);
    }
    const [xs, bs, ds] = st[0];
    this.quad([xs, yb, -bs], [xs, yb, bs], [xs, ds, bs], [xs, ds, -bs], P_HULL, hullCol, [-1, 0, 0]);
    const [xe, be, de] = st[n - 1];
    if (be > 0.01) this.quad([xe, yb, -be], [xe, yb, be], [xe, de, be], [xe, de, -be], P_HULL, hullCol, [1, 0, 0]);
    // deck: fan from the midpoint (the plan outline is convex)
    const xc = (xs + xe) / 2;
    let dc = ds;
    for (const s of st) if (s[0] <= xc) dc = s[2];
    const c: V3 = [xc, dc, 0];
    for (let i = 0; i < n - 1; i++) {
      const [x0, b0, d0] = st[i], [x1, b1, d1] = st[i + 1];
      this.tri(c, [x0, d0, b0], [x1, d1, b1], P_DECK, deckCol, [0, 1, 0]);
      this.tri(c, [x0, d0, -b0], [x1, d1, -b1], P_DECK, deckCol, [0, 1, 0]);
    }
    this.tri(c, [xs, ds, -bs], [xs, ds, bs], P_DECK, deckCol, [0, 1, 0]);
    if (be > 0.01) this.tri(c, [xe, de, -be], [xe, de, be], P_DECK, deckCol, [0, 1, 0]);
  }
  light(x: number, y: number, z: number, kind: number) { this.lights.push({ p: [x, y, z], kind }); }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();     // non-indexed: flat face normals
    return g;
  }
}

const smooth = (t: number) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

interface HullOpts { stern: number; bow: number; transom: number; deck: number; fore: number; bowFull?: number }
function stations(L: number, B: number, o: HullOpts): V3[] {
  const hb = B / 2, st: V3[] = [];
  const deckAt = (x: number) => o.deck + o.fore * smooth((x - (L / 2 - 0.14 * L)) / (0.14 * L));
  const xs0 = -L / 2, xs1 = -L / 2 + o.stern * L, xb0 = L / 2 - o.bow * L, xe = L / 2;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4, x = xs0 + (xs1 - xs0) * t;
    st.push([x, hb * (o.transom + (1 - o.transom) * Math.sqrt(t)), deckAt(x)]);
  }
  const nb = 9, k = o.bowFull ?? 2.2;
  for (let i = 0; i <= nb; i++) {
    const t = i / nb, x = xb0 + (xe - xb0) * t;
    st.push([x, i === nb ? 0 : hb * Math.pow(Math.max(0, 1 - Math.pow(t, k)), 0.55), deckAt(x)]);
  }
  return st;
}

/** sRGB hex -> linear rgb triple */
function lin(hex: string): V3 { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }
const WHITE = lin('#e7e4dc'), CREAM = lin('#ece5d4'), STEEL = lin('#9aa0a3'), MAST = lin('#cfcfca'), BLACK = lin('#1b1c1e');
const pickc = (r: () => number, a: string[]) => lin(a[Math.floor(r() * a.length)]);
const FUNNELS = ['#c8b23a', '#b52a22', '#1f3a5f', '#e6e3dc', '#2b2d33', '#d26a1a', '#2f6b3a', '#5a8fc4', '#7a1f1c'];
const CRANES = ['#d9b42a', '#e6e3dc', '#3f6f9f', '#b52a22', '#d26a1a'];

type Rand = () => number;
function rng(seed: number): Rand {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// --------------------------------------------------------------------------- designs
// Each returns a Geo built at its reference length; instances scale uniformly.
// Hull colour comes from the instance; aCol carries the fixed colours of each part
// (for container stacks aCol.x carries the deck height so the shader can find the tiers).

function containerShip(r: Rand, load: number) {
  const L = 300, B = 48, deck = 10.4, g = new Geo(L, B, 15);
  g.hull(stations(L, B, { stern: 0.12, bow: 0.2, transom: 0.78, deck, fore: 4 }), -15, WHITE, lin('#4b4d4f'));
  const hx0 = -99, hx1 = -85;
  g.box(hx0, hx1, deck, deck + 33, -15, 15, P_HOUSE, WHITE);
  g.box(hx0 + 6, hx1, deck + 33, deck + 36, -B / 2, B / 2, P_HOUSE, WHITE);
  g.box(hx0 + 4, hx0 + 7, deck + 36, deck + 44, -0.6, 0.6, P_METAL, MAST);
  const fc = pickc(r, FUNNELS);
  g.box(-128, -117, deck, deck + 24, -6, 6, P_FUNNEL, fc);
  g.box(-127.5, -117.5, deck + 24, deck + 26, -5.6, 5.6, P_METAL, BLACK);
  const hw = B / 2 - 1.3;
  const bay = (x: number, fwd: number) => {
    if (r() < 0.07 * (1.4 - load)) return;
    const base = Math.round(load * 8 * (1 - 0.45 * fwd * fwd));
    // three row groups across the beam give a ragged, real-looking stack
    const zs = [-hw, -hw / 3, hw / 3, hw];
    for (let k = 0; k < 3; k++) {
      const t = Math.max(0, Math.min(10, base + Math.round((r() - 0.5) * 3)));
      if (t > 0) g.box(x, x + 12.4, deck, deck + t * 2.6, zs[k], zs[k + 1], P_BOXES, [deck, 0, 0]);
    }
  };
  for (let x = Math.ceil(-114 / 13) * 13; x + 12.4 < hx0 - 1; x += 13) bay(x, 0);
  for (let x = Math.ceil((hx1 + 1) / 13) * 13; x + 12.4 < L / 2 - 28; x += 13) bay(x, Math.max(0, (x - 60) / 70));
  g.box(L / 2 - 14, L / 2 - 13, deck + 4, deck + 18, -0.5, 0.5, P_METAL, MAST);
  g.light(L / 2 - 13.5, deck + 18.5, 0, L_WHITE);
  g.light(hx0 + 5.5, deck + 44.5, 0, L_WHITE);
  g.light(hx0 + 9, deck + 36, -B / 2, L_RED);
  g.light(hx0 + 9, deck + 36, B / 2, L_GREEN);
  for (const x of [hx1 + 2, 0, 80]) g.light(x, deck + 30, 0, L_FLOOD);
  return g;
}

function tanker(r: Rand) {
  const L = 250, B = 44, deck = 7.8, g = new Geo(L, B, 14);
  g.hull(stations(L, B, { stern: 0.1, bow: 0.17, transom: 0.82, deck, fore: 3.2, bowFull: 2.6 }), -14, WHITE,
    pickc(r, ['#6e2b23', '#3e5b3e', '#5b5f5c', '#7a3a2a']));
  g.box(-L / 2 + 8, -L / 2 + 26, deck, deck + 19, -16, 16, P_HOUSE, WHITE);
  g.box(-L / 2 + 19, -L / 2 + 26, deck + 19, deck + 21.5, -21, 21, P_HOUSE, WHITE);
  g.box(-L / 2 + 14, -L / 2 + 17, deck + 21.5, deck + 30, -0.6, 0.6, P_METAL, MAST);
  const fc = pickc(r, FUNNELS);
  g.box(-L / 2 + 3, -L / 2 + 10, deck + 9, deck + 26, -4.5, 4.5, P_FUNNEL, fc);
  g.box(-L / 2 + 3.3, -L / 2 + 9.7, deck + 26, deck + 27.5, -4.2, 4.2, P_METAL, BLACK);
  g.box(-L / 2 + 28, L / 2 - 22, deck, deck + 1.6, -1.3, 1.3, P_METAL, STEEL);
  g.box(-7, 7, deck, deck + 2.2, -B / 2 + 3, B / 2 - 3, P_METAL, STEEL);
  g.box(-1, 1, deck, deck + 12, 7, 9, P_METAL, pickc(r, CRANES));
  g.box(-1, 14, deck + 11, deck + 12.2, 7.4, 8.6, P_METAL, pickc(r, CRANES));
  for (let x = -L / 2 + 40; x < L / 2 - 30; x += 21) {
    g.box(x, x + 2.4, deck, deck + 1.2, 5, 7.4, P_METAL, STEEL);
    g.box(x, x + 2.4, deck, deck + 1.2, -7.4, -5, P_METAL, STEEL);
  }
  g.box(L / 2 - 18, L / 2 - 17, deck + 3.2, deck + 16, -0.5, 0.5, P_METAL, MAST);
  g.light(L / 2 - 17.5, deck + 16.5, 0, L_WHITE);
  g.light(-L / 2 + 15.5, deck + 30.5, 0, L_WHITE);
  g.light(-L / 2 + 22, deck + 21.5, -21, L_RED);
  g.light(-L / 2 + 22, deck + 21.5, 21, L_GREEN);
  for (const x of [-L / 2 + 30, -10, 60]) g.light(x, deck + 14, 0, L_FLOOD);
  return g;
}

function bulker(r: Rand, geared: boolean) {
  const L = 230, B = 32, deck = 8.5, g = new Geo(L, B, 12);
  g.hull(stations(L, B, { stern: 0.1, bow: 0.16, transom: 0.8, deck, fore: 3, bowFull: 2.4 }), -12, WHITE,
    pickc(r, ['#5b3a2a', '#6e2b23', '#4b5048', '#3e5b3e']));
  g.box(-L / 2 + 8, -L / 2 + 22, deck, deck + 17, -12, 12, P_HOUSE, CREAM);
  g.box(-L / 2 + 16, -L / 2 + 22, deck + 17, deck + 19.5, -16, 16, P_HOUSE, CREAM);
  g.box(-L / 2 + 12, -L / 2 + 14.5, deck + 19.5, deck + 27, -0.5, 0.5, P_METAL, MAST);
  g.box(-L / 2 + 3, -L / 2 + 9, deck + 8, deck + 23, -3.5, 3.5, P_FUNNEL, pickc(r, FUNNELS));
  g.box(-L / 2 + 3.3, -L / 2 + 8.7, deck + 23, deck + 24.5, -3.2, 3.2, P_METAL, BLACK);
  const hc = pickc(r, ['#6e2b23', '#3e5b3e', '#5b6066', '#1f3a5f', '#8a5a2a', '#7a1f1c']);
  const cc = pickc(r, CRANES);
  for (let k = 0; k < 7; k++) {
    const x0 = -L / 2 + 28 + k * 24.5;
    g.box(x0, x0 + 17, deck, deck + 2.4, -11, 11, P_HATCH, hc);
    if (geared && k > 0 && k < 5) {
      const cx = x0 - 3.75;
      g.box(cx - 1.6, cx + 1.6, deck, deck + 13, -1.6, 1.6, P_METAL, cc);
      g.box(cx - 2.6, cx + 2.6, deck + 13, deck + 16, -2.6, 2.6, P_METAL, cc);
      g.box(cx + 2.6, cx + 24, deck + 14, deck + 15.1, -0.7, 0.7, P_METAL, cc);
    }
  }
  g.box(L / 2 - 14, L / 2 - 13, deck + 3, deck + 15, -0.5, 0.5, P_METAL, MAST);
  g.light(L / 2 - 13.5, deck + 15.5, 0, L_WHITE);
  g.light(-L / 2 + 13, deck + 27.5, 0, L_WHITE);
  g.light(-L / 2 + 19, deck + 19.5, -16, L_RED);
  g.light(-L / 2 + 19, deck + 19.5, 16, L_GREEN);
  for (const x of [-L / 2 + 26, 0, 60]) g.light(x, deck + 12, 0, L_FLOOD);
  return g;
}

function generalCargo(r: Rand, boxes: boolean) {
  const L = 130, B = 21, deck = 5.2, g = new Geo(L, B, 8);
  g.hull(stations(L, B, { stern: 0.12, bow: 0.2, transom: 0.8, deck, fore: 2.2, bowFull: 2.2 }), -8, WHITE,
    pickc(r, ['#5b3a2a', '#4b5048', '#6e2b23']));
  g.box(-L / 2 + 5, -L / 2 + 16, deck, deck + 11, -8.5, 8.5, P_HOUSE, WHITE);
  g.box(-L / 2 + 12, -L / 2 + 16, deck + 11, deck + 13, -10.5, 10.5, P_HOUSE, WHITE);
  g.box(-L / 2 + 2, -L / 2 + 6, deck + 6, deck + 15, -2, 2, P_FUNNEL, pickc(r, FUNNELS));
  const hc = pickc(r, ['#3e5b3e', '#5b6066', '#1f3a5f', '#8a5a2a']);
  const cc = pickc(r, CRANES);
  for (let k = 0; k < 3; k++) {
    const x0 = -L / 2 + 22 + k * 30;
    g.box(x0, x0 + 24, deck, deck + 2, -8, 8, P_HATCH, hc);
    if (boxes && r() < 0.8) {
      const t = 1 + Math.floor(r() * 3);
      g.box(x0 + 0.6, x0 + 13, deck + 2, deck + 2 + t * 2.6, -7.5, 7.5, P_BOXES, [deck + 2, 0, 0]);
    }
    if (k < 2) {
      const cx = x0 + 27;
      g.box(cx - 1.2, cx + 1.2, deck, deck + 10, -1.2, 1.2, P_METAL, cc);
      g.box(cx + 1.2, cx + 18, deck + 9, deck + 9.9, -0.5, 0.5, P_METAL, cc);
    }
  }
  g.box(L / 2 - 9, L / 2 - 8.3, deck + 2.2, deck + 11, -0.35, 0.35, P_METAL, MAST);
  g.light(L / 2 - 8.6, deck + 11.4, 0, L_WHITE);
  g.light(-L / 2 + 10, deck + 13.6, 0, L_WHITE);
  g.light(-L / 2 + 14, deck + 13, -10.5, L_RED);
  g.light(-L / 2 + 14, deck + 13, 10.5, L_GREEN);
  g.light(0, deck + 9, 0, L_FLOOD);
  return g;
}

function carCarrier(r: Rand) {
  const L = 200, B = 32, top = 28, g = new Geo(L, B, 9);
  g.hull(stations(L, B, { stern: 0.06, bow: 0.1, transom: 0.95, deck: top, fore: 0, bowFull: 3.5 }), -9, WHITE, lin('#5b5f62'));
  g.box(L / 2 - 26, L / 2 - 16, top, top + 3.6, -15, 15, P_HOUSE, WHITE);
  g.box(-L / 2 + 6, -L / 2 + 14, top, top + 7, -3, 3, P_FUNNEL, pickc(r, FUNNELS));
  g.box(L / 2 - 22, L / 2 - 21, top + 3.6, top + 10, -0.4, 0.4, P_METAL, MAST);
  g.light(L / 2 - 21.5, top + 10.5, 0, L_WHITE);
  g.light(-L / 2 + 4, top + 1, 0, L_WHITE);
  g.light(L / 2 - 20, top + 3.6, -15, L_RED);
  g.light(L / 2 - 20, top + 3.6, 15, L_GREEN);
  return g;
}

function tug(r: Rand) {
  const L = 30, B = 11, deck = 2.4, g = new Geo(L, B, 4);
  g.hull(stations(L, B, { stern: 0.22, bow: 0.4, transom: 0.85, deck, fore: 1.4, bowFull: 1.8 }), -4, WHITE, lin('#3a3d40'));
  g.box(-3, 8, deck, deck + 3.2, -4, 4, P_HOUSE, WHITE);
  g.box(1.5, 7.5, deck + 3.2, deck + 6, -3.4, 3.4, P_HOUSE, WHITE);
  g.box(4.2, 4.6, deck + 6, deck + 10.5, -0.2, 0.2, P_METAL, MAST);
  const fc = pickc(r, FUNNELS);
  g.box(-2.5, -1, deck + 3.2, deck + 6.2, -2.5, -1.2, P_FUNNEL, fc);
  g.box(-2.5, -1, deck + 3.2, deck + 6.2, 1.2, 2.5, P_FUNNEL, fc);
  g.box(L / 2 - 1.4, L / 2 + 0.3, 0, deck + 1.2, -2.2, 2.2, P_METAL, BLACK);
  g.light(4.4, deck + 10.8, 0, L_WHITE);
  g.light(6, deck + 6, -3.4, L_RED);
  g.light(6, deck + 6, 3.4, L_GREEN);
  g.light(-8, deck + 2, 0, L_FLOOD);
  return g;
}

function bunkerTanker(r: Rand) {
  const L = 95, B = 17, deck = 3.4, g = new Geo(L, B, 6);
  g.hull(stations(L, B, { stern: 0.12, bow: 0.2, transom: 0.82, deck, fore: 1.8, bowFull: 2.2 }), -6, WHITE,
    pickc(r, ['#6e2b23', '#3e5b3e', '#5b5f5c']));
  g.box(-L / 2 + 3, -L / 2 + 13, deck, deck + 8.4, -6.5, 6.5, P_HOUSE, WHITE);
  g.box(-L / 2 + 9, -L / 2 + 13, deck + 8.4, deck + 10.4, -8, 8, P_HOUSE, WHITE);
  g.box(-L / 2 + 1, -L / 2 + 4, deck + 5, deck + 13, -1.5, 1.5, P_FUNNEL, pickc(r, FUNNELS));
  g.box(-L / 2 + 15, L / 2 - 10, deck, deck + 1, -0.6, 0.6, P_METAL, STEEL);
  const cc = pickc(r, CRANES);
  g.box(-1, 1, deck, deck + 7, 3, 5, P_METAL, cc);
  g.box(-1, 9, deck + 6.4, deck + 7.2, 3.6, 4.4, P_METAL, cc);
  g.box(L / 2 - 7, L / 2 - 6.4, deck + 1.8, deck + 9, -0.3, 0.3, P_METAL, MAST);
  g.light(L / 2 - 6.7, deck + 9.3, 0, L_WHITE);
  g.light(-L / 2 + 11, deck + 10.4, -8, L_RED);
  g.light(-L / 2 + 11, deck + 10.4, 8, L_GREEN);
  g.light(0, deck + 7, 0, L_FLOOD);
  return g;
}

function ferry() {
  const L = 40, B = 11, deck = 2.6, g = new Geo(L, B, 1.6);
  g.hull(stations(L, B, { stern: 0.05, bow: 0.3, transom: 0.95, deck, fore: 0.6, bowFull: 1.6 }), -1.6, WHITE, lin('#6b6f72'));
  g.box(-17, 12, deck, deck + 3.2, -5.2, 5.2, P_GLASS, WHITE);
  g.box(-10, 7, deck + 3.2, deck + 5.6, -4.6, 4.6, P_GLASS, WHITE);
  g.box(7, 10.5, deck + 3.2, deck + 5.4, -3.2, 3.2, P_HOUSE, WHITE);
  g.box(2, 2.4, deck + 5.6, deck + 8.2, -0.15, 0.15, P_METAL, MAST);
  g.light(2.2, deck + 8.4, 0, L_WHITE);
  g.light(9, deck + 5.4, -3.2, L_RED);
  g.light(9, deck + 5.4, 3.2, L_GREEN);
  return g;
}

function bumboat(r: Rand) {
  const L = 12, B = 3.2, deck = 0.7, g = new Geo(L, B, 0.6);
  g.hull(stations(L, B, { stern: 0.2, bow: 0.35, transom: 0.7, deck, fore: 0.4, bowFull: 1.6 }), -0.6, WHITE, lin('#6b5038'));
  g.box(-3.8, 3.5, 2.1, 2.28, -1.45, 1.45, P_HATCH, pickc(r, ['#2f5f8f', '#8f2f2a', '#3f6f4f', '#d0c9b8']));
  for (const [px, pz] of [[-3.6, -1.3], [-3.6, 1.3], [3.3, -1.3], [3.3, 1.3]]) g.box(px - 0.06, px + 0.06, deck, 2.1, pz - 0.06, pz + 0.06, P_METAL, BLACK);
  g.box(-5.6, -4.6, deck, deck + 0.6, -0.5, 0.5, P_METAL, BLACK);
  g.light(3.4, 2.4, 0, L_WHITE);
  return g;
}

function frigate() {
  const L = 115, B = 15, deck = 6, g = new Geo(L, B, 4.5);
  const grey = lin('#7a8086'), dark = lin('#5d6267');
  g.hull(stations(L, B, { stern: 0.15, bow: 0.3, transom: 0.85, deck, fore: 1.5, bowFull: 1.7 }), -4.5, grey, lin('#4b5056'));
  g.box(-24, 20, deck, deck + 7, -6.5, 6.5, P_HOUSE, grey);
  g.box(-34, -24, deck, deck + 5.5, -6, 6, P_HOUSE, grey);
  g.box(10, 20, deck + 7, deck + 10.5, -6, 6, P_HOUSE, grey);
  g.box(5, 9, deck + 10.5, deck + 16, -1.6, 1.6, P_METAL, grey);
  g.box(6.5, 7.5, deck + 16, deck + 25, -0.4, 0.4, P_METAL, grey);
  g.box(-10, -3, deck + 7, deck + 12.5, -2.6, 2.6, P_FUNNEL, dark);
  g.box(30, 34, deck, deck + 2.2, -1.6, 1.6, P_METAL, grey);
  g.box(34, 41, deck + 1.2, deck + 1.6, -0.2, 0.2, P_METAL, dark);
  g.light(7, deck + 25.4, 0, L_WHITE);
  g.light(15, deck + 10.5, -6, L_RED);
  g.light(15, deck + 10.5, 6, L_GREEN);
  return g;
}

interface Design {
  type: number; geo: Geo; mesh: THREE.InstancedMesh; seeds: THREE.InstancedBufferAttribute; n: number;
  // master copies; each frame the visible ships are compacted into the instance buffers
  mats: Float32Array; cols: Float32Array; seed: Float32Array; sphere: Float32Array; hidden: Uint8Array;
}

const HULLS: Record<number, string[]> = {
  [CONTAINER]: ['#1d2a3a', '#2a2d33', '#7a1f1c', '#1f3a5f', '#3c4f3a', '#14181c', '#4a4f57', '#24456b'],
  [TANKER]: ['#1a1c1f', '#7a1f1c', '#203a2b', '#1f3a5f', '#2b2d33', '#5a2020'],
  [BULK]: ['#1a1c1f', '#7a1f1c', '#2a3b4c', '#3a3f45', '#5b2a22', '#26392b'],
  [CARGO]: ['#2a5b8c', '#2b2d33', '#7a1f1c', '#3c6e3c', '#9a9a92', '#1f3a5f'],
  [TUG]: ['#b5291f', '#1f3a5f', '#1a1c1f', '#d47a1a', '#2d6e8c'],
  [BUNKER]: ['#1a1c1f', '#7a1f1c', '#1f3a5f', '#3c4f3a'],
  [FERRY]: ['#e9ecee', '#f2f2ef', '#dfe6ea'],
  [BUMBOAT]: ['#7a5a3a', '#2f5f8f', '#8f2f2a', '#3f6f4f'],
  [NAVAL]: ['#6f757a', '#767c81'],
  [CARCARRIER]: ['#e8e8e4', '#1f3a5f', '#2b2d33', '#7a1f1c', '#e2e4e6'],
};

const VS = /* glsl */ `
in float aPart;
in vec3 aCol;
in float aSeed;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vLocal;
out vec3 vCol;
out vec3 vHull;
flat out float vPart;
flat out float vSeed;
${CURVATURE}
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vLocal = position;
  vCol = aCol;
#ifdef USE_INSTANCING_COLOR
  vHull = instanceColor;
#else
  vHull = vec3(0.1);
#endif
  vPart = aPart;
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(wp.xyz), 1.0);
}
`;

const FS = /* glsl */ `
in vec3 vWorld;
in vec3 vNormal;
in vec3 vLocal;
in vec3 vCol;
in vec3 vHull;
flat in float vPart;
flat in float vSeed;
out vec4 fragColor;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${SHADOWS}
${LIGHTING}
float box1(float x, float a, float b, float w) { return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x); }
vec3 containerColour(float h) {
  return h < 0.16 ? vec3(0.03, 0.09, 0.22) : h < 0.28 ? vec3(0.30, 0.04, 0.035) : h < 0.38 ? vec3(0.55, 0.55, 0.52)
       : h < 0.46 ? vec3(0.05, 0.17, 0.06) : h < 0.54 ? vec3(0.50, 0.30, 0.04) : h < 0.64 ? vec3(0.13, 0.14, 0.15)
       : h < 0.72 ? vec3(0.17, 0.08, 0.035) : h < 0.80 ? vec3(0.06, 0.26, 0.45) : h < 0.90 ? vec3(0.62, 0.17, 0.035) : vec3(0.012);
}
void main() {
  vec3 wp = vWorld;
  if (uReflectPass > 0.5 && wp.y < -0.3) discard;
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  int part = int(vPart + 0.5);
  vec3 albedo = vCol;
  float rough = 0.6, f0 = 0.04;
  vec3 emis = vec3(0.0);
  float flood = 0.6;      // share of the night deck floodlighting this surface catches
  float fw = max(fwidth(vLocal.x), fwidth(vLocal.y));
  if (part == 0) {
    // hull: antifouling red below the laden waterline (ships in ballast show it), weathered paint above
    float st = vnoise(vec2(vLocal.x * 0.7 + vSeed * 50.0, vLocal.y * 0.15));
    albedo = vLocal.y < 0.0 ? vec3(0.13, 0.025, 0.02) : vHull;
    albedo *= 0.82 + 0.3 * st;
    // a pale boot-top line at the waterline and a rust-streaked band along the deck edge
    albedo = mix(albedo, vec3(0.45), box1(vLocal.y, -0.25, 0.25, fw) * 0.6);
    rough = 0.5;
    flood = 0.12;
  } else if (part == 2 || part == 8) {
    // deckhouse / ferry cabins: rows of windows on the walls
    if (abs(N.y) < 0.5) {
      float u = (abs(N.x) > abs(N.z) ? vLocal.z : vLocal.x) / 1.7;
      float fy = fract(vLocal.y / 2.8);
      float wu = fwidth(u) * 1.2 + 1e-3, wv = fwidth(vLocal.y / 2.8) * 1.2 + 1e-3;
      float w = part == 8 ? box1(fy, 0.25, 0.85, wv) : box1(fract(u), 0.2, 0.8, wu) * box1(fy, 0.4, 0.75, wv);
      float detail = smoothstep(1.0, 0.25, fwidth(u));
      w = mix(part == 8 ? 0.6 : 0.2, w, detail);
      albedo = mix(albedo, vec3(0.018, 0.022, 0.026), w);
      rough = mix(rough, 0.12, w);
      f0 = mix(f0, 0.06, w);
      float lit = step(0.3, hash13(vec3(floor(u), floor(vLocal.y / 2.8), vSeed * 91.0)));
      emis += vec3(1.0, 0.8, 0.55) * w * mix(0.65, lit, detail) * 1.2;
    }
    flood = 0.8;
  } else if (part == 4) {
    // container stacks: 40' boxes (6.2 m per 20' half), 2.6 m tiers, 2.5 m rows; aCol.x = stack base
    float bx = vLocal.x / 13.0;
    float fb = fract(bx) * 13.0;
    float ci = floor(bx) * 2.0 + step(6.2, fb);
    float ti = floor((vLocal.y - vCol.x) / 2.6);
    float zi = floor(vLocal.z / 2.5);
    float h = hash13(vec3(ci, ti, zi) + vSeed * 13.7);
    vec3 c = containerColour(h) * (0.85 + 0.3 * hash13(vec3(zi, ci, ti) + 3.1));
    float wz = fwidth(vLocal.z / 2.5) + 1e-3, wy = fwidth((vLocal.y - vCol.x) / 2.6) + 1e-3, wx = fwidth(fb / 6.2) + 1e-3;
    float seam = (1.0 - box1(fract((vLocal.y - vCol.x) / 2.6), 0.04, 0.96, wy))
               + (abs(N.x) > 0.5 ? 1.0 - box1(fract(vLocal.z / 2.5), 0.05, 0.95, wz) : 1.0 - box1(fract(fb / 6.2), 0.02, 0.98, wx));
    float rib = abs(N.z) > 0.5 ? 0.9 + 0.1 * sin(vLocal.x * 20.0) : 1.0;
    // seams vanish first; the patchwork of box colours survives until boxes are sub-pixel
    float seams = smoothstep(1.2, 0.4, fw);
    float boxes = smoothstep(7.0, 3.0, fw);
    albedo = mix(vec3(0.23, 0.17, 0.155), c * rib * (1.0 - 0.6 * saturate(seam) * seams), boxes);
    rough = 0.55;
    flood = 0.5;
  } else if (part == 7) {
    // hatch covers: panel seams
    float s = 1.0 - box1(fract(vLocal.x / 4.2), 0.03, 0.97, fwidth(vLocal.x / 4.2) + 1e-3);
    albedo *= 1.0 - 0.35 * s * smoothstep(1.0, 0.3, fw);
    rough = 0.55;
  } else if (part == 1) {
    albedo *= 0.85 + 0.25 * vnoise(vLocal.xz * 0.3 + vSeed * 20.0);
    rough = 0.75;
  } else if (part == 5) {
    rough = 0.45; f0 = 0.05;
  }
  float sh = sunShadow(wp, N, dist);
  vec3 col = shadeSurface(albedo, N, V, rough, f0, sh, 0.85, wp);
  if (part == 2 || part == 8) {
    vec3 R = reflect(-V, N);
    vec3 env = skyRadiance(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
    col += env * (f0 + (1.0 - f0) * pow(1.0 - max(dot(N, V), 0.0), 5.0)) * 0.35;
  }
  // night: deck floodlights (sodium / LED) wash the decks and superstructure; lit cabins
  float night = uNight * uSunIntensity * 0.0075;
  col += albedo * vec3(1.0, 0.78, 0.5) * flood * night * 0.7;
  col += emis * night;
  col = applyAerial(col, wp);
  fragColor = vec4(col, 1.0);
}
`;

// ------------------------------------------------------------------- wakes
const WAKE_VS = /* glsl */ `
out vec2 vP;          // metres in the ship frame: x forward from midship, y to starboard
out vec3 vWorld;
flat out vec3 vShip;  // length, beam, speed
${CURVATURE}
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
#ifdef USE_INSTANCING_COLOR
  vShip = instanceColor;
#else
  vShip = vec3(100.0, 20.0, 5.0);
#endif
  // quad spans from the bow to far astern; express it in metres from midship
  float len = length(instanceMatrix[0].xyz);
  vP = vec2(position.x * len + vShip.x * 0.5 - len * 0.5, position.z * length(instanceMatrix[2].xyz));
  gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(wp.xyz), 1.0);
}
`;

const WAKE_FS = /* glsl */ `
in vec2 vP;
in vec3 vWorld;
flat in vec3 vShip;
out vec4 fragColor;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
void main() {
  float L = vShip.x, B = vShip.y, v = vShip.z;
  float x = vP.x, z = abs(vP.y);
  float behind = -L * 0.5 - x;              // metres astern of the transom
  float fromBow = L * 0.5 - x;
  float t = uTime;
  // turbulent wash straight astern, spreading and dying away
  float w = B * 0.4 + max(behind, 0.0) * 0.018;
  float decay = exp(-max(behind, 0.0) / (L * (0.35 + 0.08 * v)));
  float n = fbm(vec2(x * 0.045 + t * v * 0.045, vP.y * 0.12));
  float wash = smoothstep(w, w * 0.25, z) * decay * step(-L * 0.5 - 4.0, -x) * (0.45 + 0.75 * n);
  // Kelvin arms (19.5 deg) from the bow, thin and fading
  float zArm = fromBow * 0.354 + B * 0.3;
  float arm = exp(-sq((z - zArm) / (2.5 + fromBow * 0.02))) * exp(-fromBow / (L * 1.1)) * step(0.0, fromBow);
  arm *= 0.35 + 0.65 * fbm(vec2(fromBow * 0.06 - t * 0.3, z * 0.2));
  // bow wave hugging the hull sides
  float hullB = B * 0.5 * (1.0 - smoothstep(L * 0.3, L * 0.5, x));
  float bow = exp(-max(z - hullB, 0.0) / 2.5) * step(hullB - 0.5, z) * smoothstep(-L * 0.5, L * 0.2, x) * 0.6;
  float a = saturate(wash * 0.42 + arm * 0.2 + bow * 0.7) * saturate(v / 4.0);
  if (a < 0.003) discard;
  vec3 up = vec3(0.0, 1.0, 0.0);
  // churned water: whitish foam over a lighter, aerated turquoise
  vec3 alb = mix(vec3(0.16, 0.3, 0.3), vec3(0.75), saturate(wash * 0.8 + bow));
  vec3 foam = alb * (sunLight() * max(uSunDir.y, 0.0) + ambientCube(up)) / PI + alb * uMoonLight * 0.3;
  vec3 col = applyAerial(foam, vWorld);
  fragColor = vec4(col * a, a);
}
`;

// ------------------------------------------------------------------- lights (points)
const LIGHT_VS = /* glsl */ `
in vec3 aColor;
in float aSize;
out vec3 vColor;
uniform float uPxScale;
${COMMON}
${ATMO_PARAMS}
${ATMO_RUNTIME}
${CURVATURE}
void main() {
  vec4 mv = viewMatrix * vec4(applyCurvature(position), 1.0);
  float d = max(-mv.z, 1.0);
  float px = aSize * uPxScale / d;
  float s = max(px, 1.5);
  vec3 v = position - cameraPosition;
  vec3 T = exp(-opticalDepth(uCamAltKm, max(position.y, 0.0) * 0.001, length(v) * 0.001));
  // sub-pixel lights keep their total energy instead of growing brighter
  vColor = aColor * T * min(1.0, px * px / (s * s) * 3.0 + 0.04) * uNight * uSunIntensity * 0.0075;
  gl_PointSize = s * 2.2;
  gl_Position = projectionMatrix * mv;
}
`;
const LIGHT_FS = /* glsl */ `
in vec3 vColor;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 14.0);
  float halo = exp(-r2 * 4.0) * 0.05;
  fragColor = vec4(vColor * (core + halo), 1.0);
}
`;

interface Mover {
  design: Design; slot: number; route: Route; s0: number; v: number; off: number;
  ferry: boolean; L: number; B: number; wake: number; lights: number; ballast: number;
}
interface Route { pts: Float32Array; cum: Float32Array; len: number; kind: string; craft: number; speed: number; name: string }
interface Anchored {
  design: Design; slot: number; x: number; z: number; L: number; B: number; jitter: number; turn: number;
  ballast: number; lights: number; buddy?: Anchored; alongside?: boolean;
}

export class Ships {
  group = new THREE.Group();
  material: THREE.ShaderMaterial;
  depth: THREE.ShaderMaterial;
  private designs: Design[] = [];
  private byType = new Map<number, Design[]>();
  private anchored: Anchored[] = [];
  private movers: Mover[] = [];
  private wakes!: THREE.InstancedMesh;
  private lightPts!: THREE.Points;
  private lightPos!: Float32Array;
  private lightCol!: Float32Array;
  private lightSize!: Float32Array;
  private lightCount = 0;
  private lightMat!: THREE.ShaderMaterial;
  private m = new THREE.Matrix4();
  private c = new THREE.Color();
  private lastHeadingKey = '';
  loaded = false;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: U, side: THREE.DoubleSide,
    });
    this.depth = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'void main(){ gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }',
      fragmentShader: 'out vec4 c; void main(){ c = vec4(1.0); }', colorWrite: false, side: THREE.DoubleSide,
    });
  }

  async load() {
    const res = await fetch(DATA_BASE + 'maritime.json');
    if (!res.ok) return;
    const data = await res.json() as {
      ships: number[][]; routes: { name: string; kind: string; craft: number; speed: number; pts: number[][] }[];
    };
    const r = rng(20240611);

    // routes in world space (x east, z = -north)
    const routes: Route[] = data.routes.map((rt) => {
      const n = rt.pts.length;
      const pts = new Float32Array(n * 2), cum = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        pts[i * 2] = rt.pts[i][0];
        pts[i * 2 + 1] = -rt.pts[i][1];
        if (i) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
      }
      return { pts, cum, len: cum[n - 1], kind: rt.kind, craft: rt.craft, speed: rt.speed, name: rt.name };
    });

    // plan every ship first (design + role), then size the instanced meshes
    const designsFor = (type: number): number => (type === CONTAINER || type === TANKER || type === BULK ? 3 : type === CARGO ? 2 : 1);
    const plan: { type: number; variant: number; role: 'anchor' | 'buddy' | 'move'; data: number[] | null; route?: Route }[] = [];
    for (const s of data.ships) {
      plan.push({ type: s[2], variant: Math.floor(r() * designsFor(s[2])), role: 'anchor', data: s });
      if (s[5]) plan.push({ type: BUNKER, variant: 0, role: 'buddy', data: s });
    }
    const TSS_MIX: [number, number][] = [[CONTAINER, 0.38], [TANKER, 0.27], [BULK, 0.2], [CARGO, 0.08], [CARCARRIER, 0.07]];
    for (const rt of routes) {
      if (rt.kind === 'tss') {
        const n = Math.floor(rt.len / 1700);
        for (let i = 0; i < n; i++) {
          let x = r(), type = CONTAINER;
          for (const [t, w] of TSS_MIX) { if (x < w) { type = t; break; } x -= w; }
          plan.push({ type, variant: Math.floor(r() * designsFor(type)), role: 'move', data: [i], route: rt });
        }
      } else {
        const n = rt.len > 25000 ? 2 : 1;
        for (let i = 0; i < n; i++) plan.push({ type: rt.craft, variant: 0, role: 'move', data: [i, n], route: rt });
      }
    }

    // build designs
    const builders: Record<number, (v: number) => Geo> = {
      [CONTAINER]: (v) => containerShip(rng(11 + v), [0.95, 0.7, 0.45][v]),
      [TANKER]: (v) => tanker(rng(21 + v)),
      [BULK]: (v) => bulker(rng(31 + v), v === 2),
      [CARGO]: (v) => generalCargo(rng(41 + v), v === 1),
      [TUG]: () => tug(rng(51)),
      [BUNKER]: () => bunkerTanker(rng(61)),
      [FERRY]: () => ferry(),
      [BUMBOAT]: () => bumboat(rng(71)),
      [NAVAL]: () => frigate(),
      [CARCARRIER]: () => carCarrier(rng(81)),
    };
    const counts = new Map<string, number>();
    for (const p of plan) counts.set(`${p.type}:${p.variant}`, (counts.get(`${p.type}:${p.variant}`) || 0) + 1);
    const designOf = new Map<string, Design>();
    for (const [key, n] of counts) {
      const [type, variant] = key.split(':').map(Number);
      const geo = builders[type](variant);
      const g = geo.geometry();
      const seeds = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
      g.setAttribute('aSeed', seeds);
      const mesh = new THREE.InstancedMesh(g, this.material, n);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this.c.setRGB(0, 0, 0));
      mesh.count = n;
      const d: Design = {
        type, geo, mesh, seeds, n: 0, mats: new Float32Array(n * 16), cols: new Float32Array(n * 3),
        seed: new Float32Array(n), sphere: new Float32Array(n * 4), hidden: new Uint8Array(n),
      };
      this.designs.push(d);
      if (!this.byType.has(type)) this.byType.set(type, []);
      this.byType.get(type)!.push(d);
      designOf.set(key, d);
      this.group.add(mesh);
    }

    // lights buffer: every ship's lights, positions refreshed as ships move or swing
    let nl = 0;
    for (const p of plan) nl += designOf.get(`${p.type}:${p.variant}`)!.geo.lights.length;
    this.lightPos = new Float32Array(nl * 3);
    this.lightCol = new Float32Array(nl * 3);
    this.lightSize = new Float32Array(nl);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.lightPos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('aColor', new THREE.BufferAttribute(this.lightCol, 3));
    lg.setAttribute('aSize', new THREE.BufferAttribute(this.lightSize, 1));
    this.lightMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: LIGHT_VS, fragmentShader: LIGHT_FS,
      uniforms: { ...U, uPxScale: { value: 800 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.lightPts = new THREE.Points(lg, this.lightMat);
    this.lightPts.frustumCulled = false;
    this.lightPts.renderOrder = 5;
    this.group.add(this.lightPts);

    // wakes: one quad per moving ship, spanning bow to far astern
    const nMove = plan.filter((p) => p.role === 'move').length;
    const wg = new THREE.PlaneGeometry(1, 1, 1, 1);
    wg.rotateX(-Math.PI / 2);
    const wakeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: WAKE_VS, fragmentShader: WAKE_FS, uniforms: U,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.wakes = new THREE.InstancedMesh(wg, wakeMat, Math.max(1, nMove));
    this.wakes.frustumCulled = false;
    this.wakes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wakes.setColorAt(0, this.c.setRGB(0, 0, 0));
    this.wakes.renderOrder = 2;
    this.group.add(this.wakes);

    // instantiate
    let li = 0;
    const lightKinds: [number, number, number, number][] = [
      [4.0, 3.8, 3.4, 1.4],      // white anchor / masthead
      [4.0, 0.25, 0.15, 1.2],    // red (port)
      [0.2, 4.0, 1.6, 1.2],      // green (starboard)
      [1.8, 1.25, 0.65, 3.5],    // warm deck floodlight
    ];
    const addLights = (d: Design, scale: number) => {
      const first = li;
      for (const l of d.geo.lights) {
        const k = lightKinds[l.kind];
        this.lightCol.set([k[0], k[1], k[2]], li * 3);
        this.lightSize[li] = k[3] * Math.sqrt(scale);
        li++;
      }
      return first;
    };
    const place = (d: Design, seed: number, hull: string) => {
      const slot = d.n++;
      d.seed[slot] = seed;
      this.c.set(hull);
      d.cols.set([this.c.r, this.c.g, this.c.b], slot * 3);
      return slot;
    };
    let wi = 0;
    const anchorByShip = new Map<number[], Anchored>();
    for (const p of plan) {
      const d = designOf.get(`${p.type}:${p.variant}`)!;
      const hulls = HULLS[p.type];
      const hull = hulls[Math.floor(r() * hulls.length)];
      if (p.role === 'anchor') {
        const s = p.data!;
        const scale = s[3] / d.geo.L;
        const a: Anchored = {
          design: d, slot: place(d, s[4], hull), x: s[0], z: -s[1], L: s[3], B: d.geo.B * scale,
          jitter: (r() - 0.5) * 0.45, turn: r() < 0.5 ? 1 : -1,
          ballast: r() < 0.55 ? d.geo.draft * scale * (0.25 + 0.3 * r()) : 0, lights: addLights(d, scale),
        };
        this.anchored.push(a);
        anchorByShip.set(s, a);
      } else if (p.role === 'buddy') {
        const s = p.data!;
        const host = anchorByShip.get(s)!;
        const L = 75 + r() * 30;
        const scale = L / d.geo.L;
        const b: Anchored = {
          design: d, slot: place(d, r(), hull), x: host.x, z: host.z, L, B: d.geo.B * scale,
          jitter: host.jitter, turn: host.turn, ballast: 0, lights: addLights(d, scale), alongside: true,
        };
        host.buddy = b;
        this.anchored.push(b);
      } else {
        const rt = p.route!;
        const lo = [210, 180, 180, 95, 24, 60, 34, 9, 95, 170][p.type], hi = [400, 333, 292, 165, 36, 115, 46, 14, 140, 200][p.type];
        const L = lo + (hi - lo) * r();
        const scale = L / d.geo.L;
        const ferryRoute = rt.kind === 'ferry';
        const [i, n] = p.data!;
        this.movers.push({
          design: d, slot: place(d, r(), hull), route: rt,
          s0: ferryRoute ? (i / (n || 1)) : (i + 0.15 + 0.7 * r()) * 1700,
          v: ferryRoute ? rt.speed : 5.5 + r() * 3.0,
          off: ferryRoute ? 0 : (r() - 0.5) * 500,
          ferry: ferryRoute, L, B: d.geo.B * scale, wake: wi++, lights: addLights(d, scale),
          ballast: !ferryRoute && r() < 0.35 ? d.geo.draft * scale * (0.2 + 0.25 * r()) : 0,
        });
      }
    }
    this.lightCount = li;
    lg.setDrawRange(0, li);
    for (const d of this.designs) d.mesh.count = 0;
    this.wakes.count = wi;
    this.loaded = true;
  }

  /** world matrix for a ship at (x, z) heading (hx, hz), length scale s, raised by `rise` */
  private setShip(d: Design, slot: number, x: number, z: number, hx: number, hz: number, s: number, rise: number) {
    // column-major, as three.js stores it
    const m = d.mats, o = slot * 16;
    m[o] = hx * s; m[o + 1] = 0; m[o + 2] = hz * s; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = s; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = -hz * s; m[o + 9] = 0; m[o + 10] = hx * s; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = rise; m[o + 14] = z; m[o + 15] = 1;
    d.sphere[slot * 4] = x; d.sphere[slot * 4 + 1] = rise + d.geo.L * s * 0.05; d.sphere[slot * 4 + 2] = z;
    d.sphere[slot * 4 + 3] = d.geo.L * s * 0.55;
    d.hidden[slot] = 0;
  }

  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sph = new THREE.Sphere();

  /** Copy the ships that can be seen into the front of each instance buffer. */
  private compact(camera: THREE.Camera, maxDist: number) {
    camera.updateMatrixWorld();
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const cp = camera.position;
    for (const d of this.designs) {
      const im = d.mesh.instanceMatrix.array as Float32Array;
      const ic = d.mesh.instanceColor!.array as Float32Array;
      const is = d.seeds.array as Float32Array;
      let n = 0;
      for (let i = 0; i < d.n; i++) {
        if (d.hidden[i]) continue;
        const sx = d.sphere[i * 4], sy = d.sphere[i * 4 + 1], sz = d.sphere[i * 4 + 2], r = d.sphere[i * 4 + 3];
        const dist = Math.hypot(sx - cp.x, sy - cp.y, sz - cp.z);
        // beyond ~4 px wide (and the haze) a ship is not worth its triangles
        if (dist - r > Math.min(maxDist, r * 900)) continue;
        this.sph.center.set(sx, sy, sz);
        this.sph.radius = r;
        if (!this.frustum.intersectsSphere(this.sph)) continue;
        im.set(d.mats.subarray(i * 16, i * 16 + 16), n * 16);
        ic[n * 3] = d.cols[i * 3]; ic[n * 3 + 1] = d.cols[i * 3 + 1]; ic[n * 3 + 2] = d.cols[i * 3 + 2];
        is[n] = d.seed[i];
        n++;
      }
      d.mesh.count = n;
      d.mesh.instanceMatrix.needsUpdate = true;
      d.mesh.instanceColor!.needsUpdate = true;
      d.seeds.needsUpdate = true;
    }
  }

  private setLights(first: number, d: Design, x: number, z: number, hx: number, hz: number, s: number, rise: number, nav: boolean) {
    const lights = d.geo.lights;
    for (let k = 0; k < lights.length; k++) {
      const l = lights[k];
      const i = (first + k) * 3;
      const lx = l.p[0] * s, ly = l.p[1] * s + rise, lz = l.p[2] * s;
      this.lightPos[i] = x + hx * lx - hz * lz;
      this.lightPos[i + 1] = (l.kind === L_RED || l.kind === L_GREEN) && !nav ? -1e5 : ly;
      this.lightPos[i + 2] = z + hz * lx + hx * lz;
    }
  }

  private routePoint(rt: Route, s: number, out: Float32Array) {
    s = Math.max(0, Math.min(rt.len, s));
    const c = rt.cum, n = c.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
    const t = (s - c[lo]) / Math.max(c[hi] - c[lo], 1e-3);
    out[0] = rt.pts[lo * 2] + (rt.pts[hi * 2] - rt.pts[lo * 2]) * t;
    out[1] = rt.pts[lo * 2 + 1] + (rt.pts[hi * 2 + 1] - rt.pts[lo * 2 + 1]) * t;
  }

  private pa = new Float32Array(2);
  private pb = new Float32Array(2);

  /**
   * t: simulation seconds; hour: local hour; epochHours: hours since 2000-01-01 (tide phase);
   * pxScale: viewport height / (2 tan(fov/2)) for light sprite sizing.
   */
  update(t: number, epochHours: number, hour: number, pxScale: number, camera: THREE.Camera, maxDist = 60000) {
    if (!this.loaded) return;
    this.lightMat.uniforms.uPxScale.value = pxScale;

    // tidal stream along the strait (axis ~10 deg north of east), turning every ~6.2 h;
    // anchored ships lie head to the stream and swing round together at the turn
    const phase = (epochHours / 12.42) * Math.PI * 2;
    const flow = Math.sin(phase);
    const w = smooth((flow + 0.22) / 0.44);
    const key = w.toFixed(4);
    if (key !== this.lastHeadingKey) {
      this.lastHeadingKey = key;
      const axis = 10 * Math.PI / 180;
      for (const a of this.anchored) {
        if (a.alongside) continue;     // placed with its host below
        const ang = axis + a.jitter + a.turn * Math.PI * w;
        const hx = Math.cos(ang), hz = -Math.sin(ang);
        const s = a.L / a.design.geo.L;
        this.setShip(a.design, a.slot, a.x, a.z, hx, hz, s, a.ballast);
        this.setLights(a.lights, a.design, a.x, a.z, hx, hz, s, a.ballast, false);
        if (a.buddy) {
          const b = a.buddy;
          const off = a.B / 2 + b.B / 2 + 1.5;
          const bx = a.x - hz * off, bz = a.z + hx * off;
          const bs = b.L / b.design.geo.L;
          this.setShip(b.design, b.slot, bx, bz, hx, hz, bs, 0);
          this.setLights(b.lights, b.design, bx, bz, hx, hz, bs, 0, false);
        }
      }
    }

    const ferriesRun = hour > 6.3 && hour < 22.8;
    for (const mv of this.movers) {
      const rt = mv.route;
      let s: number, dir = 1, visible = true, speed = mv.v;
      if (mv.ferry) {
        const dwell = 600;
        const leg = rt.len / mv.v;
        const period = 2 * (leg + dwell);
        let ph = (t + mv.s0 * period) % period;
        if (ph < leg) s = ph * mv.v;
        else if (ph < leg + dwell) { s = rt.len; speed = 0; }
        else if (ph < 2 * leg + dwell) { ph -= leg + dwell; s = rt.len - ph * mv.v; dir = -1; }
        else { s = 0; speed = 0; dir = -1; }
        visible = ferriesRun;
      } else {
        s = (mv.s0 + t * mv.v) % rt.len;
      }
      const look = Math.max(mv.L * 0.6, 30);
      this.routePoint(rt, s - look * dir, this.pa);
      this.routePoint(rt, s + look * dir, this.pb);
      let hx = this.pb[0] - this.pa[0], hz = this.pb[1] - this.pa[1];
      const hl = Math.hypot(hx, hz) || 1;
      hx /= hl; hz /= hl;
      // lateral position in the lane (starboard of the centreline is +)
      const x = (this.pa[0] + this.pb[0]) / 2 - hz * mv.off;
      const z = (this.pa[1] + this.pb[1]) / 2 + hx * mv.off;
      const sc = mv.L / mv.design.geo.L;
      if (!visible) {
        mv.design.hidden[mv.slot] = 1;
        this.m.makeScale(0, 0, 0);
        this.wakes.setMatrixAt(mv.wake, this.m);
        this.setLights(mv.lights, mv.design, 0, 0, 1, 0, 0, -1e5, false);
        continue;
      }
      this.setShip(mv.design, mv.slot, x, z, hx, hz, sc, mv.ballast);
      this.setLights(mv.lights, mv.design, x, z, hx, hz, sc, mv.ballast, true);
      // wake quad: from the bow to ~(2 + 0.35 v) lengths astern, wide enough for the Kelvin arms
      const back = mv.L * (1.6 + 0.35 * speed), front = mv.L * 0.5;
      const len = back + front;
      const half = mv.B * 0.5 + len * 0.36;
      const cx = x + hx * (front - len / 2), cz = z + hz * (front - len / 2);
      this.m.set(hx * len, 0, -hz * half * 2, cx, 0, 1, 0, 0.15, hz * len, 0, hx * half * 2, cz, 0, 0, 0, 1);
      this.wakes.setMatrixAt(mv.wake, this.m);
      this.wakes.setColorAt(mv.wake, this.c.setRGB(mv.L, mv.B, speed));
    }
    this.compact(camera, maxDist);
    this.wakes.instanceMatrix.needsUpdate = true;
    if (this.wakes.instanceColor) this.wakes.instanceColor.needsUpdate = true;
    (this.lightPts.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.lightPts.visible = U.uNight.value > 0.02;
  }

  setDepthMode(on: boolean) {
    for (const d of this.designs) d.mesh.material = on ? this.depth : this.material;
    this.wakes.visible = !on;
    if (this.lightPts) this.lightPts.visible = !on && U.uNight.value > 0.02;
  }
}
