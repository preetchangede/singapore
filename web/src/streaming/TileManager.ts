import * as THREE from 'three';
import { WorkerPool } from './WorkerPool';
import { makeBuildingMaterial, solidGeometry } from '../world/Buildings';
import { Water } from '../world/Water';
import type { Manifest } from '../data/assets';
import { DATA_BASE } from '../data/assets';
import type { SolidGeom, FlatGeom } from '../workers/builder';
import type { BuildingInfo } from '../workers/buildings';

export interface GroundLayers { areas: FlatGeom; water: FlatGeom; foot: FlatGeom; roads: FlatGeom; marks: FlatGeom }

export interface DetailTile {
  key: string; tx: number; ty: number; ox: number; oy: number;
  buildings: THREE.Mesh | null; bridges: THREE.Mesh | null; water: THREE.Mesh | null;
  trees: Float32Array | null; info: BuildingInfo[]; bid: Uint16Array | null;
}
export interface GroundTile { key: string; tx: number; ty: number; ox: number; oy: number; layers: GroundLayers }

interface OverviewChunk { bx: number; by: number; mesh: THREE.Mesh; mat: THREE.ShaderMaterial }

/** Decides which tiles to load at which level of detail, and builds their meshes. */
export class TileManager {
  pool: WorkerPool;
  group = new THREE.Group();
  overviewGroup = new THREE.Group();
  detail = new Map<string, DetailTile>();
  ground = new Map<string, GroundTile>();
  private requested = new Set<string>();
  private overview = new Map<string, OverviewChunk>();
  private bundleSet = new Set<string>();
  private queue: (() => void)[] = [];
  readonly buildingMat = makeBuildingMaterial(false);
  readonly water = new Water();
  detailRadius = 2400;
  groundRadius = 6800;
  maxInflight = 6;
  onDetail: (t: DetailTile) => void = () => {};
  onDetailRemoved: (t: DetailTile) => void = () => {};
  onGround: (t: GroundTile) => void = () => {};
  onGroundRemoved: (t: GroundTile) => void = () => {};
  overviewReady = 0;
  half: number; tile: number; tpb: number; nb: number;
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();

  constructor(private manifest: Manifest, heights: Float32Array) {
    const n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.pool = new WorkerPool(n);
    const f = manifest.frame;
    this.half = f.half; this.tile = f.tile; this.tpb = f.tilesPerBundle; this.nb = f.nb;
    this.pool.init({
      heights: heights.slice(), size: manifest.terrain.near.size, half: manifest.terrain.near.half,
      base: DATA_BASE, frame: f,
    });
    for (const [bx, by] of manifest.bundles) this.bundleSet.add(`${bx}_${by}`);
    this.group.add(this.overviewGroup);
    this.group.add(this.water.group);
  }

  /** Request the far-LOD building meshes for every bundle (cheap, ~2.7 MB total). */
  loadOverview(onProgress?: (f: number) => void) {
    const list = this.manifest.bundles;
    let done = 0;
    return Promise.all(list.map(([bx, by]) =>
      this.pool.request<{ bx: number; by: number; ox: number; oy: number; solid: SolidGeom }>(0, 0, { type: 'overview', bx, by, nb: this.nb })
        .then((r) => {
          done++;
          onProgress?.(done / list.length);
          if (!r || r.solid.index.length === 0) return;
          const geo = solidGeometry(r.solid, true);
          const mat = makeBuildingMaterial(true);
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(r.ox, 0, -r.oy);
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          mesh.userData.kind = 'overview';
          this.overviewGroup.add(mesh);
          this.overview.set(`${bx}_${by}`, { bx, by, mesh, mat });
          this.overviewReady++;
        })
        .catch(() => { done++; })));
  }

  private tileCenter(tx: number, ty: number): [number, number] {
    return [-this.half + (tx + 0.5) * this.tile, -this.half + (ty + 0.5) * this.tile];
  }

