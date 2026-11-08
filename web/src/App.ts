import * as THREE from 'three';
import { U } from './core/uniforms';
import { Post } from './core/Post';
import { CameraController, View } from './core/CameraController';
import { TimeOfDay } from './core/TimeOfDay';
import { Atmosphere } from './world/Atmosphere';
import { Terrain } from './world/Terrain';
import { Ocean } from './world/Ocean';
import { Sky } from './world/Sky';
import { TileManager } from './streaming/TileManager';
import { Clipmap } from './world/Clipmap';
import { buildingUniforms } from './world/Buildings';
import {
  Manifest, loadManifest, fetchGz, decodeHeights, heightTexture, byteTexture, loadImageTexture, HeightField,
} from './data/assets';

export interface LoadProgress { (fraction: number, label: string): void }

export class App {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controller: CameraController;
  time = new TimeOfDay();
  post: Post;
  atmosphere: Atmosphere;
  terrain!: Terrain;
  ocean!: Ocean;
  sky!: Sky;
  tiles!: TileManager;
  clipmap!: Clipmap;
  manifest!: Manifest;
  heights!: HeightField;
  hdr!: THREE.WebGLRenderTarget;
  pixelRatio = 1;
  renderScale = 1;
  private clock = new THREE.Clock();
  private frameHooks: ((dt: number) => void)[] = [];
  private beforeRender: ((dt: number) => void)[] = [];
  fps = 60;
  private frameTimes: number[] = [];
  running = false;

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false, depth: true,
      powerPreference: 'high-performance', reversedDepthBuffer: true, preserveDrawingBuffer: false,
    });
    this.renderer.autoClear = true;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 1);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2.0e6);
    this.controller = new CameraController(this.camera, canvas);
    this.post = new Post(this.renderer);
    this.atmosphere = new Atmosphere(this.renderer);
    this.atmosphere.setHaze(3.2, 2.0);
    this.atmosphere.bake();
    U.uShadowOn.value = 0;
    window.addEventListener('resize', () => this.resize());
  }

  get reversedDepth() { return this.renderer.capabilities.reversedDepthBuffer; }

  async load(progress: LoadProgress) {
    progress(0.02, 'Reading the map');
    this.manifest = await loadManifest();
    const m = this.manifest;
    const parts: { w: number; done: number }[] = [];
    const track = (w: number) => {
      const p = { w, done: 0 };
      parts.push(p);
      return (l: number, t: number) => {
        p.done = t ? l / t : 0;
        const tot = parts.reduce((s, x) => s + x.w, 0);
        const d = parts.reduce((s, x) => s + x.w * Math.min(1, x.done), 0);
        progress(0.05 + 0.85 * (d / Math.max(tot, 1)), 'Raising the island');
      };
    };
    const [near, far, coast, canopy, overview] = await Promise.all([
      fetchGz(m.terrain.near.file, track(2.5)),
      fetchGz(m.terrain.far.file, track(2.2)),
      fetchGz(m.terrain.coast.file, track(1.7)),
      fetchGz(m.terrain.canopy.file, track(3.7)),
      loadImageTexture(m.ground.overviewSmall),
    ]);
    progress(0.92, 'Painting the ground');
    const hn = decodeHeights(near, m.terrain.near.size, m.terrain.near.enc[0], m.terrain.near.enc[1]);
    const hf = decodeHeights(far, m.terrain.far.size, m.terrain.far.enc[0], m.terrain.far.enc[1]);
    this.heights = new HeightField(hn, m.terrain.near.size, m.terrain.near.half);
    const farField = new HeightField(hf, m.terrain.far.size, m.terrain.far.half);
    U.tHeightNear.value = heightTexture(hn, m.terrain.near.size);
    U.tHeightFar.value = heightTexture(hf, m.terrain.far.size);
    U.tCoast.value = byteTexture(coast, m.terrain.coast.size);
    U.tCanopy.value = byteTexture(canopy, m.terrain.canopy.size);
    U.tOverview.value = overview;
    U.uDomainHalf.value = m.terrain.near.half;
    U.uFarHalf.value = m.terrain.far.half;
    U.uCoastMaxD.value = m.terrain.coast.maxd;
    // placeholders until the clipmap / night lights exist
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    black.needsUpdate = true;
    for (const k of ['tClip0', 'tClip1', 'tClip2', 'tClipM0', 'tClipM1', 'tClipM2', 'tReflection', 'tNightLights', 'tShadow'] as const) {
      if (!U[k].value) U[k].value = black;
    }
    U.uShadowReversed.value = this.reversedDepth ? 1 : 0;
    // height lookup for the camera (world x,z -> pipeline x,y)
    const half = m.terrain.near.half;
    this.controller.heightAt = (x, z) => {
      const inside = Math.abs(x) < half && Math.abs(z) < half;
      const h = inside ? this.heights.sample(x, -z) : farField.sample(x, -z);
      return Math.max(h, 0);
    };
    this.sky = new Sky();
    this.terrain = new Terrain();
    this.ocean = new Ocean();
    this.scene.add(this.sky.mesh, this.terrain.mesh, this.ocean.mesh);
    this.tiles = new TileManager(m, hn);
    this.scene.add(this.tiles.group);
    this.clipmap = new Clipmap(this.renderer);
    this.tiles.onGround = (t) => this.clipmap.addTile(t);
    this.tiles.onGroundRemoved = (t) => this.clipmap.removeTile(t);
    progress(0.94, 'Raising the skyline');
    await this.tiles.loadOverview();
    // compile shaders up-front so the intro doesn't stutter
    this.resize();
    progress(0.97, 'Warming up');
    this.time.update(0);
    this.atmosphere.update(500);
    this.terrain.update(this.camera);
    this.renderer.compile(this.scene, this.camera);
    progress(1, 'Ready');
  }

  addFrameHook(f: (dt: number) => void) { this.frameHooks.push(f); }
  addBeforeRender(f: (dt: number) => void) { this.beforeRender.push(f); }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio * this.renderScale);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const bw = Math.max(1, Math.round(w * this.pixelRatio * this.renderScale));
    const bh = Math.max(1, Math.round(h * this.pixelRatio * this.renderScale));
    if (this.hdr) this.hdr.dispose();
    this.hdr = new THREE.WebGLRenderTarget(bw, bh, {
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, samples: 4,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this.post.setSize(bw, bh);
    U.uResolution.value.set(bw, bh);
  }

  setRenderScale(s: number) {
    if (Math.abs(s - this.renderScale) < 0.02) return;
    this.renderScale = s;
    this.resize();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this.frame();
    };
    requestAnimationFrame(loop);
  }

  frame(render = true) {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    U.uTime.value += dt;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    this.fps = this.frameTimes.length / this.frameTimes.reduce((a, b) => a + b, 0);
    this.time.update(dt);
    this.controller.update(dt);
    for (const f of this.frameHooks) f(dt);
    // near plane adapts to altitude for depth precision on non-reversed-Z devices
    const alt = Math.max(1, this.controller.altitude());
    this.camera.near = this.reversedDepth ? 0.5 : Math.min(Math.max(0.5, alt * 0.02), 50);
    this.camera.far = 2.0e6;
    this.camera.updateProjectionMatrix();
    this.atmosphere.update(this.camera.position.y);
    this.sky.update(this.camera);
    this.terrain.update(this.camera);
    this.tiles.update(this.camera, alt);
    buildingUniforms.uHour.value = this.time.hour;
    if (!render) return;
    this.clipmap.update(this.camera, alt, performance.now());
    for (const f of this.beforeRender) f(dt);
    this.renderer.setRenderTarget(this.hdr);
    this.renderer.render(this.scene, this.camera);
    this.post.render(this.hdr.texture);
  }

  flyTo(v: View, done?: () => void) { this.controller.flyTo(v, { done }); }

  /** Render until streaming has settled (used for deterministic captures). */
  async settle(maxMs = 60000) {
    const t0 = performance.now();
    let calm = 0;
    while (performance.now() - t0 < maxMs) {
      this.frame(false);
      const s = this.tiles.stats;
      await new Promise((r) => setTimeout(r, 40));
      if (s.inflight === 0 && (this.tiles as any).queue.length === 0) calm++; else calm = 0;
      if (calm >= 4) break;
    }
    this.frame();
  }
}
