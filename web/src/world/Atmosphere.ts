import * as THREE from 'three';
import { COMMON } from '../shaders/common';
import { ATMO_PARAMS, TRANSMITTANCE_FS, MULTISCAT_FS, SKYVIEW_FS, ATMO_PARAMS_FS } from '../shaders/atmosphere';
import { U } from '../core/uniforms';

const FS_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function rt(w: number, h: number, type: THREE.TextureDataType = THREE.HalfFloatType) {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  t.texture.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Owns the atmosphere LUTs and keeps the global atmosphere uniforms up to date. */
export class Atmosphere {
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private transmittance = rt(256, 64);
  private multiScat = rt(32, 32);
  private skyView = rt(192, 108);
  private params: THREE.WebGLRenderTarget;
  private skyMat: THREE.ShaderMaterial;
  private paramsMat: THREE.ShaderMaterial;
  private dirty = true;
  private lastKey = '';

  constructor(private renderer: THREE.WebGLRenderer) {
    this.params = rt(8, 1, THREE.FloatType);
    this.params.texture.minFilter = THREE.NearestFilter;
    this.params.texture.magFilter = THREE.NearestFilter;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const mk = (fs: string, extra: Record<string, THREE.IUniform> = {}) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FS_VERT,
        fragmentShader: COMMON + ATMO_PARAMS + fs,
        uniforms: { ...U, ...extra },
        depthTest: false, depthWrite: false,
      });
    this.skyMat = mk(SKYVIEW_FS, {
      uViewHeight: { value: 6360.5 }, uSunCosZ: { value: 0.5 }, uMoonCosZ: { value: -0.5 }, uMoonLightViewCos: { value: 0 },
    });
    this.paramsMat = mk(ATMO_PARAMS_FS);
    U.tTransmittance.value = this.transmittance.texture;
    U.tMultiScat.value = this.multiScat.texture;
    U.tSkyView.value = this.skyView.texture;
    U.tAtmoParams.value = this.params.texture;
    this.bake(mk(TRANSMITTANCE_FS), mk(MULTISCAT_FS));
  }

  private draw(mat: THREE.Material, target: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  /** (Re)compute the static LUTs. Call after changing scattering coefficients. */
  bake(tMat?: THREE.ShaderMaterial, msMat?: THREE.ShaderMaterial) {
    const prev = this.renderer.getRenderTarget();
    if (tMat) this.draw(tMat, this.transmittance);
    if (msMat) this.draw(msMat, this.multiScat);
    this.renderer.setRenderTarget(prev);
    this.dirty = true;
  }

  setHaze(mieScale: number, groundHaze: number) {
    const s = 3.996e-3 * mieScale;
    const e = 4.44e-3 * mieScale;
    U.uMieScat.value.set(s, s, s);
    U.uMieExt.value.set(e, e, e);
    U.uHaze.value = groundHaze;
  }

  /** Per-frame update: sky-view LUT + ambient cube when sun or camera altitude changed. */
  update(cameraAltitudeM: number) {
    const altKm = Math.max(0.001, cameraAltitudeM * 0.001);
    U.uCamAltKm.value = altKm;
    const sd = U.uSunDir.value;
    const key = `${sd.x.toFixed(4)},${sd.y.toFixed(4)},${sd.z.toFixed(4)},${altKm.toFixed(3)},${U.uMieScat.value.x.toFixed(6)},${U.uHaze.value}`;
    if (key === this.lastKey && !this.dirty) return;
    this.lastKey = key;
    this.dirty = false;
    const prev = this.renderer.getRenderTarget();
    this.skyMat.uniforms.uViewHeight.value = 6360.0 + altKm;
    this.skyMat.uniforms.uSunCosZ.value = sd.y;
    this.draw(this.skyMat, this.skyView);
    this.draw(this.paramsMat, this.params);
    this.renderer.setRenderTarget(prev);
  }
}