  update(camera: THREE.PerspectiveCamera, altitude: number) {
    // drain mesh-creation queue gradually (GPU uploads)
    for (let i = 0; i < 3 && this.queue.length; i++) this.queue.shift()!();
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    // focus: the ground point the camera looks at, blended with the camera position
    const cx = camera.position.x, cz = camera.position.z;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const ahead = Math.min(altitude * 1.2, 2500);
    const fx = cx + dir.x * ahead * 0.5, fz = cz + dir.z * ahead * 0.5;
    const py = -fz; // pipeline north coordinate
    const detailR = altitude > 4500 ? 0 : this.detailRadius * (altitude > 1500 ? 0.75 : 1);
    const groundR = altitude > 9000 ? 0 : this.groundRadius;
    const want: { key: string; tx: number; ty: number; d: number; what: 'ground' | 'detail' }[] = [];
    const NT = this.nb * this.tpb;
    const consider = (R: number, what: 'ground' | 'detail') => {
      if (R <= 0) return;
      const t0x = Math.max(0, Math.floor((fx - R + this.half) / this.tile));
      const t1x = Math.min(NT - 1, Math.floor((fx + R + this.half) / this.tile));
      const t0y = Math.max(0, Math.floor((py - R + this.half) / this.tile));
      const t1y = Math.min(NT - 1, Math.floor((py + R + this.half) / this.tile));
      for (let ty = t0y; ty <= t1y; ty++) for (let tx = t0x; tx <= t1x; tx++) {
        const bk = `${Math.floor(tx / this.tpb)}_${Math.floor(ty / this.tpb)}`;
        if (!this.bundleSet.has(bk)) continue;
        const [ox, oy] = this.tileCenter(tx, ty);
        const d = Math.hypot(ox - fx, oy - py);
        if (d > R + this.tile * 0.7) continue;
        const key = `${what[0]}${tx}_${ty}`;
        // in-view tiles first
        const box = new THREE.Box3(new THREE.Vector3(ox - 512, -10, -oy - 512), new THREE.Vector3(ox + 512, 300, -oy + 512));
        const vis = this.frustum.intersectsBox(box);
        want.push({ key, tx, ty, d: d * (vis ? 1 : 2.5) + (what === 'ground' ? 300 : 0), what });
      }
    };
    consider(detailR, 'detail');
    consider(groundR, 'ground');
    want.sort((a, b) => a.d - b.d);
    for (const w of want) {
      if (this.pool.inflight >= this.maxInflight) break;
      if (this.requested.has(w.key)) continue;
      this.requested.add(w.key);
      const bx = Math.floor(w.tx / this.tpb), by = Math.floor(w.ty / this.tpb);
      this.pool.request<any>(bx, by, { type: 'mesh', tx: w.tx, ty: w.ty, what: w.what, key: w.key })
        .then((r) => { if (r) this.queue.push(() => this.accept(w.key, w.what, r)); })
        .catch(() => { this.requested.delete(w.key); });
    }
    // unload far tiles
    for (const [key, t] of this.detail) {
      const d = Math.hypot(t.ox - fx, t.oy - py);
      if (d > Math.max(detailR, 600) * 1.35 + this.tile) this.removeDetail(key);
    }
    for (const [key, t] of this.ground) {
      const d = Math.hypot(t.ox - fx, t.oy - py);
      if (d > Math.max(groundR, 1500) * 1.3 + this.tile) this.removeGround(key);
    }
    this.updateOverviewMasks();
  }

  private accept(key: string, what: 'ground' | 'detail', r: any) {
    if (!this.requested.has(key)) return; // dropped meanwhile
    if (what === 'ground') {
      const t: GroundTile = { key, tx: r.tx, ty: r.ty, ox: r.ox, oy: r.oy, layers: r.layers };
      this.ground.set(key, t);
      this.onGround(t);
      return;
    }
    const t: DetailTile = { key, tx: r.tx, ty: r.ty, ox: r.ox, oy: r.oy, buildings: null, bridges: null, water: null, trees: r.trees, info: r.info, bid: null };
    if (r.solid && r.solid.index.length) {
      const m = new THREE.Mesh(solidGeometry(r.solid), this.buildingMat);
      m.position.set(r.ox, 0, -r.oy);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.userData.tile = t;
      t.buildings = m;
      t.bid = r.solid.bid;
      this.group.add(m);
    }
    if (r.bridges && r.bridges.index.length) {
      const m = new THREE.Mesh(solidGeometry(r.bridges), this.buildingMat);
      m.position.set(r.ox, 0, -r.oy);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      t.bridges = m;
      this.group.add(m);
    }
    if (r.water && r.water.index.length) t.water = this.water.create(r.water, r.ox, r.oy);
    this.detail.set(key, t);
    this.onDetail(t);
  }

  private removeDetail(key: string) {
    const t = this.detail.get(key);
    if (!t) return;
    for (const m of [t.buildings, t.bridges, t.water]) {
      if (!m) continue;
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.detail.delete(key);
    this.requested.delete(key);
    this.onDetailRemoved(t);
  }

  private removeGround(key: string) {
    const t = this.ground.get(key);
    if (!t) return;
    this.ground.delete(key);
    this.requested.delete(key);
    this.onGroundRemoved(t);
  }

  private updateOverviewMasks() {
    const masks = new Map<string, number>();
    for (const t of this.detail.values()) {
      if (!t.buildings) continue;
      const bx = Math.floor(t.tx / this.tpb), by = Math.floor(t.ty / this.tpb);
      const ti = (t.ty % this.tpb) * this.tpb + (t.tx % this.tpb);
      const k = `${bx}_${by}`;
      masks.set(k, (masks.get(k) || 0) | (1 << ti));
    }
    for (const [k, c] of this.overview) c.mat.uniforms.uHideMask.value = masks.get(k) || 0;
  }

  /** All meshes that cast shadows near the camera. */
  shadowCasters(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const t of this.detail.values()) { if (t.buildings) out.push(t.buildings); if (t.bridges) out.push(t.bridges); }
    return out;
  }

  get stats() {
    let tris = 0;
    for (const t of this.detail.values()) if (t.buildings) tris += (t.buildings.geometry.index?.count || 0) / 3;
    return { detail: this.detail.size, ground: this.ground.size, inflight: this.pool.inflight, tris: Math.round(tris), overview: this.overviewReady };
  }
}
