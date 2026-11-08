// Decoder for the binary bundles written by pipeline/sgpipe/bundles.py.
export const MAGIC = 0x31424753;
export const Q = 1 / 16;
export const SECTION = { buildings: 0, roads: 1, rails: 2, areas: 3, water: 4, trees: 5 } as const;

export interface Ring { xs: Float64Array; ys: Float64Array }   // pipeline frame: x east, y north (tile-relative m)

export interface BuildingRec {
  cls: number; roof: number; flags: number; levels: number;
  h: number; minh: number; roofH: number;
  wall: number; roofCol: number; seed: number;
  name: string | null; addr: string | null;
  rings: Ring[];
}
export interface LineRec {
  cls: number; flags: number; width: number; lanes: number; layer: number; region: number;
  name: string | null; xs: Float64Array; ys: Float64Array; elev: Float32Array | null;
}
export interface AreaRec { kind: number; flags: number; level: number; name: string | null; rings: Ring[] }

export class Bundle {
  dv: DataView;
  strings: string[] = [];
  table: Uint32Array;
  bx: number; by: number;

  constructor(public buf: ArrayBuffer) {
    this.dv = new DataView(buf);
    const magic = this.dv.getUint32(0, true);
    if (magic !== MAGIC) throw new Error('bad bundle magic');
    this.bx = this.dv.getUint8(6);
    this.by = this.dv.getUint8(7);
    const nStr = this.dv.getUint32(8, true);
    const strOff = this.dv.getUint32(12, true);
    const tabOff = this.dv.getUint32(16, true);
    const dec = new TextDecoder();
    let o = strOff;
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < nStr; i++) {
      const len = this.dv.getUint16(o, true);
      this.strings.push(dec.decode(u8.subarray(o + 2, o + 2 + len)));
      o += 2 + len;
    }
    this.table = new Uint32Array(buf.slice(tabOff, tabOff + 16 * 6 * 8));
  }

  section(tile: number, sec: number): [number, number] {
    const i = (tile * 6 + sec) * 2;
    return [this.table[i], this.table[i + 1]];
  }

  str(i: number) { return i === 0xffff ? null : this.strings[i] ?? null; }
}

export function readRings(dv: DataView, o: number, out: Ring[]): number {
  const nRings = dv.getUint16(o, true);
  const total = dv.getUint16(o + 2, true);
  o += 4;
  const counts: number[] = [];
  for (let i = 0; i < nRings; i++) { counts.push(dv.getUint16(o, true)); o += 2; }
  for (let r = 0; r < nRings; r++) {
    const n = counts[r];
    const xs = new Float64Array(n), ys = new Float64Array(n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      const dx = dv.getInt16(o, true), dy = dv.getInt16(o + 2, true);
      o += 4;
      if (i === 0) { x = dx; y = dy; } else { x += dx; y += dy; }
      xs[i] = x * Q; ys[i] = y * Q;
    }
    out.push({ xs, ys });
  }
  void total;
  return o;
}

export function readBuildings(b: { dv: DataView; str: (i: number) => string | null }, off: number, count: number, base = 0): BuildingRec[] {
  const dv = b.dv;
  const out: BuildingRec[] = [];
  let o = off + base;
  for (let k = 0; k < count; k++) {
    const cls = dv.getUint8(o), roof = dv.getUint8(o + 1), flags = dv.getUint8(o + 2), levels = dv.getUint8(o + 3);
    const h = dv.getUint16(o + 4, true) / 10, minh = dv.getUint16(o + 6, true) / 10, roofH = dv.getUint16(o + 8, true) / 10;
    const wall = dv.getUint16(o + 10, true), roofCol = dv.getUint16(o + 12, true), seed = dv.getUint16(o + 14, true);
    const name = b.str(dv.getUint16(o + 16, true)), addr = b.str(dv.getUint16(o + 18, true));
    o += 22;
    const rings: Ring[] = [];
    o = readRings(dv, o, rings);
    out.push({ cls, roof, flags, levels, h, minh, roofH, wall, roofCol, seed, name, addr, rings });
  }
  return out;
}

export function readLines(b: Bundle, off: number, count: number): LineRec[] {
  const dv = b.dv;
  const out: LineRec[] = [];
  let o = off;
  for (let k = 0; k < count; k++) {
    const cls = dv.getUint8(o), flags = dv.getUint8(o + 1), width = dv.getUint8(o + 2) / 4, lanes = dv.getUint8(o + 3);
    const layer = dv.getInt8(o + 4), region = dv.getUint8(o + 5);
    const name = b.str(dv.getUint16(o + 6, true));
    const n = dv.getUint16(o + 8, true);
    o += 10;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      const dx = dv.getInt16(o, true), dy = dv.getInt16(o + 2, true);
      o += 4;
      if (i === 0) { x = dx; y = dy; } else { x += dx; y += dy; }
      xs[i] = x * Q; ys[i] = y * Q;
    }
    let elev: Float32Array | null = null;
    if (flags & 4) {
      elev = new Float32Array(n);
      for (let i = 0; i < n; i++) { elev[i] = dv.getUint16(o, true) / 10; o += 2; }
    }
    out.push({ cls, flags, width, lanes, layer, region, name, xs, ys, elev });
  }
  return out;
}

export function readAreas(b: Bundle, off: number, count: number, water: boolean): AreaRec[] {
  const dv = b.dv;
  const out: AreaRec[] = [];
  let o = off;
  for (let k = 0; k < count; k++) {
    const kind = dv.getUint8(o), flags = dv.getUint8(o + 1);
    let level = 0, name: string | null;
    if (water) {
      level = dv.getInt16(o + 2, true) / 10;
      name = b.str(dv.getUint16(o + 4, true));
      o += 6;
    } else {
      name = b.str(dv.getUint16(o + 2, true));
      o += 4;
    }
    const rings: Ring[] = [];
    o = readRings(dv, o, rings);
    out.push({ kind, flags, level, name, rings });
  }
  return out;
}

export interface TreeRec { x: number; y: number; h: number; r: number; kind: number }
export function readTrees(b: Bundle, off: number, count: number): TreeRec[] {
  const dv = b.dv;
  const out: TreeRec[] = new Array(count);
  let o = off;
  for (let k = 0; k < count; k++) {
    out[k] = {
      x: dv.getInt16(o, true) * Q, y: dv.getInt16(o + 2, true) * Q,
      h: dv.getUint8(o + 4) / 4, r: dv.getUint8(o + 5) / 10, kind: dv.getUint8(o + 6),
    };
    o += 8;
  }
  return out;
}

export function rgb565(c: number): [number, number, number] {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}
