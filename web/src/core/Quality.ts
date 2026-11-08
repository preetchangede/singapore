import * as THREE from 'three';

export interface Tier {
  name: 'low' | 'medium' | 'high' | 'ultra';
  dprCap: number;        // max device pixel ratio used
  scale: number;         // starting render scale (dynamic resolution moves below this)
  minScale: number;
  msaa: number;          // 0 => FXAA instead
  shadowSize: number;    // 0 => no shadows
  reflection: number;    // planar reflection resolution scale, 0 => off
  treeDensity: number;
  treeRange: number;
  detailRadius: number;
  clipRes: number;
}

export const TIERS: Record<Tier['name'], Tier> = {
  low: { name: 'low', dprCap: 1, scale: 0.8, minScale: 0.5, msaa: 0, shadowSize: 1024, reflection: 0, treeDensity: 0.45, treeRange: 1100, detailRadius: 1500, clipRes: 1024 },
  medium: { name: 'medium', dprCap: 1.25, scale: 0.9, minScale: 0.55, msaa: 0, shadowSize: 1536, reflection: 0.35, treeDensity: 0.7, treeRange: 1500, detailRadius: 2000, clipRes: 2048 },
  high: { name: 'high', dprCap: 1.5, scale: 1, minScale: 0.6, msaa: 4, shadowSize: 2048, reflection: 0.5, treeDensity: 1, treeRange: 1800, detailRadius: 2400, clipRes: 2048 },
  ultra: { name: 'ultra', dprCap: 2, scale: 1, minScale: 0.6, msaa: 4, shadowSize: 2048, reflection: 0.6, treeDensity: 1, treeRange: 2200, detailRadius: 2800, clipRes: 2048 },
};

/** Pick a starting tier from the GPU, device and screen. */
export function detectTier(renderer: THREE.WebGLRenderer): Tier {
  const forced = new URLSearchParams(location.search).get('quality') as Tier['name'] | null;
  if (forced && TIERS[forced]) return TIERS[forced];
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
  const ua = navigator.userAgent;
  const mobile = /Mobi|Android|iPhone|iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const px = window.screen.width * window.screen.height * Math.min(window.devicePixelRatio || 1, 2) ** 2;
  if (/swiftshader|llvmpipe|software|basic render/.test(gpu)) return TIERS.low;
  if (mobile) return /apple gpu|adreno \(tm\) 7|adreno 7|mali-g7[1-9]|immortalis/.test(gpu) ? TIERS.medium : TIERS.low;
  if (/nvidia|geforce|rtx|radeon rx|radeon pro|amd radeon(?! graphics)/.test(gpu)) return px > 9e6 ? TIERS.high : TIERS.ultra;
  if (/apple m[2-9]|apple m1 (pro|max|ultra)/.test(gpu)) return TIERS.high;
  if (/apple/.test(gpu)) return TIERS.high;
  if (/intel|iris|uhd|radeon graphics|vega/.test(gpu)) return TIERS.medium;
  return TIERS.high;
}

/**
 * Dynamic resolution: watches frame times and nudges the render scale so the
 * experience stays fluid; never goes above the tier's starting scale.
 */
export class Governor {
  private acc = 0;
  private n = 0;
  private cool = 0;
  scale: number;
  constructor(public tier: Tier, private apply: (scale: number) => void) {
    this.scale = tier.scale;
  }
  frame(dt: number) {
    if (dt <= 0 || dt > 0.5) return;
    this.acc += dt;
    this.n++;
    this.cool -= dt;
    if (this.acc < 1.5 || this.cool > 0) return;
    const ms = (this.acc / this.n) * 1000;
    this.acc = 0;
    this.n = 0;
    let s = this.scale;
    if (ms > 24) s -= 0.12;
    else if (ms > 19) s -= 0.06;
    else if (ms < 14.5) s += 0.05;
    s = Math.max(this.tier.minScale, Math.min(this.tier.scale, s));
    if (Math.abs(s - this.scale) > 0.01) {
      this.scale = s;
      this.apply(s);
      this.cool = 2.5;
    }
  }
}
