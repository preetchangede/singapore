import * as THREE from 'three';
import { U } from '../core/uniforms';

/**
 * Planar reflection about the sea-level plane (y = 0), rendered at reduced
 * resolution with a mirrored virtual camera (three's Reflector approach). Water
 * shaders sample it projectively through uReflMatrix, so no image flip is needed.
 */
export class Reflection {
  rt: THREE.WebGLRenderTarget;
  cam = new THREE.PerspectiveCamera();
  enabled = true;
  scale = 0.5;
  private bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

  constructor(private renderer: THREE.WebGLRenderer) {
    this.rt = new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    U.tReflection.value = this.rt.texture;
  }

  setSize(w: number, h: number) {
    this.rt.setSize(Math.max(16, Math.round(w * this.scale)), Math.max(16, Math.round(h * this.scale)));
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, hide: THREE.Object3D[], before: (c: THREE.PerspectiveCamera) => void, after: () => void) {
    if (!this.enabled || camera.position.y < 0.3) { U.uReflectionOn.value = 0; return; }
    const c = this.cam;
    c.fov = camera.fov; c.aspect = camera.aspect; c.near = camera.near; c.far = camera.far;
    c.updateProjectionMatrix();
    const p = camera.position;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const target = p.clone().add(fwd);
    c.position.set(p.x, -p.y, p.z);
    // mirror the up vector about the water plane (the projective lookup makes the roll irrelevant)
    c.up.set(camera.up.x, -camera.up.y, camera.up.z);
    c.lookAt(target.x, -target.y, target.z);
    c.updateMatrixWorld();
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => { o.visible = false; });
    U.uReflectPass.value = 1;
    before(c);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(scene, c);
    this.renderer.setRenderTarget(prev);
    after();
    U.uReflectPass.value = 0;
    hide.forEach((o, i) => { o.visible = vis[i]; });
    // projection used by three for this camera (may be reversed-Z) — only xy/w matter here
    U.uReflMatrix.value.copy(this.bias).multiply(c.projectionMatrix).multiply(c.matrixWorldInverse);
    U.uReflectionOn.value = 1;
  }
}
