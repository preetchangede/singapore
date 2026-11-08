// Growable typed-array geometry builders used by the mesher worker.

export class GrowF32 {
  a: Float32Array; n = 0;
  constructor(cap = 1024) { this.a = new Float32Array(cap); }
  ensure(k: number) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Float32Array(c); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push1(x: number) { this.ensure(1); this.a[this.n++] = x; }
  push2(x: number, y: number) { this.ensure(2); this.a[this.n++] = x; this.a[this.n++] = y; }
  push3(x: number, y: number, z: number) { this.ensure(3); const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; }
  out() { return this.a.slice(0, this.n); }
}
export class GrowU8 {
  a: Uint8Array; n = 0;
  constructor(cap = 1024) { this.a = new Uint8Array(cap); }
  ensure(k: number) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Uint8Array(c); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push4(x: number, y: number, z: number, w: number) { this.ensure(4); const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; a[this.n++] = w; }
  out() { return this.a.slice(0, this.n); }
}
export class GrowI8 {
  a: Int8Array; n = 0;
  constructor(cap = 1024) { this.a = new Int8Array(cap); }
  ensure(k: number) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Int8Array(c); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push4(x: number, y: number, z: number, w: number) { this.ensure(4); const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; a[this.n++] = w; }
  out() { return this.a.slice(0, this.n); }
}
export class GrowU32 {
  a: Uint32Array; n = 0;
  constructor(cap = 1024) { this.a = new Uint32Array(cap); }
  ensure(k: number) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Uint32Array(c); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push3(x: number, y: number, z: number) { this.ensure(3); const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; }
  out() { return this.a.slice(0, this.n); }
}
export class GrowU16 {
  a: Uint16Array; n = 0;
  constructor(cap = 1024) { this.a = new Uint16Array(cap); }
  ensure(k: number) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Uint16Array(c); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push1(x: number) { this.ensure(1); this.a[this.n++] = x; }
  out() { return this.a.slice(0, this.n); }
}

/** Solid geometry: buildings, roofs, bridges, landmarks. */
export class SolidBuilder {
  pos = new GrowF32(4096);
  nrm = new GrowI8(4096);
  fac = new GrowF32(4096);   // facade u (m along wall), v (m above base)
  col = new GrowU8(4096);    // rgb + material flags
  inf = new GrowU8(4096);    // class, storey height (x20), seed, flags
  bid = new GrowU16(1024);   // building index per vertex (CPU picking only)
  idx = new GrowU32(4096);
  get count() { return this.pos.n / 3; }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number,
         r: number, g: number, b: number, m: number, cls: number, sh: number, seed: number, flags: number, id: number) {
    this.pos.push3(x, y, z);
    this.nrm.push4(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127), 0);
    this.fac.push2(u, v);
    this.col.push4(r, g, b, m);
    this.inf.push4(cls, sh, seed, flags);
    this.bid.push1(id);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) { this.idx.push3(a, b, c); }

  build() {
    return {
      position: this.pos.out(), normal: this.nrm.out(), facade: this.fac.out(), color: this.col.out(),
      info: this.inf.out(), bid: this.bid.out(), index: this.idx.out(),
    };
  }
}
export type SolidGeom = ReturnType<SolidBuilder['build']>;

/** Flat 2D geometry for the ground clipmap: xy + colour + material params. */
export class FlatBuilder {
  pos = new GrowF32(4096);
  col = new GrowU8(4096);
  mat = new GrowU8(4096);
  idx = new GrowU32(4096);
  get count() { return this.pos.n / 2; }
  vertex(x: number, y: number, c: number[], m: number[]) {
    this.pos.push2(x, y);
    this.col.push4(c[0], c[1], c[2], 255);
    this.mat.push4(m[0], m[1], m[2], m[3]);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) { this.idx.push3(a, b, c); }
  build() { return { position: this.pos.out(), color: this.col.out(), material: this.mat.out(), index: this.idx.out() }; }
}
export type FlatGeom = ReturnType<FlatBuilder['build']>;
