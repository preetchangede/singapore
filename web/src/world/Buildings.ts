import * as THREE from 'three';
import { BUILDING_VS, BUILDING_FS } from '../shaders/building';
import { COMMON } from '../shaders/common';
import { U } from '../core/uniforms';
import type { SolidGeom } from '../workers/builder';

export const buildingUniforms = {
  uHour: { value: 12.0 },
  uHighlight: { value: 0.0 },
  uHighlightId: { value: -1.0 },
};

export function makeBuildingMaterial(overview = false) {
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: (overview ? '#define OVERVIEW\n' : '') + BUILDING_VS,
    fragmentShader: BUILDING_FS,
    uniforms: { ...U, ...buildingUniforms, ...(overview ? { uHideMask: { value: 0 } } : {}) },
    side: THREE.FrontSide,
  });
  return mat;
}

/** Depth-only material for the shadow pass (shared geometry layout). */
export function makeShadowMaterial(alphaCanopy = false) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      #ifdef OVERVIEW
      in float aTile;
      uniform int uHideMask;
      #endif
      void main() {
        #ifdef OVERVIEW
        int t = int(aTile + 0.5);
        if (((uHideMask >> t) & 1) == 1) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        #endif
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: COMMON + `out vec4 fragColor; void main() { fragColor = vec4(1.0); }`,
    side: THREE.DoubleSide,
    colorWrite: false,
    defines: alphaCanopy ? { CANOPY: 1 } : {},
  });
}

export function solidGeometry(g: SolidGeom, overview = false) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
  geo.setAttribute('aNormal', new THREE.BufferAttribute(g.normal, 4, true));
  geo.setAttribute('aFacade', new THREE.BufferAttribute(g.facade, 2));
  geo.setAttribute('aColor', new THREE.BufferAttribute(g.color, 4, true));
  geo.setAttribute('aInfo', new THREE.BufferAttribute(g.info, 4, false));
  if (overview) geo.setAttribute('aTile', new THREE.BufferAttribute(new Float32Array(g.bid), 1));
  geo.setIndex(new THREE.BufferAttribute(g.index, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
