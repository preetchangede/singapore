import * as THREE from 'three';

// Global uniforms shared (by reference) across every material in the world.
// Updating `.value` here updates all materials at once.
export const U = {
  // atmosphere
  uRayleighScat: { value: new THREE.Vector3(5.802e-3, 13.558e-3, 33.1e-3) },
  uRayleighH: { value: 8.0 },
  uMieScat: { value: new THREE.Vector3(3.996e-3, 3.996e-3, 3.996e-3) },
  uMieExt: { value: new THREE.Vector3(4.44e-3, 4.44e-3, 4.44e-3) },
  uMieH: { value: 1.2 },
  uMieG: { value: 0.76 },
  uOzoneAbs: { value: new THREE.Vector3(0.65e-3, 1.881e-3, 0.085e-3) },
  uGroundAlbedo: { value: new THREE.Vector3(0.18, 0.2, 0.16) },
  tTransmittance: { value: null as THREE.Texture | null },
  tMultiScat: { value: null as THREE.Texture | null },
  tSkyView: { value: null as THREE.Texture | null },
  tAtmoParams: { value: null as THREE.Texture | null },
  tAerial: { value: null as THREE.Data3DTexture | null },
  uAerialMaxKm: { value: 150.0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  uMoonLight: { value: new THREE.Vector3(0, 0, 0) },
  uMoonPhase: { value: 0.5 },
  uCamAltKm: { value: 0.5 },
  uSunIntensity: { value: 16.0 },
  uNight: { value: 0.0 },
  uHaze: { value: 2.0 },
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector2(0.8, 0.3) },
  uExposure: { value: 1.12 },
  uCloudCover: { value: 0.4 },
  uCloudWind: { value: new THREE.Vector2(0, 0) },

  // terrain & ground
  tHeightNear: { value: null as THREE.Texture | null },
  tHeightFar: { value: null as THREE.Texture | null },
  tCoast: { value: null as THREE.Texture | null },
  tOverview: { value: null as THREE.Texture | null },
  tCanopy: { value: null as THREE.Texture | null },
  uDomainHalf: { value: 32768.0 },
  uFarHalf: { value: 131072.0 },
  uCoastMaxD: { value: 2000.0 },

  // ground clipmap (3 levels): centre xy + half size per level
  tClip0: { value: null as THREE.Texture | null },
  tClip1: { value: null as THREE.Texture | null },
  tClip2: { value: null as THREE.Texture | null },
  tClipM0: { value: null as THREE.Texture | null },
  tClipM1: { value: null as THREE.Texture | null },
  tClipM2: { value: null as THREE.Texture | null },
  uClipRect: { value: [new THREE.Vector4(0, 0, 1, 0), new THREE.Vector4(0, 0, 1, 0), new THREE.Vector4(0, 0, 1, 0)] },
  tNightLights: { value: null as THREE.Texture | null },
  uTreeRange: { value: 1800.0 },

  // shadows
  tShadow: { value: null as THREE.Texture | null },
  uShadowMatrix: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
  uShadowSplits: { value: new THREE.Vector4(200, 900, 3500, 0) },
  uShadowTexel: { value: new THREE.Vector3(1 / 2048, 1 / 2048, 1 / 2048) },
  uShadowOn: { value: 0.0 },
  uShadowReversed: { value: 0.0 },

  // water reflections
  tReflection: { value: null as THREE.Texture | null },
  uReflectionOn: { value: 0.0 },
  uReflMatrix: { value: new THREE.Matrix4() },
  uReflectPass: { value: 0.0 },
  uResolution: { value: new THREE.Vector2(1, 1) },

  // debug view switch (?dbg=N): 0 off, 1 no aerial, 2 no glass reflection, 3 albedo
  uDebug: { value: 0 },
};

export type Uniforms = typeof U;
