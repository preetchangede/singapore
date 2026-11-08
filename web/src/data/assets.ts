import * as THREE from 'three';

export interface Manifest {
  version: number;
  generated: string;
  frame: { E0: number; N0: number; lon0: number; lat0: number; half: number; bundle: number; tile: number; nb: number; tilesPerBundle: number };
  terrain: {
    near: { file: string; size: number; half: number; enc: [number, number] };
    far: { file: string; size: number; half: number; enc: [number, number] };
    coast: { file: string; size: number; half: number; maxd: number };
    canopy: { file: string; size: number; half: number; scale: number };
  };
  ground: { overview: string; overviewSmall: string; half: number };
  overview: { file: string; count: number; bodyOffset: number };
  bundles: [number, number, number][];
  labels: string;
  search: string;
  heightModel: { rmse: number; mae: number; median_rel: number; n_train: number };
  /** extension used for binary data files ('.bin' normally; some hosts only serve standard web types) */
  binExt?: string;
  attribution: string[];
}

export const DATA_BASE = new URL('./data/', document.baseURI).href;

export type Progress = (loaded: number, total: number) => void;

/** Fetch a file with progress reporting. */
export async function fetchBytes(path: string, onProgress?: Progress): Promise<Uint8Array> {
  const res = await fetch(DATA_BASE + path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** gzip-decompress with the native DecompressionStream (no WASM, no deps). */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  // Some hosts transparently decode gzip; detect the magic number.
  if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) return data;
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function fetchGz(path: string, onProgress?: Progress) {
  return gunzip(await fetchBytes(path, onProgress));
}

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(DATA_BASE + 'manifest.json');
  return res.json();
}

/** Decode delta/byte-plane terrain to Float32 heights (row 0 = north). */
export function decodeHeights(bytes: Uint8Array, size: number, scale: number, offset: number): Float32Array {
  const n = size * size;
  const hi = bytes.subarray(0, n);
  const lo = bytes.subarray(n, 2 * n);
  const out = new Float32Array(n);
  for (let r = 0; r < size; r++) {
    let v = 0;
    const base = r * size;
    for (let c = 0; c < size; c++) {
      const i = base + c;
      v = (v + ((hi[i] << 8) | lo[i])) & 0xffff;
      out[i] = v / scale - offset;
    }
  }
  return out;
}

/** Float heights -> half-float R16F texture (filterable everywhere in WebGL2). */
export function heightTexture(h: Float32Array, size: number) {
  const half = new Uint16Array(h.length);
  for (let i = 0; i < h.length; i++) half[i] = THREE.DataUtils.toHalfFloat(h[i]);
  const tex = new THREE.DataTexture(half, size, size, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

export function byteTexture(b: Uint8Array, size: number, filter = THREE.LinearFilter) {
  const tex = new THREE.DataTexture(b, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = filter;
  tex.magFilter = filter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export async function loadImageTexture(path: string): Promise<THREE.Texture> {
  const res = await fetch(DATA_BASE + path);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' as ImageOrientation, colorSpaceConversion: 'none' });
  const tex = new THREE.Texture(bmp as unknown as HTMLImageElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Bilinear sampler on a CPU height grid (row 0 = north), local coordinates in metres. */
export class HeightField {
  constructor(public data: Float32Array, public size: number, public half: number) {}
  /** x = east, y = north (pipeline frame) */
  sample(x: number, y: number): number {
    const n = this.size;
    const fx = ((x + this.half) / (2 * this.half)) * n - 0.5;
    const fy = ((this.half - y) / (2 * this.half)) * n - 0.5;
    const x0 = Math.max(0, Math.min(n - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(n - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const d = this.data;
    const a = d[y0 * n + x0], b = d[y0 * n + x0 + 1], c = d[(y0 + 1) * n + x0], e = d[(y0 + 1) * n + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  }
}
