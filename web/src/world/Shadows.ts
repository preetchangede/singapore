import * as THREE from 'three';
import { U } from '../core/uniforms';

/**
 * Cascaded shadow maps for the sun, packed side by side in one depth atlas.
 * Each cascade is fitted with a bounding sphere (stable size) and snapped to its
 * texel grid, so it only needs re-rendering when it actually moves, the sun moves,
 * or new geometry arrives.
 */
export class Shadows {
  rt: THREE.WebGLRenderTarget;
  size: number;
  private cams: THREE.OrthographicCamera[] = [];
  private keys: string[] = ['', '', ''];
  version = 0;              // bump when casters change
  private seenVersion = [-1, -1, -1];
  private corners: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
  enabled = true;
  splits = [180, 800, 3200];

  constructor(private renderer: THREE.WebGLRenderer, size = 2048) {
    this.size = size;
    const depth = new THREE.DepthTexture(size * 3, size, THREE.FloatType);
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.rt = new THREE.WebGLRenderTarget(size * 3, size, {
      depthBuffer: true, depthTexture: depth, format: THREE.RedFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    for (let i = 0; i < 3; i++) this.cams.push(new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10000));
    U.tShadow.value = depth;
    U.uShadowTexel.value.set(1 / (size * 3), 1 / size, 0);
  }

  /** Fit cascade i to the slice [near, far] of the view frustum. */
  private fit(i: number, camera: THREE.PerspectiveCamera, near: number, far: number, sunDir: THREE.Vector3) {
    // frustum slice corners in world space
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanX = tanY * camera.aspect;
    let k = 0;
    for (const d of [near, far]) {
      for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
        this.corners[k++].set(sx * tanX * d, sy * tanY * d, -d).applyMatrix4(camera.matrixWorld);
      }
    }
    const center = new THREE.Vector3();
    for (const c of this.corners) center.add(c);
    center.multiplyScalar(1 / 8);
    let radius = 0;
    for (const c of this.corners) radius = Math.max(radius, c.distanceTo(center));
    radius = Math.ceil(radius * 1.05);
    // light basis
    const z = sunDir.clone().normalize();
    const up = Math.abs(z.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const x = new THREE.Vector3().crossVectors(up, z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    // snap centre to texel grid in light space
    const texel = (2 * radius) / this.size;
    let lx = center.dot(x), ly = center.dot(y);
    const lz = center.dot(z);
    lx = Math.floor(lx / texel) * texel;
    ly = Math.floor(ly / texel) * texel;
    const snapped = new THREE.Vector3().addScaledVector(x, lx).addScaledVector(y, ly).addScaledVector(z, lz);
    const cam = this.cams[i];
    const back = radius + 1500;   // include tall buildings between the sun and the slice
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = 0.5; cam.far = back + radius + 200;
    cam.position.copy(snapped).addScaledVector(z, back);
    cam.up.copy(y);
    cam.lookAt(snapped);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    return `${lx.toFixed(1)},${ly.toFixed(1)},${radius},${z.x.toFixed(4)},${z.y.toFixed(4)},${z.z.toFixed(4)}`;
  }

  update(camera: THREE.PerspectiveCamera, altitude: number, casters: THREE.Object3D[], scene: THREE.Scene, swap: (on: boolean) => void) {
    const sun = U.uSunDir.value;
    if (!this.enabled || sun.y < 0.02) { U.uShadowOn.value = 0; return; }
    U.uShadowOn.value = 1;
    const a = Math.max(altitude, 30);
    const s0 = Math.min(Math.max(180, a * 0.9), 2500);
    this.splits = [s0, s0 * 4.2, Math.min(s0 * 16, 9000)];
    U.uShadowSplits.value.set(this.splits[0], this.splits[1], this.splits[2], 0);
    const prev = this.renderer.getRenderTarget();
    let swapped = false;
    let near = Math.max(camera.near, 0.5);
    for (let i = 0; i < 3; i++) {
      const far = this.splits[i];
      const key = this.fit(i, camera, i === 0 ? near : this.splits[i - 1] * 0.9, far, sun);
      near = far;
      if (key === this.keys[i] && this.seenVersion[i] === this.version) continue;
      // only one cascade per frame (round-robin) unless the first cascade is stale
      if (swapped && i > 0) continue;
      this.keys[i] = key;
      this.seenVersion[i] = this.version;
      if (!swapped) { swap(true); swapped = true; }
      // render targets use their own viewport/scissor (not the renderer's canvas viewport)
      this.rt.viewport.set(i * this.size, 0, this.size, this.size);
      this.rt.scissor.set(i * this.size, 0, this.size, this.size);
      this.rt.scissorTest = true;
      this.renderer.setRenderTarget(this.rt);
      this.renderer.clear(false, true, false);
      const bg = scene.background;
      scene.background = null;
      this.renderer.render(scene, this.cams[i]);
      scene.background = bg;
      // capture the matrix actually used for this cascade (projection may have been reversed by three)
      U.uShadowMatrix.value[i].multiplyMatrices(this.cams[i].projectionMatrix, this.cams[i].matrixWorldInverse);
    }
    void casters;
    if (swapped) swap(false);
    this.renderer.setRenderTarget(prev);
  }
}
