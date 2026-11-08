/// <reference lib="webworker" />
import { Bundle, SECTION, readBuildings, readLines, readAreas, readTrees, BuildingRec } from '../data/bundleFormat';
import { SolidBuilder, FlatBuilder } from './builder';
import { meshBuilding, BuildingInfo } from './buildings';
import { meshAreas, meshWaterFlat, meshWaterSurface, meshFootprints, meshRoads, meshRailsFlat, meshBridges } from './ground';

declare const self: DedicatedWorkerGlobalScope;

let H: Float32Array;
let HS = 2048, HHALF = 32768;
let BASE = '';
let HALF = 32768, TILE = 1024, TPB = 4;
const bundles = new Map<string, Promise<Bundle | null>>();
const bundleOrder: string[] = [];
let overview: { dv: DataView; table: Uint32Array; body: number } | null = null;
const hidden = new Set<string>();

function heightAt(x: number, y: number) {
  const n = HS;
  const fx = ((x + HHALF) / (2 * HHALF)) * n - 0.5;
  const fy = ((HHALF - y) / (2 * HHALF)) * n - 0.5;
  const x0 = Math.max(0, Math.min(n - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(n - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  const a = H[y0 * n + x0], b = H[y0 * n + x0 + 1], c = H[(y0 + 1) * n + x0], d = H[(y0 + 1) * n + x0 + 1];
  return Math.max(0, (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
}

async function gunzip(data: Uint8Array): Promise<ArrayBuffer> {
  if (data[0] !== 0x1f || data[1] !== 0x8b) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}

function getBundle(bx: number, by: number): Promise<Bundle | null> {
  const key = `${bx}_${by}`;
  let p = bundles.get(key);
  if (!p) {
    const fn = `bundles/b${String(bx).padStart(2, '0')}_${String(by).padStart(2, '0')}.bin`;
    p = fetch(BASE + fn)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((ab) => gunzip(new Uint8Array(ab)))
      .then((buf) => new Bundle(buf))
      .catch(() => null);
    bundles.set(key, p);
    bundleOrder.push(key);
    while (bundleOrder.length > 14) {
      const k = bundleOrder.shift()!;
      bundles.delete(k);
    }
  }
  return p;
}

function tileCenter(tx: number, ty: number) {
  return [-HALF + (tx + 0.5) * TILE, -HALF + (ty + 0.5) * TILE];
}

async function meshTile(tx: number, ty: number, what: 'ground' | 'detail') {
  const bx = Math.floor(tx / TPB), by = Math.floor(ty / TPB);
  const b = await getBundle(bx, by);
  if (!b) return null;
  const ti = (ty % TPB) * TPB + (tx % TPB);
  const [ox, oy] = tileCenter(tx, ty);
  const [bo, bc] = b.section(ti, SECTION.buildings);
  const buildings: BuildingRec[] = bc ? readBuildings(b, bo, bc) : [];
  const transfer: Transferable[] = [];
  const result: Record<string, unknown> = { tx, ty, ox, oy };
  if (what === 'ground') {
    const [ao, ac] = b.section(ti, SECTION.areas);
    const [wo, wc] = b.section(ti, SECTION.water);
    const [ro, rc] = b.section(ti, SECTION.roads);
    const [lo, lc] = b.section(ti, SECTION.rails);
    const areas = ac ? readAreas(b, ao, ac, false) : [];
    const water = wc ? readAreas(b, wo, wc, true) : [];
    const roads = rc ? readLines(b, ro, rc) : [];
    const rails = lc ? readLines(b, lo, lc) : [];
    const A = new FlatBuilder(), Wt = new FlatBuilder(), F = new FlatBuilder(), R = new FlatBuilder(), M = new FlatBuilder();
    meshAreas(areas, A);
    meshWaterFlat(water, Wt);
    meshFootprints(buildings, F);
    meshRailsFlat(rails, R);
    meshRoads(roads, R, M, true);
    const layers = { areas: A.build(), water: Wt.build(), foot: F.build(), roads: R.build(), marks: M.build() };
    for (const l of Object.values(layers)) transfer.push(l.position.buffer, l.color.buffer, l.material.buffer, l.index.buffer);
    result.layers = layers;
  } else {
    const S = new SolidBuilder();
    const info: BuildingInfo[] = [];
    buildings.forEach((rec, i) => meshBuilding(rec, i, S, heightAt, ox, oy, 0, info));
    const nb = buildings.length;
    const [ro, rc] = b.section(ti, SECTION.roads);
    const [lo, lc] = b.section(ti, SECTION.rails);
    const roads = rc ? readLines(b, ro, rc) : [];
    const rails = lc ? readLines(b, lo, lc) : [];
    const B = new SolidBuilder();
    meshBridges(roads, false, B, heightAt, ox, oy, 60000);
    meshBridges(rails, true, B, heightAt, ox, oy, 62000);
    const solid = S.build();
    const bridges = B.build();
    for (const g of [solid, bridges]) transfer.push(g.position.buffer, g.normal.buffer, g.facade.buffer, g.color.buffer, g.info.buffer, g.bid.buffer, g.index.buffer);
    // water surfaces
    const [wo, wc] = b.section(ti, SECTION.water);
    const water = wc ? meshWaterSurface(readAreas(b, wo, wc, true)) : null;
    if (water) transfer.push(water.position.buffer, water.kind.buffer, water.index.buffer);
    // trees: x, y(base elev), z, h, r, kind, seed
    const [to, tc] = b.section(ti, SECTION.trees);
    let trees: Float32Array | null = null;
    if (tc) {
      const tr = readTrees(b, to, tc);
      trees = new Float32Array(tr.length * 7);
      tr.forEach((t, i) => {
        trees![i * 7] = t.x;
        trees![i * 7 + 1] = heightAt(ox + t.x, oy + t.y);
        trees![i * 7 + 2] = -t.y;
        trees![i * 7 + 3] = t.h;
        trees![i * 7 + 4] = t.r;
        trees![i * 7 + 5] = t.kind;
        trees![i * 7 + 6] = ((tx * 7919 + ty * 104729 + i * 2654435761) >>> 0) % 1000 / 1000;
      });
      transfer.push(trees.buffer);
    }
    Object.assign(result, { solid, bridges, water, trees, info, nb });
  }
  return { result, transfer };
}

async function loadOverview() {
  if (overview) return overview;
  const r = await fetch(BASE + 'buildings/overview.bin');
  const buf = await gunzip(new Uint8Array(await r.arrayBuffer()));
  const dv = new DataView(buf);
  const NB = dv.getUint8(6);
  const table = new Uint32Array(buf.slice(32, 32 + NB * NB * 16 * 8));
  overview = { dv, table, body: 32 + NB * NB * 16 * 8 };
  return overview;
}

async function meshOverview(bx: number, by: number, nb: number) {
  const ov = await loadOverview();
  const S = new SolidBuilder();
  const tileIdx: number[] = [];
  const reader = { dv: ov.dv, str: () => null };
  const [bcx, bcy] = [-HALF + (bx + 0.5) * TPB * TILE, -HALF + (by + 0.5) * TPB * TILE];
  for (let ti = 0; ti < 16; ti++) {
    const k = ((by * nb + bx) * 16 + ti) * 2;
    const off = ov.table[k], cnt = ov.table[k + 1];
    if (!cnt) continue;
    const tx = bx * TPB + (ti % TPB), ty = by * TPB + Math.floor(ti / TPB);
    const [ox, oy] = tileCenter(tx, ty);
    const recs = readBuildings(reader, off, cnt, ov.body);
    const before = S.count;
    // mesh relative to the tile centre, then shift into bundle-centre space
    const S2 = new SolidBuilder();
    recs.forEach((rec, i) => meshBuilding(rec, i, S2, heightAt, ox, oy, 1));
    const g = S2.build();
    const dx = ox - bcx, dz = -(oy - bcy);
    for (let i = 0; i < g.position.length; i += 3) {
      S.vertex(g.position[i] + dx, g.position[i + 1], g.position[i + 2] + dz,
        g.normal[(i / 3) * 4] / 127, g.normal[(i / 3) * 4 + 1] / 127, g.normal[(i / 3) * 4 + 2] / 127,
        g.facade[(i / 3) * 2], g.facade[(i / 3) * 2 + 1],
        g.color[(i / 3) * 4], g.color[(i / 3) * 4 + 1], g.color[(i / 3) * 4 + 2], g.color[(i / 3) * 4 + 3],
        g.info[(i / 3) * 4], g.info[(i / 3) * 4 + 1], g.info[(i / 3) * 4 + 2], g.info[(i / 3) * 4 + 3], ti);
      tileIdx.push(ti);
    }
    for (let i = 0; i < g.index.length; i += 3) S.tri(g.index[i] + before, g.index[i + 1] + before, g.index[i + 2] + before);
  }
  const geom = S.build();
  return { result: { bx, by, ox: bcx, oy: bcy, solid: geom }, transfer: [geom.position.buffer, geom.normal.buffer, geom.facade.buffer, geom.color.buffer, geom.info.buffer, geom.bid.buffer, geom.index.buffer] };
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      H = m.heights; HS = m.size; HHALF = m.half; BASE = m.base;
      HALF = m.frame.half; TILE = m.frame.tile; TPB = m.frame.tilesPerBundle;
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'mesh') {
      if (hidden.has(m.key)) return;
      const r = await meshTile(m.tx, m.ty, m.what);
      if (!r) { self.postMessage({ type: 'mesh', id: m.id, result: null }); return; }
      self.postMessage({ type: 'mesh', id: m.id, result: r.result }, r.transfer);
    } else if (m.type === 'overview') {
      const r = await meshOverview(m.bx, m.by, m.nb);
      self.postMessage({ type: 'overview', id: m.id, result: r.result }, r.transfer);
    } else if (m.type === 'prefetch') {
      getBundle(m.bx, m.by);
    }
  } catch (err) {
    self.postMessage({ type: m.type, id: m.id, error: String(err), result: null });
  }
};
