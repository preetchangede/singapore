import * as THREE from 'three';
import { COMMON } from '../shaders/common';
import { U } from '../core/uniforms';
import type { GroundTile } from '../streaming/TileManager';
import type { FlatGeom } from '../workers/builder';

const VS = /* glsl */ `
in vec2 aPos;
in vec4 aCol;
in vec4 aMat;
uniform vec2 uOrigin;     // tile centre (pipeline x, north)
uniform vec3 uRect;       // level centre (world x, world z), half extent
out vec4 vCol;
out vec4 vMat;
void main() {
  float wx = uOrigin.x + aPos.x;
  float wz = -(uOrigin.y + aPos.y);
  vCol = aCol;
  vMat = aMat;
  gl_Position = vec4((wx - uRect.x) / uRect.z, (wz - uRect.y) / uRect.z, 0.0, 1.0);
}
`;

const FS = /* glsl */ `
in vec4 vCol;
in vec4 vMat;
layout(location = 0) out vec4 gAlbedo;
layout(location = 1) out vec4 gMaterial;
${COMMON}
void main() {
  gAlbedo = vec4(srgbToLinear(vCol.rgb), 1.0);
  gMaterial = vMat;
}
`;

interface Level { extent: number; res: number; rt: THREE.WebGLRenderTarget; cx: number; cz: number; valid: boolean; dirty: boolean; lastDraw: number }
interface TileMeshes { t: GroundTile; meshes: THREE.Mesh[]; minx: number; maxx: number; minz: number; maxz: number }

export class Clipmap {
  levels: Level[] = [];
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private tiles = new Map<string, TileMeshes>();
  private mats: THREE.ShaderMaterial[] = [];
  private rect = { value: new THREE.Vector3() };

  constructor(private renderer: THREE.WebGLRenderer, res = 2048, extents = [640, 2560, 10240]) {
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    extents.forEach((extent, i) => {
      const rt = new THREE.WebGLRenderTarget(res, res, {
        count: 2, depthBuffer: false, stencilBuffer: false, type: THREE.UnsignedByteType,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      });
      rt.textures[0].colorSpace = THREE.SRGBColorSpace;
      rt.textures[1].colorSpace = THREE.NoColorSpace;
      for (const t of rt.textures) t.anisotropy = Math.min(8, maxAniso);
      this.levels.push({ extent, res, rt, cx: 1e9, cz: 1e9, valid: false, dirty: true, lastDraw: 0 });
      (U as Record<string, THREE.IUniform>)[`tClip${i}`].value = rt.textures[0];
      (U as Record<string, THREE.IUniform>)[`tClipM${i}`].value = rt.textures[1];
    });
    // one material per layer for render ordering; uniforms shared except origin (per mesh, set in onBeforeRender)
    for (let k = 0; k < 5; k++) {
      this.mats.push(new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS,
        uniforms: { uOrigin: { value: new THREE.Vector2() }, uRect: this.rect },
        depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      }));
    }
  }

  addTile(t: GroundTile) {
    const order: (keyof GroundTile['layers'])[] = ['areas', 'water', 'foot', 'roads', 'marks'];
    const meshes: THREE.Mesh[] = [];
    order.forEach((name, k) => {
      const g: FlatGeom = t.layers[name];
      if (!g || g.index.length === 0) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('aPos', new THREE.BufferAttribute(g.position, 2));
      geo.setAttribute('aCol', new THREE.BufferAttribute(g.color, 4, true));
      geo.setAttribute('aMat', new THREE.BufferAttribute(g.material, 4, true));
      // three needs a 'position' attribute for draw range; alias aPos (unused in shader)
      geo.setAttribute('position', new THREE.BufferAttribute(g.position, 2));
      geo.setIndex(new THREE.BufferAttribute(g.index, 1));
      // 2D positions: give explicit bounds so three never tries to compute a 3D sphere
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4096);
      const m = new THREE.Mesh(geo, this.mats[k]);
      m.frustumCulled = false;
      m.renderOrder = k;
      m.matrixAutoUpdate = false;
      const origin = new THREE.Vector2(t.ox, t.oy);
      m.onBeforeRender = () => { this.mats[k].uniforms.uOrigin.value.copy(origin); this.mats[k].uniformsNeedUpdate = true; };
      this.scene.add(m);
      meshes.push(m);
    });
    const half = 512 + 64;
    const tm: TileMeshes = { t, meshes, minx: t.ox - half, maxx: t.ox + half, minz: -t.oy - half, maxz: -t.oy + half };
    this.tiles.set(t.key, tm);
    for (const L of this.levels) if (this.overlaps(L, tm)) L.dirty = true;
  }

  removeTile(t: GroundTile) {
    const tm = this.tiles.get(t.key);
    if (!tm) return;
    for (const m of tm.meshes) { m.removeFromParent(); m.geometry.dispose(); }
    this.tiles.delete(t.key);
  }

  private overlaps(L: Level, tm: TileMeshes) {
    const h = L.extent / 2;
    return tm.maxx > L.cx - h && tm.minx < L.cx + h && tm.maxz > L.cz - h && tm.minz < L.cz + h;
  }

  update(camera: THREE.Camera, altitude: number, now: number) {
    let drew = 0;
    for (let i = 0; i < this.levels.length; i++) {
      const L = this.levels[i];
      // levels only matter while their texels are reasonably close to screen resolution
      const useful = altitude < L.extent * 1.6;
      if (!useful) { this.setRect(i, L, 0); continue; }
      const step = L.extent / 16;
      const nx = Math.round(camera.position.x / step) * step;
      const nz = Math.round(camera.position.z / step) * step;
      const moved = Math.abs(nx - L.cx) > step * 0.5 || Math.abs(nz - L.cz) > step * 0.5;
      if (moved) { L.cx = nx; L.cz = nz; L.dirty = true; }
      // rate-limit re-renders while tiles stream in (finest level more often)
      if (L.dirty && (moved || now - L.lastDraw > 250 * (i + 1)) && drew < 2) {
        this.draw(L);
        L.dirty = false;
        L.valid = true;
        L.lastDraw = now;
        drew++;
      }
      this.setRect(i, L, L.valid ? 1 : 0);
    }
  }

  private setRect(i: number, L: Level, active: number) {
    (U.uClipRect.value as THREE.Vector4[])[i].set(L.cx, L.cz, L.extent / 2, active);
  }

  private draw(L: Level) {
    const half = L.extent / 2;
    this.rect.value.set(L.cx, L.cz, half);
    let any = false;
    for (const tm of this.tiles.values()) {
      const vis = this.overlaps(L, tm);
      for (const m of tm.meshes) m.visible = vis;
      any = any || vis;
    }
    const prev = this.renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    this.renderer.getClearColor(prevClear);
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(L.rt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
    if (any) this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prev);
    this.renderer.setClearColor(prevClear, prevAlpha);
  }
}
